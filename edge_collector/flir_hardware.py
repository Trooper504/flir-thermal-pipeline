# edge_collector/flir_hardware.py
import os
import glob
import io
import json
import subprocess
import re
import numpy as np
from PIL import Image


class FlirExtractorNative:
    """
    Native FLIR thermal extractor using ExifTool.
    Parses 16-bit raw detector counts and applies Planck calibration.
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
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ExifTool execution failed: {result.stderr}")
        return json.loads(result.stdout)[0]

    def extract_thermal_matrix(self, image_path: str) -> np.ndarray:
        meta = self.get_metadata(image_path)
        
        R1 = self._clean_float(meta.get("PlanckR1"), 21106.0)
        R2 = self._clean_float(meta.get("PlanckR2"), 0.001)
        B  = self._clean_float(meta.get("PlanckB"), 1501.0)
        F  = self._clean_float(meta.get("PlanckF"), 1.0)
        O  = self._clean_float(meta.get("PlanckO"), -7340.0)
        E  = self._clean_float(meta.get("Emissivity"), 0.95)
        T_refl = self._clean_float(meta.get("ReflectedApparentTemperature"), 20.0) + 273.15

        cmd = [self.exiftool_path, "-b", "-RawThermalImage", image_path]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        if not result.stdout:
            raise ValueError(f"No RawThermalImage chunk found in {image_path}")

        raw_image = Image.open(io.BytesIO(result.stdout))
        raw_matrix = np.array(raw_image, dtype=np.float32)

        raw_refl = R1 / (R2 * (np.exp(B / T_refl) - F)) - O
        raw_obj = (raw_matrix - (1.0 - E) * raw_refl) / E
        
        temp_kelvin = B / np.log(R1 / (R2 * (raw_obj + O)) + F)
        temp_celsius = temp_kelvin - 273.15

        return np.round(temp_celsius, 2)


class RealFlirCamera:
    """
    Interfaces with physical FLIR E8-XT storage mounted on Pi, 
    or falls back to local sample_flir.jpg if running offline.
    """
    def __init__(self, camera_mount_path="/media/raspberrypi_local/07F5-01A9/DCIM/100_FLIR"):
        self.mount_path = camera_mount_path
        self.extractor = FlirExtractorNative()

    def get_latest_image_path(self) -> str:
        # Check Pi camera mount directory first
        list_of_files = glob.glob(os.path.join(self.mount_path, "*.jpg"))
        if list_of_files:
            return max(list_of_files, key=os.path.getctime)
        
        # Local fallback for offline testing
        if os.path.exists("sample_flir.jpg"):
            return "sample_flir.jpg"
        
        raise FileNotFoundError("No FLIR JPEG files found on camera mount or local directory.")

    def capture_radiometric_matrix(self) -> np.ndarray:
        latest_jpg = self.get_latest_image_path()
        return self.extractor.extract_thermal_matrix(latest_jpg)