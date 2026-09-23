# edge_collector/live_stream_driver.py
"""Live viewfinder streaming + snapshot coordination for the FLIR E8-XT workstation.

HARDWARE REALITY (read before demoing)
--------------------------------------
* The FLIR E-series (E4 .. E8-XT) is a *mass-storage* instrument. It does not present a
  UVC / DirectShow / V4L2 video interface, so ``cv2.VideoCapture()`` will not enumerate
  it. On a typical dev workstation the only capture device is the built-in webcam, and
  binding index 0 would therefore stream *your laptop camera*, not thermal imagery.
* Live view from these cameras is reachable only through FLIR's own paths (composite
  video out where fitted, or FLIR software over Wi-Fi/USB), none of which OpenCV opens.
* The shutter / NUC trigger cannot be commanded over USB mass storage either, and
  unbinding the USB storage interface (uhubctl / sysfs) would merely power-cycle the SD
  reader that album ingestion depends on - it cannot fire a shutter.

Consequences for this module:
* Real MJPEG plumbing is implemented, but device selection is *explicit* (``FLIR_VIDEO_INDEX``
  env var, the ``index=`` / ``backend=`` query params, or the UI picker) and every
  response states which device was locked.
* When no suitable device exists, ``/api/v1/stream/live-mjpeg`` answers HTTP 503 and the
  webapp falls back to radiometric polling of ``/api/v1/thermal-frame`` - real thermal
  data at 9 Hz with no video hardware required.
* ``coordinate_snapshot()`` performs a safe software capture and can additionally run an
  external trigger command (``FLIR_TRIGGER_CMD``) for a lab that has wired a hardware
  trigger to the camera; it never touches USB power or sysfs.
"""
import os
import subprocess
import threading
import time

import cv2
import numpy as np

DEFAULT_TARGET_FPS = 9.0          # E8-XT frame rate
DEFAULT_JPEG_QUALITY = 80
DEFAULT_PROBE_LIMIT = 5
MAX_LOOKUP_SECONDS = 30.0


def available_backends() -> list:
    """OpenCV capture backends worth trying, in preference order for this platform."""
    backends = []
    if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
        backends.append(("dshow", cv2.CAP_DSHOW))
    if hasattr(cv2, "CAP_V4L2") and hasattr(os, "uname"):
        backends.append(("v4l2", cv2.CAP_V4L2))
    if hasattr(cv2, "CAP_MSMF") and os.name == "nt":
        backends.append(("msmf", cv2.CAP_MSMF))
    backends.append(("any", cv2.CAP_ANY))
    return backends


class LiveStreamDriver:
    """Bounded, single-viewer MJPEG reader around an explicitly chosen capture device."""

    def __init__(self, target_fps=DEFAULT_TARGET_FPS, jpeg_quality=DEFAULT_JPEG_QUALITY,
                 preferred_index=None, preferred_backend=None, probe_limit=DEFAULT_PROBE_LIMIT):
        self.target_fps = max(1.0, float(target_fps))
        self.jpeg_quality = int(jpeg_quality)
        self.probe_limit = max(1, int(probe_limit))
        self.preferred_index = self._env_int("FLIR_VIDEO_INDEX", preferred_index)
        self.preferred_backend = (os.getenv("FLIR_VIDEO_BACKEND") or preferred_backend or "").strip().lower()

        self._capture = None
        self._active = None                     # {index, backend, width, height, fps}
        self._lock = threading.Lock()           # guards device open/close
        self._streaming = threading.Event()     # one MJPEG consumer at a time
        self.frames_served = 0

    @staticmethod
    def _env_int(name, fallback):
        raw = os.getenv(name)
        if raw is None or not str(raw).strip():
            return fallback
        try:
            return int(str(raw).strip())
        except ValueError:
            return fallback

    # ---------------- device discovery ----------------
    def probe_devices(self, max_index=None) -> list:
        """Reports every capture index that opens, with the backend that opened it.

        Only ``isOpened()``/reported properties are queried - no frames are read, so
        probing cannot capture imagery from an unrelated device.
        """
        limit = max(1, int(max_index or self.probe_limit))
        found = []

        for index in range(limit):
            for name, flag in available_backends():
                cap = None
                try:
                    cap = cv2.VideoCapture(index, flag)
                    if not cap.isOpened():
                        continue
                    found.append({
                        "index": index,
                        "backend": name,
                        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
                        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                        "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or 0.0), 2),
                        "selected": False
                    })
                    break
                except Exception:
                    continue
                finally:
                    if cap is not None:
                        cap.release()

        return found

    def _open(self, index, backend_name) -> bool:
        flags = dict(available_backends())
        flag = flags.get(backend_name, cv2.CAP_ANY)
        cap = cv2.VideoCapture(index, flag)
        if not cap.isOpened():
            cap.release()
            return False

        self._capture = cap
        self._active = {
            "index": index,
            "backend": backend_name,
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
            "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or self.target_fps), 2)
        }
        return True

    def open_device(self, index=None, backend=None):
        """Locks a device. Returns the active device dict, or None when nothing opens."""
        with self._lock:
            if self._capture is not None:
                return self._active

            wanted_index = self.preferred_index if index is None or int(index) < 0 else int(index)
            wanted_backend = (backend or self.preferred_backend or "").strip().lower()

            attempts = []
            if wanted_index is not None:
                attempts.append((wanted_index, wanted_backend or "any"))
            else:
                for entry in self.probe_devices():
                    attempts.append((entry["index"], entry["backend"]))

            for attempt_index, attempt_backend in attempts:
                backends = [attempt_backend] if attempt_backend else [name for name, _ in available_backends()]
                for name in backends:
                    if name not in dict(available_backends()):
                        continue
                    if self._open(attempt_index, name):
                        return self._active
            return None

    @property
    def active_device(self):
        return self._active

    def close(self):
        with self._lock:
            if self._capture is not None:
                self._capture.release()
            self._capture = None
            self._active = None

    def status(self) -> dict:
        return {
            "device": self._active,
            "streaming": self._streaming.is_set(),
            "frames_served": self.frames_served,
            "target_fps": self.target_fps,
            "jpeg_quality": self.jpeg_quality,
            "backends_available": [name for name, _ in available_backends()],
            "preferred_index": self.preferred_index,
            "preferred_backend": self.preferred_backend or None
        }

    # ---------------- MJPEG streaming ----------------
    def mjpeg_generator(self, boundary=b"frame", max_frames=None):
        """Yields multipart/x-mixed-replace chunks at the configured frame rate.

        A single viewer owns the device at a time; a second concurrent request gets an
        empty stream rather than fighting over the capture handle.
        """
        if self._streaming.is_set():
            return
        self._streaming.set()

        try:
            if self.open_device() is None:
                return

            interval = 1.0 / self.target_fps
            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality]
            sent = 0

            while max_frames is None or sent < max_frames:
                started = time.time()

                with self._lock:
                    if self._capture is None:
                        break
                    ok, frame = self._capture.read()

                if not ok or frame is None:
                    print("[WARN] Live stream frame read failed; stopping stream.")
                    break

                ok, buffer = cv2.imencode(".jpg", frame, encode_params)
                if not ok:
                    continue

                payload = buffer.tobytes()
                yield (
                    b"--" + boundary + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n"
                    + payload + b"\r\n"
                )
                sent += 1
                self.frames_served += 1

                elapsed = time.time() - started
                if elapsed < interval:
                    time.sleep(interval - elapsed)
        finally:
            self._streaming.clear()

    def grab_preview_jpeg(self):
        """Single JPEG frame for a non-streaming preview / diagnostics call."""
        if self.open_device() is None:
            return None
        with self._lock:
            if self._capture is None:
                return None
            ok, frame = self._capture.read()
        if not ok or frame is None:
            return None
        ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality])
        return buffer.tobytes() if ok else None


def normalize_frame(result) -> dict:
    """Normalises a driver capture into the standard {name, mtime, width, height, data}.

    RealFlirCamera returns that dict, while MockFlirCamera returns a bare ndarray, and
    the trigger endpoint must not care which driver it is talking to.
    """
    if isinstance(result, dict):
        matrix = np.asarray(result["data"], dtype=np.float32)
        frame = dict(result)
        frame.setdefault("name", "live_capture.jpg")
        frame.setdefault("mtime", time.time())
        frame["width"] = int(matrix.shape[1])
        frame["height"] = int(matrix.shape[0])
        return frame

    matrix = np.asarray(result, dtype=np.float32)
    return {
        "name": f"mock_{time.strftime('%H%M%S', time.gmtime())}.jpg",
        "mtime": time.time(),
        "width": int(matrix.shape[1]),
        "height": int(matrix.shape[0]),
        "data": matrix.tolist()
    }


def coordinate_snapshot(camera, wait_seconds=4.0, external_command=None) -> dict:
    """Captures a fresh radiometric frame and returns it with provenance.

    Order of operations:
      1. record the captures already on the card,
      2. optionally run ``external_command`` (``FLIR_TRIGGER_CMD``) - the hook for a lab
         that has wired a hardware trigger to the camera; it is never run unless the
         operator configured it, and nothing here touches USB power or sysfs,
      3. wait (bounded) for the camera to write a new file,
      4. extract the newest sane frame through the normal radiometric pipeline.

    Without an external trigger this is a software snapshot: it synchronises with the
    card and returns whatever the camera wrote last, which is what a shutter press on
    the instrument would have produced.
    """
    # Drivers without album listing (e.g. MockFlirCamera) cannot report new files, so the
    # wait phase is skipped rather than failing the request.
    list_files = getattr(camera, "get_all_images", None)
    can_list_files = callable(list_files)
    before = {os.path.basename(p) for p in list_files()} if can_list_files else set()

    command = external_command if external_command is not None else os.getenv("FLIR_TRIGGER_CMD", "").strip()
    triggered = False
    trigger_error = None

    if command:
        try:
            completed = subprocess.run(command, shell=True, timeout=MAX_LOOKUP_SECONDS,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            triggered = completed.returncode == 0
            if not triggered:
                trigger_error = (completed.stderr or b"").decode(errors="replace").strip() or "non-zero exit"
        except Exception as err:
            trigger_error = str(err)

    timeout = max(0.0, min(MAX_LOOKUP_SECONDS, float(wait_seconds)))
    deadline = time.time() + timeout
    new_files = []

    if can_list_files:
        while time.time() < deadline:
            current = camera.get_all_images()
            new_files = [p for p in current if os.path.basename(p) not in before]
            if new_files:
                break
            time.sleep(0.4)

    frame = normalize_frame(camera.capture_radiometric_matrix())

    return {
        "trigger": "hardware" if triggered else "software",
        "externalCommand": command or None,
        "externalCommandError": trigger_error,
        "newFilesDetected": [os.path.basename(p) for p in new_files],
        "newFileDetection": "supported" if can_list_files else "unavailable for this driver (no album listing)",
        "waitedSeconds": round(timeout, 2) if can_list_files else 0.0,
        "frame": frame
    }
