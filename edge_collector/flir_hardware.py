# edge_collector/flir_hardware.py
import glob
import io
import json
import os
import re
import subprocess
import numpy as np
from PIL import Image


class FlirExtractorNative:
    """Native FLIR thermal extractor using ExifTool.

    Parses 16-bit raw detector counts with big-endian byte-swapping
    and applies dynamic FLIR Planck calibration.
    """

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

    def extract_thermal_matrix(self, image_path: str) -> np.ndarray:
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
        temp_celsius = temp_kelvin - 273.15

        return np.round(temp_celsius, 2)


class RealFlirCamera:
    """Manages physical FLIR storage, single shot fetches, and full album batch scans."""

    def __init__(
        self,
        camera_mount_path="/media/raspberrypi_local/07F5-01A9/DCIM/100_FLIR",
    ):
        self.mount_path = camera_mount_path
        self.extractor = FlirExtractorNative()

    def get_all_images(self) -> list:
        files = glob.glob(os.path.join(self.mount_path, "*.jpg")) + glob.glob(
            os.path.join(self.mount_path, "*.JPG")
        )
        files.sort(key=os.path.getmtime)
        return files

    def get_latest_image_info(self) -> dict:
        files = self.get_all_images()
        if not files:
            if os.path.exists("sample_flir.jpg"):
                return {
                    "path": "sample_flir.jpg",
                    "name": "sample_flir.jpg",
                    "mtime": os.path.getmtime("sample_flir.jpg"),
                }
            raise FileNotFoundError(
                f"No FLIR JPEG files found in {self.mount_path} or local"
                " directory."
            )

        latest = files[-1]
        return {
            "path": latest,
            "name": os.path.basename(latest),
            "mtime": os.path.getmtime(latest),
        }

    def capture_radiometric_matrix(self) -> dict:
        info = self.get_latest_image_info()
        matrix = self.extractor.extract_thermal_matrix(info["path"])
        return {
            "name": info["name"],
            "mtime": info["mtime"],
            "width": int(matrix.shape[1]),
            "height": int(matrix.shape[0]),
            "data": matrix.tolist(),
        }

    def extract_full_album(self) -> list:
        files = self.get_all_images()
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