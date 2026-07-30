# desktop_client/app.py
import requests
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

# API endpoint (Change localhost to Pi's IP address when in the lab)
API_URL = "http://localhost:8081/api/v1/thermal-frame"

class ThermalClientApp:
    def __init__(self, target_emissivity=0.95):
        self.target_emissivity = target_emissivity
        self.fig, (self.ax_thermal, self.ax_gradient) = plt.subplots(1, 2, figsize=(12, 5))
        self.fig.canvas.manager.set_window_title("FLIR E8-XT Real-Time Thermal Gradient Dashboard")

    def fetch_thermal_frame(self):
        """Polls the edge collector for the 2D temperature matrix."""
        try:
            response = requests.get(API_URL, timeout=2.0)
            if response.status_code == 200:
                payload = response.json()
                return np.array(payload["data"], dtype=np.float32)
        except requests.exceptions.RequestException as e:
            print(f"[Error] Failed to connect to Edge Collector: {e}")
        return None

    def compute_gradient(self, temp_matrix):
        """Calculates spatial gradient magnitude (|dT/dx, dT/dy|)."""
        grad_y, grad_x = np.gradient(temp_matrix)
        grad_magnitude = np.sqrt(grad_x**2 + grad_y**2)
        return grad_magnitude

    def update_plot(self, frame_num):
        matrix = self.fetch_thermal_frame()
        if matrix is None:
            return

        # Calculate gradient magnitude
        grad_mag = self.compute_gradient(matrix)

        # Clear previous frame plots
        self.ax_thermal.clear()
        self.ax_gradient.clear()

        # 1. Thermal Surface Plot
        im1 = self.ax_thermal.imshow(matrix, cmap='inferno', origin='upper')
        self.ax_thermal.set_title(f"Thermal Map (°C)\nMin: {matrix.min():.1f}°C | Max: {matrix.max():.1f}°C")
        self.ax_thermal.axis('off')

        # 2. Gradient Magnitude Plot
        im2 = self.ax_gradient.imshow(grad_mag, cmap='viridis', origin='upper')
        self.ax_gradient.set_title("Spatial Thermal Gradient (|∇T|)")
        self.ax_gradient.axis('off')

    def run(self):
        # Animate at ~5 FPS (200 ms interval)
        ani = FuncAnimation(self.fig, self.update_plot, interval=200, cache_frame_data=False)
        plt.tight_layout()
        plt.show()

if __name__ == "__main__":
    client = ThermalClientApp()
    client.run()