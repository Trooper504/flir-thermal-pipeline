# edge_collector/main.py
import os
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mock_flir import MockFlirCamera

app = FastAPI(title="FLIR E8-XT Raspberry Pi Edge Collector")

# Enable CORS for web client access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Toggle hardware vs simulation
USE_SIMULATION = False

if not USE_SIMULATION:
    try:
        from flir_hardware import RealFlirCamera
        camera_driver = RealFlirCamera()
    except Exception as e:
        print(f"[WARN] Failed to load Real FLIR Driver ({e}). Using Mock Simulator.")
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
    matrix = camera_driver.capture_radiometric_matrix()
    return {
        "timestamp": float(np.round(np.datetime64('now').astype(float), 3)),
        "width": matrix.shape[1],
        "height": matrix.shape[0],
        "min_temp": float(matrix.min()),
        "max_temp": float(matrix.max()),
        "data": matrix.tolist()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081)