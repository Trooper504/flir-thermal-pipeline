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
* ``probe_capabilities()`` answers the "is it UVC after all?" question with evidence
  instead of assumption: the fourcc OpenCV negotiated, the USB interface class behind
  ``/dev/videoN`` (0x0e == USB Video Class), and the pixel formats / control list that
  ``v4l2-ctl`` advertises - including whether a node is a *metadata* node that opens and
  never streams. Exposed as ``GET /api/v1/stream/devices?capabilities=true``.
"""
import json
import os
import re
import shutil
import subprocess
import sys
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


# ---------------------------------------------------------------------------
# UVC capability inspection
#
# Hardware reality above is the project's *expectation*; this section exists so the
# collector can replace it with a measurement. One question decides the architecture:
# is there a USB Video Class interface, and what does it carry? An 8-bit viewfinder
# stream has no temperature meaning, while a 16-bit Y16 stream carries detector counts
# (still not degrees Celsius - a UVC stream has no Planck constants in it).
# ---------------------------------------------------------------------------
V4L2_TOOL_NAME = "v4l2-ctl"
V4L2_TOOL_ENV = "V4L2_CTL_PATH"
V4L2_TIMEOUT_SECONDS = 6.0

# Probes are diagnostics, so the read test is bounded by running it in a *separate process*: an
# OpenCV capture cannot be interrupted from inside the interpreter, and abandoning one in-process
# was tried and rejected - the capture is still used/released by the blocked call, which wedged
# the collector and then took the whole process down (observed with DirectShow). A child process
# makes ``subprocess`` free to kill it, and a crashing camera backend cannot reach the API. The
# timeout is generous because the child has to start a Python interpreter and import OpenCV.
READ_TEST_TIMEOUT_SECONDS = 20.0
DEFAULT_SCAN_BUDGET_SECONDS = 20.0

# Opening every candidate index is not free, and repeatedly opening and closing the same devices
# can wedge some camera stacks (observed on Windows: the third consecutive probe of the same host
# stopped answering, with no read test involved). A short guard makes a repeated probe idempotent,
# so a double-clicked button cannot hammer the device stack; ``fresh=True`` (``?fresh=true``)
# bypasses it when a genuinely new measurement is wanted.
CAPABILITY_CACHE_SECONDS = 10.0

# Sentinel returned by an index inspection that ran out of scan budget, so "no device here"
# and "we stopped looking" never get confused. The scan budget is deliberately *soft*: it stops
# starting new work, but an index already in progress cannot be interrupted (see above).
SCAN_TRUNCATED = object()

# Child program for the frame-read test. Kept dependency-free on purpose: standard library plus
# cv2 only, because it runs in its own interpreter with the collector's own virtualenv.
READ_TEST_SNIPPET = (
    "import json, sys\n"
    "import cv2\n"
    "index = int(sys.argv[1])\n"
    "name = sys.argv[2]\n"
    "flags = {'dshow': cv2.CAP_DSHOW, 'msmf': cv2.CAP_MSMF, 'v4l2': getattr(cv2, 'CAP_V4L2', 0),\n"
    "         'any': cv2.CAP_ANY}\n"
    "cap = cv2.VideoCapture(index, flags.get(name, cv2.CAP_ANY))\n"
    "result = {'opened': bool(cap.isOpened()), 'backend': name, 'index': index}\n"
    "if result['opened']:\n"
    "    ok, frame = cap.read()\n"
    "    result['ok'] = bool(ok)\n"
    "    result['shape'] = list(getattr(frame, 'shape', []) or [])\n"
    "    result['dtype'] = str(getattr(frame, 'dtype', ''))\n"
    "print(json.dumps(result))\n"
)

# V4L2 fourccs grouped by what they mean for this project. ``GREY`` is deliberately
# listed as 8-bit: V4L2_PIX_FMT_GREY is one byte per pixel, not detector counts. The
# DirectShow naming of the same 8-bit layouts (YUY2 and friends) is listed alongside them.
RADIOMETRIC_FOURCCS = ("Y16", "Y16_LE", "Y12", "Y14", "RAW16", "UY16")
VIEWFINDER_FOURCCS = ("YUYV", "YUY2", "UYVY", "MJPG", "JPEG", "RGB3", "BGR3", "RGB4", "BGR4",
                      "NV12", "NV21", "GREY", "Y8", "BA81", "H264", "MPG4",
                      "YV12", "I420", "IYUV", "YU12")
METADATA_FOURCCS = ("UVCH", "UVC")

PIXEL_CLASS_RADIOMETRIC = "radiometric-16-bit"
PIXEL_CLASS_VIEWFINDER = "8-bit-viewfinder"
PIXEL_CLASS_METADATA = "metadata-only"
PIXEL_CLASS_UNKNOWN = "unknown"

# Standard V4L2 control sections. Anything else in the control list is vendor-defined,
# which is exactly where UVC extension-unit (XU) commands such as shutter / FFC appear.
STANDARD_CONTROL_SECTIONS = (
    "user controls", "camera controls", "codec controls", "image source controls",
    "image processing controls", "video capture controls", "jpeg compression controls",
    "fm modulator controls", "fm radio modulator controls", "flash controls",
    "rf tuner controls", "mpeg compression controls", "vp8 controls", "vp9 controls",
    "stateless codec controls", "fwnode controls", "dv controls"
)

# Name shapes that hint at a shutter / flat-field / calibration command worth trying.
XU_NAME_PATTERN = re.compile(
    r"(shutter|ffc|nuc|non.?uniform|flat.?field|calib|trigger|radiometr|temperature|palette|thermal|recalib)"
)

USB_INTERFACE_CLASS_NAMES = {
    "01": "Audio", "02": "Communications", "03": "Human Interface", "05": "Physical",
    "06": "Still Imaging", "07": "Printer", "08": "Mass Storage", "09": "Hub",
    "0a": "CDC Data", "0b": "Smart Card", "0d": "Content Security", "0e": "Video (UVC)",
    "0f": "Personal Healthcare", "10": "Audio/Video", "dc": "Diagnostic", "e0": "Wireless",
    "ef": "Miscellaneous", "fe": "Application Specific", "ff": "Vendor Specific"
}

UVC_INTERFACE_SUBCLASS_NAMES = {
    "00": "Undefined", "01": "Video Control", "02": "Video Streaming",
    "03": "Video Interface Collection"
}


def decode_fourcc(value) -> str:
    """Decodes an OpenCV ``CAP_PROP_FOURCC`` number into its 4-character code.

    Backends pack the code little-endian into an integer, and some report 0 or a value
    that is not printable text at all; both are answered with ``""`` instead of control
    characters, so a caller can tell "no format reported" from a real format.
    """
    try:
        raw = int(value)
    except (TypeError, ValueError):
        return ""
    if raw <= 0:
        return ""
    code = "".join(chr((raw >> (8 * i)) & 0xFF) for i in range(4))
    return code.rstrip() if all(32 <= ord(ch) < 127 for ch in code) else ""


def normalize_fourcc(code) -> str:
    """Canonical lookup key for a fourcc: upper case, no padding, no punctuation."""
    return "".join(ch for ch in str(code or "").upper() if ch.isalnum() or ch == "_")


def classify_pixel_format(code) -> str:
    """Maps a fourcc to the only distinction that matters here: can it carry temperature?

    ``GREY`` is 8-bit, ``YUYV``/``MJPG`` are 8-bit-per-channel viewfinder formats, and
    only ``Y16``/``Y12``/``Y14``/``RAW16`` carry raw microbolometer counts. A format that
    is not recognised stays ``unknown`` rather than being guessed at.
    """
    key = normalize_fourcc(code)
    if not key:
        return PIXEL_CLASS_UNKNOWN
    if key in RADIOMETRIC_FOURCCS:
        return PIXEL_CLASS_RADIOMETRIC
    if key in METADATA_FOURCCS:
        return PIXEL_CLASS_METADATA
    if key in VIEWFINDER_FOURCCS:
        return PIXEL_CLASS_VIEWFINDER
    return PIXEL_CLASS_UNKNOWN


def find_v4l2_ctl():
    """Locates the ``v4l2-ctl`` binary (``V4L2_CTL_PATH`` override first), else None."""
    override = (os.getenv(V4L2_TOOL_ENV) or "").strip()
    if override and os.path.exists(override):
        return override
    return shutil.which(V4L2_TOOL_NAME)


def run_inspection_tool(args, timeout=V4L2_TIMEOUT_SECONDS) -> dict:
    """Runs an external inspection command without a shell. Never raises.

    A probe is diagnostic, so a missing binary, a slow device or a permission problem is
    returned as data for the caller to report - it must not take the API down.
    """
    try:
        completed = subprocess.run(
            args, shell=False, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": (completed.stdout or b"").decode(errors="replace"),
            "stderr": (completed.stderr or b"").decode(errors="replace").strip()
        }
    except FileNotFoundError as err:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": f"not found: {err}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "returncode": None, "stdout": "",
                "stderr": f"timed out after {timeout}s"}
    except Exception as err:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": str(err)}


def _read_sysfs_text(path) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def sysfs_node_for_index(index) -> str:
    """V4L2 maps capture index N to ``/dev/videoN``; the driver follows the same rule."""
    try:
        return f"/dev/video{int(index)}"
    except (TypeError, ValueError):
        return ""


def read_sysfs_usb_identity(node) -> dict:
    """Reads the USB identity behind a ``/dev/videoN`` node from sysfs.

    ``bInterfaceClass`` 0x0e *is* USB Video Class, so this is the descriptor-level answer
    to "is it UVC at all?": a composite instrument can mount as a disk and still carry no
    Video-class interface, and no product string changes that. Returns None off Linux or
    when the node has no sysfs entry.
    """
    if not node:
        return None
    link = os.path.join("/sys/class/video4linux", os.path.basename(str(node)), "device")
    if not os.path.exists(link):
        return None

    interface_dir = os.path.realpath(link)
    usb_dir = os.path.dirname(interface_dir)
    interface_class = _read_sysfs_text(os.path.join(interface_dir, "bInterfaceClass")).lower()
    interface_subclass = _read_sysfs_text(os.path.join(interface_dir, "bInterfaceSubClass")).lower()

    return {
        "node": str(node),
        "sysfsPath": interface_dir,
        "idVendor": _read_sysfs_text(os.path.join(usb_dir, "idVendor")),
        "idProduct": _read_sysfs_text(os.path.join(usb_dir, "idProduct")),
        "manufacturer": _read_sysfs_text(os.path.join(usb_dir, "manufacturer")),
        "product": _read_sysfs_text(os.path.join(usb_dir, "product")),
        "bInterfaceClass": interface_class,
        "bInterfaceClassName": USB_INTERFACE_CLASS_NAMES.get(interface_class, ""),
        "bInterfaceSubClass": interface_subclass,
        "bInterfaceSubClassName": (
            UVC_INTERFACE_SUBCLASS_NAMES.get(interface_subclass, "")
            if interface_class == "0e" else ""
        ),
        "isUsbVideoClass": interface_class == "0e"
    }


# ---------------------------------------------------------------------------
# Host camera-access policy
#
# An operating system can refuse a camera to a desktop app *without* failing the open: the capture
# is created, the read simply never returns. From inside OpenCV that is indistinguishable from
# wedged hardware, which is how a host with camera access switched off burns a whole read-test
# timeout and then looks like a broken camera. The policy is therefore read from the host's own
# consent store instead of from the device - free, and incapable of wedging anything.
# ---------------------------------------------------------------------------
WINDOWS_CAMERA_CONSENT_KEY = (
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"
)
WINDOWS_CAMERA_APP_KEY = "webcam"
# "Let desktop apps access your camera". OpenCV is a classic Win32 app, so this is the value that
# governs it, while the two parent values can deny the camera outright.
WINDOWS_DESKTOP_APPS_KEY = "NonPackaged"
CAMERA_ACCESS_DENIED = "Deny"


def host_camera_access() -> dict:
    """Reports the *host's* camera-access policy without opening a device.

    On Windows camera access is per-app policy (`Settings > Privacy & security > Camera`) and a
    denied policy presents exactly like broken hardware: ``cv2.VideoCapture`` opens, and no frame
    ever arrives. Three registry values decide it and a ``Deny`` at any level denies the stream, so
    all of them are reported rather than collapsed into one guess. ``blocked`` is only ever ``True``
    when a ``Deny`` was actually read; ``None`` means "could not tell", which is not a verdict.

    Off Windows - or if the registry cannot be read - the answer is ``checked: False``. This is a
    diagnostic, so it may never fail a probe.
    """
    access = {
        "platform": sys.platform,
        "checked": False,
        "desktopApps": None,       # HKCU .../webcam/NonPackaged - what OpenCV is subject to
        "userConsent": None,       # HKCU .../webcam            - "Let apps access your camera"
        "machineConsent": None,    # HKLM .../webcam            - machine-wide camera toggle
        "blocked": None,
        "source": None,
        "note": ""
    }
    if os.name != "nt":
        access["note"] = ("Per-app camera policy is Windows-only; on Linux check device "
                          "permissions instead (`ls -l /dev/video*` and membership of the video "
                          "group).")
        return access

    try:
        import winreg
    except Exception as err:                                    # pragma: no cover - Windows only
        access["note"] = f"camera consent could not be read: {err}"
        return access

    def read_consent(root, hive, subkey=""):
        path = "\\".join(
            part for part in (WINDOWS_CAMERA_CONSENT_KEY, WINDOWS_CAMERA_APP_KEY, subkey) if part
        )
        try:
            with winreg.OpenKey(root, path) as key:
                value, _ = winreg.QueryValueEx(key, "Value")
        except OSError:
            return None
        if isinstance(value, (bytes, bytearray)):
            value = value.decode(errors="replace")
        return {"hive": hive, "value": str(value).strip(), "source": f"{hive}\\{path}"}

    def value_of(entry):
        return (entry or {}).get("value")

    desktop = read_consent(winreg.HKEY_CURRENT_USER, "HKCU", WINDOWS_DESKTOP_APPS_KEY)
    user = read_consent(winreg.HKEY_CURRENT_USER, "HKCU")
    machine = read_consent(winreg.HKEY_LOCAL_MACHINE, "HKLM")
    read_any = any(entry is not None for entry in (desktop, user, machine))

    access.update({
        "checked": read_any,
        "desktopApps": value_of(desktop),
        "userConsent": value_of(user),
        "machineConsent": value_of(machine),
        "source": (desktop or user or machine or {}).get("source"),
        "blocked": (any(value_of(entry) == CAMERA_ACCESS_DENIED
                        for entry in (desktop, user, machine)) if read_any else None)
    })
    if access["blocked"]:
        access["note"] = ("Windows refuses camera access to desktop apps (Settings > Privacy & "
                          "security > Camera), and that refusal looks like broken hardware: the "
                          "open succeeds and no frame ever arrives.")
    elif read_any:
        access["note"] = ("Windows camera access is not denied for this user (policy evidence, "
                          "not a device measurement).")
    else:
        access["note"] = "No Windows camera consent entry was present to read."
    return access


def parse_v4l2_formats_ext(text) -> dict:
    """Parses ``v4l2-ctl -d NODE --list-formats-ext`` output.

    The ``Type:`` line is the part that catches a UVC *metadata* node: it opens happily and
    then never delivers a frame, which would otherwise stop the MJPEG route mid-stream.
    """
    capture_type = ""
    formats = []
    current = None

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lowered = line.lower()

        if lowered.startswith("type:"):
            capture_type = line.split(":", 1)[1].strip()
            continue

        if line.startswith("["):
            code = re.search(r"'([^']*)'", line)
            description = re.search(r"\(([^)]*)\)", line)
            current = {
                "fourcc": code.group(1).rstrip() if code else "",
                "description": description.group(1).strip() if description else "",
                "pixelClass": classify_pixel_format(code.group(1) if code else ""),
                "sizes": [],
                "frameRates": []
            }
            formats.append(current)
            continue

        if current is None:
            continue

        if lowered.startswith("size:"):
            size = re.search(r"(\d+x\d+)", line.split(":", 1)[1])
            if size and size.group(1) not in current["sizes"]:
                current["sizes"].append(size.group(1))
        elif lowered.startswith("interval:"):
            for fps in re.findall(r"\(([\d.]+) fps\)", line):
                if fps not in current["frameRates"]:
                    current["frameRates"].append(fps)

    classes = []
    for entry in formats:
        if entry["pixelClass"] not in classes:
            classes.append(entry["pixelClass"])

    return {
        "captureType": capture_type,
        "isMetadataNode": "metadata" in capture_type.lower(),
        "formats": formats,
        "pixelClasses": classes
    }


def parse_v4l2_controls(text) -> dict:
    """Parses ``v4l2-ctl -d NODE -l`` output into sections and individual controls.

    ``xuCandidates`` is a *heuristic* shortlist, not proof. UVC extension units (shutter /
    FFC / palette) surface as controls inside a section named after the vendor rather than
    in a standard V4L2 section, so those are flagged for a human to read before anything is
    wired to ``FLIR_TRIGGER_CMD``.
    """
    sections = []
    current = None

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        identifier = re.search(r"\b(0x[0-9a-fA-F]{6,8})\b", line)
        if not identifier:
            # A header is a bare section name: "User Controls", "FLIR Systems AB Controls".
            if not raw_line[:1].isspace() and line.lower().endswith("controls"):
                current = {
                    "name": line,
                    "vendor": line.strip().lower() not in STANDARD_CONTROL_SECTIONS,
                    "controls": []
                }
                sections.append(current)
            continue

        if current is None:
            current = {"name": "Unlabelled", "vendor": False, "controls": []}
            sections.append(current)

        name = line[:identifier.start()].strip()
        current["controls"].append({
            "name": name,
            "id": identifier.group(1).lower(),
            "detail": line[identifier.end():].strip(" :"),
            "vendorSection": current["vendor"],
            "xuCandidate": bool(current["vendor"] or XU_NAME_PATTERN.search(name.lower()))
        })

    return {
        "sections": sections,
        "xuCandidates": [ctrl for section in sections for ctrl in section["controls"]
                         if ctrl["xuCandidate"]],
        "vendorSections": [section["name"] for section in sections if section["vendor"]],
        "heuristic": (
            "Candidates are section- and name-based, not proof. The authoritative list is "
            "the control dump itself: a vendor-named section is where UVC XU units live."
        )
    }


def summarize_capabilities(devices, truncated=False, camera_access=None) -> dict:
    """Turns per-index evidence into the one verdict the UI needs to show.

    Verdicts are deliberately blunt: "no capture device" and "8-bit viewfinder" are both
    perfectly valid answers for this project, and neither is treated as a failure.

    ``camera_access`` is the host's own camera policy (see ``host_camera_access``). It is passed in
    because a host that refuses access and a device that has wedged produce identical evidence, and
    only the policy can tell the two apart.
    """
    entries = list(devices or [])
    uvc_present = any((entry.get("sysfs") or {}).get("isUsbVideoClass") for entry in entries)

    def v4l2_of(entry):
        return entry.get("v4l2") or {}

    def classes_of(entry):
        """Pixel classes from every source: v4l2-ctl when present, OpenCV's fourcc always.

        On Windows there is no v4l2-ctl, so the negotiated fourcc is the only evidence there
        is - leaving it out would report a plainly 8-bit device as "unclassified".
        """
        classes = list(v4l2_of(entry).get("pixelClasses") or [])
        opencv_class = entry.get("pixelClass")
        if opencv_class and opencv_class != PIXEL_CLASS_UNKNOWN and opencv_class not in classes:
            classes.append(opencv_class)
        return classes

    def is_metadata(entry):
        return bool(v4l2_of(entry).get("isMetadataNode")) or classes_of(entry) == [PIXEL_CLASS_METADATA]

    radiometric = [e for e in entries if PIXEL_CLASS_RADIOMETRIC in classes_of(e)]
    viewfinder = [e for e in entries if PIXEL_CLASS_VIEWFINDER in classes_of(e)]
    metadata_only = [e for e in entries if is_metadata(e)]
    has_image_classes = any(set(classes_of(e)) - {PIXEL_CLASS_METADATA} for e in entries)

    if not entries:
        verdict = "no-capture-device"
        meaning = "No video capture index opened, so nothing is bound to the MJPEG route."
    elif radiometric:
        verdict = "scenario-b-radiometric-y16"
        meaning = ("A capture node advertises a 16-bit radiometric format (Y16-class): real "
                   "detector counts frame by frame, still not degrees Celsius on their own.")
    elif viewfinder:
        verdict = "scenario-a-8-bit-viewfinder"
        meaning = ("A capture node offers only 8-bit viewfinder formats (YUYV/MJPG/GREY-class): "
                   "a genuine live picture with no temperature meaning.")
    elif metadata_only and not has_image_classes:
        verdict = "metadata-nodes-only"
        meaning = "Only UVC metadata nodes opened: they carry payload descriptors, not images."
    else:
        verdict = "capture-device-unclassified"
        meaning = "A capture node opened but reported no pixel format, so it cannot be classified."

    notes = []
    if not uvc_present and entries:
        notes.append("No USB Video Class interface (bInterfaceClass 0x0e) was found behind the "
                     "open nodes, so these are not UVC capture paths.")
    if verdict == "scenario-b-radiometric-y16":
        notes.append("Detector counts are not temperatures: a UVC stream carries no Planck "
                     "R1/B/F/O, emissivity, distance or atmospheric terms. Read those from a "
                     "radiometric capture through the existing ExifTool path before treating "
                     "live values as calibrated.")
    if verdict == "scenario-a-8-bit-viewfinder":
        notes.append("Keep album ingestion and radiometric polling as the measurement path; "
                     "treat this stream as framing only.")
    if verdict == "no-capture-device":
        notes.append("Consistent with the E8-XT exposing USB mass storage only. Radiometric "
                     "polling of /api/v1/thermal-frame remains a real 9 Hz thermal feed with no "
                     "video hardware attached.")
    if verdict == "metadata-nodes-only":
        notes.append("Point the stream at a capture index instead; a metadata node opens but "
                     "never delivers a frame.")
    if entries and not any(v4l2_of(e).get("available") for e in entries):
        if sys.platform.startswith("linux"):
            notes.append("Advertised pixel formats are unknown because v4l2-ctl was not available "
                         "(install v4l-utils: `sudo apt install v4l-utils`).")
        # Off Linux there is no v4l2-ctl at all, so the platform note below carries that instead.
    # A host that denies camera access and a device that never answers look the same from here, so
    # the policy is named when it is the explanation rather than letting the verdict imply hardware.
    access = camera_access or {}
    if access.get("blocked"):
        stalled = [entry["index"] for entry in entries
                   if (entry.get("frameTest") or {}).get("tested")
                   and (entry.get("frameTest") or {}).get("ok") is None]
        detail = (f" Index(es) {stalled} opened and then never answered, which is exactly that "
                  f"refusal - grant access and re-probe with ?fresh=true before calling the "
                  f"hardware faulty." if stalled else "")
        notes.append("This host denies camera access to desktop apps (Windows Settings > Privacy & "
                     "security > Camera): the open succeeds and no frame ever arrives." + detail)
    if truncated:
        notes.append("The scan stopped at the time budget before every index was inspected; "
                     "pass ?max_index=N (or ?budget_seconds=N) to look further.")
    if sys.platform == "win32":
        notes.append("sysfs and v4l2-ctl are Linux-only: on Windows check Device Manager for a "
                     "\"Cameras\" node, or run `Get-PnpDevice -Class Camera,Image`.")

    return {
        "verdict": verdict,
        "meaning": meaning,
        "uvcInterfacePresent": uvc_present,
        "captureDeviceCount": len(entries),
        "metadataNodeCount": len(metadata_only),
        "radiometricIndexes": sorted({e["index"] for e in radiometric}),
        "viewfinderIndexes": sorted({e["index"] for e in viewfinder}),
        "notes": notes
    }


def process_frame_test(index, backend_name, timeout=READ_TEST_TIMEOUT_SECONDS) -> dict:
    """Reads one frame in a *child process* so a wedged backend can be killed for real.

    In-process abandonment was tried first and rejected: an OpenCV capture cannot be interrupted,
    and releasing it from elsewhere while the blocked call still uses it wedged the collector and
    then brought the process down (DirectShow). Here the read runs in its own interpreter, so
    ``subprocess`` kills it on timeout, a crashing camera backend cannot reach the API, and no
    device handle leaks into the collector. On timeout the result is ``ok: None`` - evidence was
    not obtained, which is not the same as a failed device.
    """
    try:
        completed = subprocess.run(
            [sys.executable, "-c", READ_TEST_SNIPPET, str(int(index)), str(backend_name)],
            shell=False, timeout=max(1.0, float(timeout)),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except subprocess.TimeoutExpired:
        return {"ok": None, "reason": f"no frame within {timeout}s - the reader process was killed "
                                      f"(device wedged, busy or a UVC metadata node)"}
    except Exception as err:
        return {"ok": False, "reason": f"could not start the reader process: {err}"}

    if completed.returncode != 0:
        stderr = (completed.stderr or b"").decode(errors="replace").strip().splitlines()
        return {"ok": False, "reason": stderr[-1][:300] if stderr
                else f"reader process exited with {completed.returncode}"}

    # OpenCV prints warnings to stderr, so only stdout is parsed - and tolerantly, because a
    # backend may add noise of its own.
    payload = None
    for line in reversed((completed.stdout or b"").decode(errors="replace").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            candidate = json.loads(line)
        except ValueError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if payload is None:
        return {"ok": False, "reason": "reader process produced no readable result"}

    if not payload.get("opened"):
        return {"ok": False, "reason": "device did not open in the reader process"}

    ok = bool(payload.get("ok"))
    shape = list(payload.get("shape") or [])
    dtype = str(payload.get("dtype") or "")
    if not ok or not shape:
        return {"ok": False, "shape": shape, "dtype": dtype,
                "reason": "opened but returned no frame - a UVC metadata node behaves this way"}

    result = {"ok": True, "reason": "", "shape": shape, "dtype": dtype}

    # The child reports what it was handed, so a 16-bit frame here means detector counts arrived
    # unfiltered. Reported, never assumed.
    channels = shape[-1] if len(shape) == 3 else 1
    if channels == 1 and dtype in ("uint16", "int16", "float32", "float64"):
        result["rawDepthHint"] = (
            "single-channel non-8-bit frame: raw detector counts are arriving unfiltered, "
            "which is Y16-like - apply Planck calibration before calling it a temperature")
    return result


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
        self._capability_cache = None           # last probe, so a double-click is idempotent
        self._host_access = None                # camera policy read by the last capability probe
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

    # ---------------- capability probe ----------------
    def _inspect_v4l2(self, node) -> dict:
        """Asks v4l2-ctl which formats and controls a node advertises (Linux only).

        Every failure is reported as data: a missing v4l-utils package, a metadata node that
        rejects ``-l``, or a device that does not answer within the timeout all leave the
        rest of the probe intact.
        """
        tool = find_v4l2_ctl()
        if not node:
            return {"available": False, "tool": tool,
                    "reason": "no /dev/videoN node on this platform"}
        if not tool:
            return {"available": False, "tool": None,
                    "reason": "v4l2-ctl not found - install v4l-utils (`sudo apt install v4l-utils`)"}

        formats_result = run_inspection_tool([tool, "-d", node, "--list-formats-ext"])
        controls_result = run_inspection_tool([tool, "-d", node, "-l"])
        parsed_formats = parse_v4l2_formats_ext(formats_result["stdout"])
        parsed_controls = parse_v4l2_controls(controls_result["stdout"])

        return {
            "available": True,
            "tool": tool,
            "captureType": parsed_formats["captureType"],
            "isMetadataNode": parsed_formats["isMetadataNode"],
            "formats": parsed_formats["formats"],
            "pixelClasses": parsed_formats["pixelClasses"],
            "controls": parsed_controls,
            "errors": [msg for msg in (formats_result["stderr"], controls_result["stderr"]) if msg]
        }

    def _frame_test(self, index, backend_name, read_test) -> dict:
        """Decides whether to run the frame-read test, and reports its provenance.

        The read itself happens in a child process (see ``process_frame_test``). It stays opt-in
        because it is the only part of the probe that touches the stream, and it is skipped when a
        live MJPEG stream already owns that index.
        """
        if not read_test:
            return {"tested": False, "ok": None,
                    "reason": "not requested (?read_test=true reads one frame per index)"}

        active = self._active or {}
        if self._capture is not None and active.get("index") == index:
            return {"tested": False, "ok": None,
                    "reason": "device is already owned by the live stream"}

        outcome = process_frame_test(index, backend_name)
        if outcome.get("ok") is None:
            # "nothing arrived within the timeout" has two possible causes that look identical from
            # in here, so the host policy is named whenever it is the real one.
            access = self._host_access if self._host_access is not None else host_camera_access()
            if access.get("blocked"):
                outcome = {**outcome, "reason": (
                    f"{outcome.get('reason', '')} - and this host denies camera access to desktop "
                    f"apps (Windows privacy settings), which produces exactly this timeout")}
        return {"tested": True, **outcome}

    def _describe_index(self, index, read_test=False):
        """Opens one index, describes it, releases it, and returns the entry (or None).

        Nothing here can be interrupted from outside, which is why nothing here is abandoned:
        the frame-read test (the only part that can genuinely block) runs in a child process
        after this capture has been released.
        """
        node = "" if os.name == "nt" else sysfs_node_for_index(index)

        for name, flag in available_backends():
            cap = None
            try:
                cap = cv2.VideoCapture(index, flag)
                if not cap.isOpened():
                    continue

                raw_fourcc = int(cap.get(cv2.CAP_PROP_FOURCC) or 0)
                fourcc = decode_fourcc(raw_fourcc)
                entry = {
                    "index": index,
                    "backend": name,
                    "opened": True,
                    "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
                    "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                    "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or 0.0), 2),
                    "fourcc": fourcc or None,
                    "fourccRaw": raw_fourcc,
                    "pixelClass": classify_pixel_format(fourcc),
                    "node": node,
                    "sysfs": read_sysfs_usb_identity(node),
                    "v4l2": self._inspect_v4l2(node)
                }
            except Exception as err:
                # A backend that raises is reported as an unopened entry, never as a crash.
                return {
                    "index": index, "backend": name, "opened": False, "error": str(err),
                    "width": 0, "height": 0, "fps": 0.0, "fourcc": None, "fourccRaw": 0,
                    "pixelClass": PIXEL_CLASS_UNKNOWN, "node": node,
                    "sysfs": read_sysfs_usb_identity(node), "v4l2": self._inspect_v4l2(node),
                    "frameTest": {"tested": False, "ok": None, "reason": str(err)}
                }
            finally:
                if cap is not None:
                    cap.release()

            # The capture is closed before the reader process opens the same device: two openers
            # on one DirectShow device is exactly the contention that made the in-process version
            # of this test unsafe.
            entry["frameTest"] = self._frame_test(index, name, read_test)
            return entry

        return None

    def _inspect_index(self, index, read_test=False, deadline=None):
        """Runs one index inspection, or ``SCAN_TRUNCATED`` when the scan budget is spent."""
        if deadline is not None and time.time() > deadline:
            return SCAN_TRUNCATED
        return self._describe_index(index, read_test)

    def probe_capabilities(self, max_index=None, read_test=False, budget_seconds=None,
                           fresh=False) -> dict:
        """Reports which video interfaces this host really has, and what they carry.

        Three independent sources, so the verdict does not rest on a single API:
          1. OpenCV   - which indexes open, with resolution / frame rate / fourcc,
          2. sysfs    - the USB interface class behind ``/dev/videoN`` (0x0e == Video Class),
          3. v4l2-ctl - every advertised pixel format, whether the node is a *metadata* node,
                        and the full control list (a vendor section is where UVC XU lives).

        A fourth source needs no device at all: the host's own camera-access policy
        (``host_camera_access``), because an operating system that refuses a camera to desktop apps
        does it in a way that is indistinguishable from broken hardware - the open succeeds and no
        frame ever arrives.

        ``read_test=True`` additionally reads one frame per index, in a child process that
        ``subprocess`` can kill if the device wedges (see ``process_frame_test``). The sweep itself
        is bounded by ``budget_seconds`` (default ``DEFAULT_SCAN_BUDGET_SECONDS``), because opening
        every candidate index on every backend is genuinely slow on some platforms. Repeating the
        same probe within ``CAPABILITY_CACHE_SECONDS`` answers from the previous result (marked
        ``cached: True``) unless ``fresh=True``: probing is the one thing here that can disturb the
        device stack, so it should not be done twice by accident.
        """
        limit = max(1, int(max_index or self.probe_limit))
        budget = float(budget_seconds) if budget_seconds and float(budget_seconds) > 0 \
            else DEFAULT_SCAN_BUDGET_SECONDS
        key = (limit, bool(read_test), budget)

        cached = self._capability_cache
        if not fresh and cached and cached["key"] == key:
            age = time.time() - cached["at"]
            if age < CAPABILITY_CACHE_SECONDS:
                payload = dict(cached["payload"])
                payload["cached"] = True
                payload["cacheAgeSeconds"] = round(age, 2)
                payload["cacheSeconds"] = CAPABILITY_CACHE_SECONDS
                return payload

        deadline = time.time() + budget
        started = time.time()
        # Read once per sweep: the policy belongs to the host, not to an individual index, and
        # reading it touches no device.
        access = host_camera_access()
        self._host_access = access

        devices = []
        truncated = False
        for index in range(limit):
            if time.time() > deadline:
                truncated = True
                break
            entry = self._inspect_index(index, read_test=read_test, deadline=deadline)
            if entry is SCAN_TRUNCATED:
                truncated = True
                break
            if entry is not None:
                devices.append(entry)

        result = {
            "platform": sys.platform,
            "hostCameraAccess": access,
            "probeLimit": limit,
            "readTest": bool(read_test),
            "v4l2Tool": find_v4l2_ctl(),
            "scanBudgetSeconds": budget,
            "scanSeconds": round(time.time() - started, 2),
            "scanTruncated": truncated,
            "cached": False,
            "devices": devices,
            "summary": summarize_capabilities(devices, truncated=truncated, camera_access=access)
        }
        self._capability_cache = {"key": key, "at": time.time(), "payload": result}
        return result

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
