import os
from datetime import datetime, timezone
import numpy as np
from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from mock_flir import MockFlirCamera

app = FastAPI(title="FLIR E8-XT Raspberry Pi Edge Collector")

# Enable CORS for local and remote browser access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Environment flag toggle for simulation mode
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
    is_sim = isinstance(camera_driver, MockFlirCamera)
    return {
        "status": "Pi Edge Collector Online",
        "mode": "Simulation" if is_sim else "Hardware FLIR E8-XT",
        "endpoints": {
            "latest_frame": "/api/v1/thermal-frame",
            "full_album": "/api/v1/thermal-album"
        }
    }


@app.get("/api/v1/thermal-frame")
def get_thermal_frame(response: Response, if_modified_since: float = 0.0):
    """
    Returns the latest radiometric frame.
    If `if_modified_since` matches the latest file timestamp, returns HTTP 204 (No Content)
    to prevent duplicate frame polling.
    """
    try:
        # Check for change timestamp if driver supports metadata inspection
        if hasattr(camera_driver, "get_latest_image_info"):
            latest_info = camera_driver.get_latest_image_info()
            if latest_info["mtime"] <= if_modified_since and if_modified_since > 0:
                response.status_code = status.HTTP_204_NO_CONTENT
                return None

        # Capture matrix
        result = camera_driver.capture_radiometric_matrix()

        # Format if driver returns a dictionary (RealFlirCamera) vs raw numpy matrix (MockFlirCamera)
        if isinstance(result, dict):
            matrix = np.array(result["data"], dtype=np.float32)
            filename = result.get("name", "live_capture.jpg")
            mtime = result.get("mtime", datetime.now(timezone.utc).timestamp())
        else:
            matrix = result
            filename = f"mock_{datetime.now(timezone.utc).strftime('%H%M%S')}.jpg"
            mtime = datetime.now(timezone.utc).timestamp()

    except Exception as err:
        print(f"[ERROR] Frame capture failed: {err}")
        raise HTTPException(status_code=500, detail=f"Hardware capture failed: {str(err)}")

    return {
        "status": "success",
        "is_new": True,
        "filename": filename,
        "mtime": mtime,
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


@app.get("/api/v1/thermal-album")
def get_thermal_album():
    """
    Extracts and returns all images present on the camera storage in chronological order.
    """
    if hasattr(camera_driver, "extract_full_album"):
        try:
            frames = camera_driver.extract_full_album()
            return {
                "status": "success",
                "total_frames": len(frames),
                "frames": frames
            }
        except Exception as err:
            print(f"[ERROR] Album extraction failed: {err}")
            raise HTTPException(status_code=500, detail=f"Album extraction failed: {str(err)}")
    else:
        # Fallback simulation response if running mock driver
        sim_frames = []
        for i in range(3):
            mat = camera_driver.capture_radiometric_matrix()
            sim_frames.append({
                "name": f"sim_frame_{i+1}.jpg",
                "mtime": datetime.now(timezone.utc).timestamp() + i,
                "width": int(mat.shape[1]),
                "height": int(mat.shape[0]),
                "data": mat.tolist()
            })
        return {
            "status": "success",
            "total_frames": len(sim_frames),
            "frames": sim_frames
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081)