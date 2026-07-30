# edge_collector/main.py
import os
import numpy as np
from fastapi import FastAPI
from mock_flir import MockFlirCamera

# Flag: Toggle hardware mode vs simulation
USE_SIMULATION = False

app = FastAPI(title="FLIR E8-XT Raspberry Pi Edge Collector")

# Initialize hardware or fallback simulator
if not USE_SIMULATION:
    try:
        from flir_hardware import RealFlirCamera
        camera_driver = RealFlirCamera()
        print("[INFO] Real FLIR Camera Driver loaded successfully.")
    except Exception as e:
        print(f"[WARN] Failed to load Real FLIR Driver ({e}). Falling back to Mock Simulator.")
        camera_driver = MockFlirCamera()
else:
    camera_driver = MockFlirCamera()


@app.get("/")
def read_root():
    return {
        "status": "Pi Edge Collector Online",
        "mode": "Simulation" if isinstance(camera_driver, MockFlirCamera) else "Hardware FLIR E8-XT"
    }


@app.get("/api/v1/thermal-frame")
def get_thermal_frame():
    """
    Extracts or simulates the 2D temperature array (°C) and returns JSON payload.
    """
    # Capture matrix (NumPy array)
    matrix = camera_driver.capture_radiometric_matrix()
    
    return {
        "timestamp": float(np.round(np.datetime64('now').astype(float), 3)),
        "width": matrix.shape[1],
        "height": matrix.shape[0],
        "min_temp": float(matrix.min()),
        "max_temp": float(matrix.max()),
        "data": matrix.tolist()  # 2D array of float temperatures
    }


if __name__ == "__main__":
    import uvicorn
    # Runs server on Port 8081
    uvicorn.run(app, host="0.0.0.0", port=8081)