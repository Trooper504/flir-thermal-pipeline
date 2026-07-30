# edge_collector/mock_flir.py
import numpy as np
import time

class MockFlirCamera:
    """
    Simulates a FLIR E8-XT thermal camera output (320x240 radiometric array)
    for development without physical hardware.
    """
    def __init__(self, width=320, height=240):
        self.width = width
        self.height = height

    def capture_radiometric_matrix(self, ambient_temp=22.5, hotspot_temp=45.0) -> np.ndarray:
        # Base ambient room temperature with small random sensor noise
        matrix = np.full((self.height, self.width), ambient_temp) + np.random.normal(0, 0.05, (self.height, self.width))
        
        # Add a simulated Gaussian heat spot (e.g., a Peltier crystal or optical sample)
        y, x = np.ogrid[:self.height, :self.width]
        center_y, center_x = self.height // 2, self.width // 2
        dist_from_center = (x - center_x)**2 + (y - center_y)**2
        
        # Heat gaussian curve
        heat_spot = (hotspot_temp - ambient_temp) * np.exp(-dist_from_center / (2 * 30**2))
        
        return np.round(matrix + heat_spot, 3)

if __name__ == "__main__":
    cam = MockFlirCamera()
    sample = cam.capture_radiometric_matrix()
    print(f"Captured Mock Frame Shape: {sample.shape}")
    print(f"Min Temp: {sample.min()}°C | Max Temp: {sample.max()}°C")