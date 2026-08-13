import os
from datetime import datetime, timezone
import numpy as np
from fastapi import FastAPI, HTTPException
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

# Environment flag toggle for simulation mode (Defaults to False if not set)
USE_SIMULATION = os.getenv("USE_SIMULATION", "False").lower() in ("true", "1", "t")

if not USE_SIMULATION:
    try:
        from flir_hardware import RealFlirCamera
        camera_driver = RealFlirCamera()
        print("[INFO] Real FLIR Camera driver initialized successfully.")
    except Exception as e:
        print(f"[WARN] Failed to load Real FLIR Driver ({e}). Falling back to Mock Simulator.")
        camera_driver = MockFlirCamera()
else:
    print("[INFO] Running in Simulation Mode (MockFlirCamera).")
    camera_driver = MockFlirCamera()


@app.get("/")
def read_root():
    return {
        "status": "Pi Edge Collector Online",
        "mode": "Simulation" if isinstance(camera_driver, MockFlirCamera) else "Hardware FLIR E8-XT",
        "endpoint": "/api/v1/thermal-frame"
    }


@app.get("/api/v1/thermal-frame")
def get_thermal_frame():
    try:
        matrix = camera_driver.capture_radiometric_matrix()
    except Exception as err:
        print(f"[ERROR] Frame capture failed: {err}")
        raise HTTPException(status_code=500, detail=f"Hardware capture failed: {str(err)}")

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "width": int(matrix.shape[1]),
        "height": int(matrix.shape[0]),
        "min_temp": float(np.round(matrix.min(), 2)),
        "max_temp": float(np.round(matrix.max(), 2)),
        "emissivity": 0.95,
        "reflectedTempC": 20.0,
        "unit": "degC",
        "data": matrix.tolist()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081)