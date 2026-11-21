# edge_collector/flir_hardware.py
import glob
import io
import json
import os
import re
import subprocess
import numpy as np
from PIL import Image

# Physical validity window (°C): wider than the E8-XT spec (-20..550) to keep hot lab
# targets, narrow enough to reject foreign or corrupted captures.
MIN_VALID_TEMP_C = -50.0
MAX_VALID_TEMP_C = 1000.0

# How many of the newest captures to probe when resolving the live frame.
LIVE_FRAME_LOOKBACK = 3

# Default mount point for the camera's SD card (Raspberry Pi OS: /media/<user>/...);
# FLIR_MOUNT_PATH overrides it.
DEFAULT_CAMERA_MOUNT_PATH = "/media/raspberrypi_local/07F5-01A9/DCIM/100_FLIR"


class FlirExtractorNative:
    """Native FLIR thermal extractor using ExifTool."""

    def __init__(self, exiftool_path="exiftool"):
        self.exiftool_path = exiftool_path

    def _clean_float(self, val, default: float) -> float:
        if val is None:
            return default
        if isinstance(val, (int, float)):
            return float(val)
        cleaned = re.sub(r"[^\d.-]", "", str(val))
        try:
            return float(cleaned)
        except ValueError:
            return default

    def get_metadata(self, image_path: str) -> dict:
        cmd = [self.exiftool_path, "-j", "-n", "-Flir:all", image_path]
        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(f"ExifTool execution failed: {result.stderr}")
        return json.loads(result.stdout)[0]

    def _compute_tau_atm(
        self, distance: float, humidity: float, temp_atm_c: float
    ) -> float:
        """Calculates atmospheric transmittance according to FLIR standards."""
        alpha1, alpha2 = 0.006569, 0.01262
        beta1, beta2 = -0.002276, -0.00667
        X = 1.9

        p_sat = 6.1078 * (10 ** ((7.5 * temp_atm_c) / (237.3 + temp_atm_c)))
        p_h2o = (humidity / 100.0) * p_sat

        sqrt_d = np.sqrt(max(0.1, distance))
        h2o_term = np.sqrt(max(0.01, p_h2o))
        tau = X * np.exp(
            -sqrt_d * (alpha1 + beta1 * h2o_term)
        ) + (1.0 - X) * np.exp(-sqrt_d * (alpha2 + beta2 * h2o_term))
        return float(np.clip(tau, 0.1, 1.0))

    def _assert_physical_range(self, temp_celsius: np.ndarray, image_path: str) -> None:
        """Rejects non-radiometric or corrupted payloads before clients ingest them."""
        if np.isnan(temp_celsius).any():
            raise ValueError(
                f"Non-radiometric or corrupted payload in {image_path}: "
                "matrix contains NaN values."
            )

        t_min = float(temp_celsius.min())
        t_max = float(temp_celsius.max())
        if t_min < MIN_VALID_TEMP_C or t_max > MAX_VALID_TEMP_C:
            raise ValueError(
                f"Non-radiometric or corrupted payload in {image_path}: "
                f"Range [{t_min}, {t_max}] °C outside physical limits "
                f"[{MIN_VALID_TEMP_C}, {MAX_VALID_TEMP_C}] °C."
            )

    def extract_thermal_matrix(self, image_path: str) -> np.ndarray:
        """Converts a radiometric FLIR JPEG into a 2D °C matrix."""
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Thermal image not found: {image_path}")

        meta = self.get_metadata(image_path)

        # 1. Dynamic Per-Camera Calibration Constants
        R1 = self._clean_float(meta.get("PlanckR1"), 13614.67)
        R2 = self._clean_float(meta.get("PlanckR2"), 0.02569)
        B = self._clean_float(meta.get("PlanckB"), 1371.30)
        F = self._clean_float(meta.get("PlanckF"), 1.60)
        O = self._clean_float(meta.get("PlanckO"), -7183.0)

        E = self._clean_float(meta.get("Emissivity"), 0.83)
        T_refl = (
            self._clean_float(meta.get("ReflectedApparentTemperature"), 11.0)
            + 273.15
        )
        T_atm = (
            self._clean_float(meta.get("AtmosphericTemperature"), 20.0) + 273.15
        )
        distance = self._clean_float(meta.get("ObjectDistance"), 1.0)
        humidity = self._clean_float(meta.get("RelativeHumidity"), 50.0)

        tau_atm = self._compute_tau_atm(distance, humidity, T_atm - 273.15)

        # 2. Extract Raw Binary Chunk
        cmd = [self.exiftool_path, "-b", "-RawThermalImage", image_path]
        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        if not result.stdout:
            raise ValueError(
                f"No RawThermalImage chunk found in {image_path}."
            )

        raw_bytes = result.stdout

        # 3. 16-Bit Raw Detector Ingestion with Big-Endian Byte-Swap
        try:
            img = Image.open(io.BytesIO(raw_bytes))
            raw_matrix = (
                np.array(img, dtype=np.uint16).byteswap().astype(np.float32)
            )
        except Exception:
            w = int(meta.get("RawThermalImageWidth", 320))
            h = int(meta.get("RawThermalImageHeight", 240))
            raw_matrix = (
                np.frombuffer(raw_bytes, dtype=">u2")
                .reshape((h, w))
                .astype(np.float32)
            )

        if raw_matrix.ndim == 3:
            raw_matrix = raw_matrix[:, :, 0]

        # 4. Radiometric Radiance Transformations
        S_refl = R1 / (R2 * (np.exp(B / T_refl) - F)) - O
        S_atm = R1 / (R2 * (np.exp(B / T_atm) - F)) - O

        # Isolate object radiance
        S_obj = (
            raw_matrix
            - (1.0 - E) * tau_atm * S_refl
            - (1.0 - tau_atm) * S_atm
        ) / (E * tau_atm)

        # 5. Invert Planck Equation
        val = R1 / (R2 * (S_obj + O)) + F
        val = np.maximum(val, 1.0001)

        temp_kelvin = B / np.log(val)
        temp_celsius = np.round(temp_kelvin - 273.15, 2)

        # 6. Sanity guard: discard captures that are not genuine radiometric data
        self._assert_physical_range(temp_celsius, image_path)

        return temp_celsius


class RealFlirCamera:
    """Manages physical FLIR storage, single shot fetches, and full album batch scans."""

    def __init__(
        self,
        camera_mount_path=DEFAULT_CAMERA_MOUNT_PATH,
        # In flir_hardware.py or main.py
        #camera_mount_path = "./",
        max_lookup: int = LIVE_FRAME_LOOKBACK,
    ):
        # FLIR_MOUNT_PATH wins over the default mount path, never over an explicitly passed path.
        env_mount = (os.getenv("FLIR_MOUNT_PATH") or "").strip()
        if env_mount and camera_mount_path == DEFAULT_CAMERA_MOUNT_PATH:
            camera_mount_path = env_mount
        self.mount_path = camera_mount_path
        self.extractor = FlirExtractorNative()
        # Size of the reverse-scan window used by the live frame route
        self.max_lookup = max(1, int(max_lookup))
        # Bounded probe cache: path -> ((mtime, size), frame or None), so the 1 Hz poll does not
        # re-run ExifTool on unchanged candidates.
        # Holds at most `max_lookup` frames (~the candidate window).
        self._probe_cache = {}

    def get_all_images(self) -> list:
        files = glob.glob(os.path.join(self.mount_path, "*.jpg")) + glob.glob(
            os.path.join(self.mount_path, "*.JPG")
        )
        # Case-insensitive filesystems (Windows, FAT SD card) list each capture twice; keep one
        # entry per file.
        unique_files = {}
        for file_path in files:
            unique_files.setdefault(os.path.normcase(os.path.abspath(file_path)), file_path)
        files = sorted(unique_files.values(), key=os.path.getmtime)
        return files

    def _candidate_capture_paths(self, max_lookup: int = None) -> list:
        """Returns up to `max_lookup` newest capture paths, newest first."""
        files = self.get_all_images()
        if not files and os.path.exists("sample_flir.jpg"):
            files = ["sample_flir.jpg"]
        if not files:
            raise FileNotFoundError(
                f"No FLIR JPEG files found in {self.mount_path} or local"
                " directory."
            )

        lookup = max(1, int(max_lookup or self.max_lookup))
        return files[-lookup:][::-1]

    def _probe_capture(self, path: str) -> tuple:
        """Extracts one candidate, caching the outcome."""
        try:
            stat = os.stat(path)
            stamp = (stat.st_mtime, stat.st_size)
        except OSError as err:
            return None, f"{os.path.basename(path)} unavailable: {err}"

        cached = self._probe_cache.get(path)
        if cached and cached[0] == stamp:
            return cached[1], None if cached[1] else f"{os.path.basename(path)} previously rejected"

        try:
            matrix = self.extractor.extract_thermal_matrix(path)
            frame = {
                "name": os.path.basename(path),
                "mtime": stat.st_mtime,
                "width": int(matrix.shape[1]),
                "height": int(matrix.shape[0]),
                "data": matrix.tolist(),
            }
            error = None
        except (ValueError, RuntimeError, OSError) as err:
            # ValueError: radiometric sanity guard / missing raw thermal chunk
            # RuntimeError: ExifTool failure, OSError: unreadable or vanished file
            print(
                f"[WARN] Live frame skipped invalid candidate "
                f"{os.path.basename(path)}: {err}"
            )
            frame, error = None, str(err)

        self._probe_cache[path] = (stamp, frame)
        return frame, error

    def _resolve_live_frame(self, max_lookup: int = None) -> tuple:
        """Newest physically valid radiometric capture within the lookup window.

        Returns (path, frame_dict). Raises ValueError when every candidate in the
        window is rejected, so the caller fails loudly instead of serving garbage.
        """
        candidates = self._candidate_capture_paths(max_lookup)

        # Keep the cache bounded to the current window (memory = window x one frame)
        window = set(candidates)
        self._probe_cache = {
            path: entry for path, entry in self._probe_cache.items() if path in window
        }

        last_error = "no candidates inspected"
        for path in candidates:
            frame, error = self._probe_capture(path)
            if frame is not None:
                return path, frame
            last_error = error or last_error

        raise ValueError(
            "Failed to find a valid radiometric capture within the last "
            f"{len(candidates)} file(s) of {self.mount_path}. Last error: {last_error}"
        )

    def get_latest_image_info(self, max_lookup: int = None) -> dict:
        """Newest usable capture, used by the live route's change detection."""
        path, frame = self._resolve_live_frame(max_lookup)
        return {"path": path, "name": frame["name"], "mtime": frame["mtime"]}

    def capture_radiometric_matrix(self, max_lookup: int = None) -> dict:
        """Attempts extraction from the newest files on the mount, scanning
        backwards up to `max_lookup` candidates if corrupted or non-radiometric
        files are encountered.
        """
        _path, frame = self._resolve_live_frame(max_lookup)
        return frame

    def extract_full_album(self, limit: int = 0) -> list:
        """Extracts the camera album in chronological order (oldest first)."""
        files = self.get_all_images()
        if limit and limit > 0:
            files = files[-int(limit):]

        album = []
        for file_path in files:
            try:
                matrix = self.extractor.extract_thermal_matrix(file_path)
                album.append({
                    "name": os.path.basename(file_path),
                    "mtime": os.path.getmtime(file_path),
                    "width": int(matrix.shape[1]),
                    "height": int(matrix.shape[0]),
                    "data": matrix.tolist(),
                })
            except Exception as e:
                print(f"[WARN] Error parsing {file_path}: {e}")
        return album