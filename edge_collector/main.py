import os
from datetime import datetime, timezone
import inspect
import numpy as np
from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from mock_flir import MockFlirCamera
from live_stream_driver import LiveStreamDriver, coordinate_snapshot

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

# Live viewfinder MJPEG reader. Device binding stays explicit (FLIR_VIDEO_INDEX /
# ?index=) because cv2.VideoCapture cannot see the E8-XT's mass-storage interface.
stream_driver = LiveStreamDriver()


@app.get("/")
def read_root():
    is_sim = isinstance(camera_driver, MockFlirCamera)
    return {
        "status": "Pi Edge Collector Online",
        "mode": "Simulation" if is_sim else "Hardware FLIR E8-XT",
        "endpoints": {
            "latest_frame": "/api/v1/thermal-frame",
            "full_album": "/api/v1/thermal-album",
            "recent_album": "/api/v1/thermal-album?limit=N",
            "stream_devices": "/api/v1/stream/devices",
            "live_mjpeg": "/api/v1/stream/live-mjpeg",
            "trigger_snapshot": "POST /api/v1/camera/trigger-snapshot"
        }
    }


@app.get("/api/v1/thermal-frame")
def get_thermal_frame(response: Response, if_modified_since: float = 0.0):
    """
    Returns the latest radiometric frame.
    If `if_modified_since` matches the timestamp of the newest *usable* capture,
    returns HTTP 204 (No Content) to prevent duplicate frame polling. Non-radiometric
    files at the end of the camera storage are skipped by the driver, and the timestamp
    reported here is the one the client received, so polling stays in sync.
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
def get_thermal_album(limit: int = 0):
    """
    Extracts and returns images present on the camera storage in chronological order.

    `limit` > 0 returns only the `limit` most recent captures (newest shots last),
    which lets clients incrementally ingest freshly taken pictures without
    re-processing the whole album. `limit` <= 0 returns the entire album.
    """
    if limit < 0:
        raise HTTPException(
            status_code=400, detail="`limit` must be greater than or equal to 0."
        )

    if hasattr(camera_driver, "extract_full_album"):
        try:
            extract_album = camera_driver.extract_full_album
            # Backwards compatible with drivers exposing the legacy no-argument signature
            accepts_limit = "limit" in inspect.signature(extract_album).parameters
            frames = extract_album(limit=limit) if accepts_limit else extract_album()
            return {
                "status": "success",
                "total_frames": len(frames),
                "requested_limit": limit if accepts_limit else 0,
                "frames": frames
            }
        except Exception as err:
            print(f"[ERROR] Album extraction failed: {err}")
            raise HTTPException(status_code=500, detail=f"Album extraction failed: {str(err)}")
    else:
        # Fallback simulation response if running mock driver
        frame_count = limit if limit > 0 else 3
        sim_frames = []
        for i in range(frame_count):
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
            "requested_limit": limit,
            "frames": sim_frames
        }


@app.get("/api/v1/stream/devices")
def get_stream_devices(probe: bool = False):
    """Lists the capture bindings available to the MJPEG route, plus the active one.

    `probe=true` opens each candidate index in turn (properties only - no frames are
    read) so an operator can find which index their hardware answers on.
    """
    payload = {
        "status": "success",
        "driver": stream_driver.status(),
        "note": (
            "The FLIR E-series exposes USB mass storage, not a UVC / DirectShow / V4L2 "
            "video interface, so cv2.VideoCapture will not list the thermal camera. Bind "
            "a device explicitly (FLIR_VIDEO_INDEX or ?index=N) and check that the "
            "reported resolution matches the source you intend to view."
        )
    }
    if probe:
        payload["devices"] = stream_driver.probe_devices()
    return payload


@app.get("/api/v1/stream/live-mjpeg")
def get_live_mjpeg(index: int = -1, backend: str = "", frames: int = 0):
    """
    Streams the 8-bit viewfinder as MJPEG (multipart/x-mixed-replace), paced at the
    E8-XT's 9 Hz. `index=-1` keeps the driver's configured/default binding; `frames`
    caps the stream for diagnostics (0 = unlimited).
    """
    device = stream_driver.open_device(index=index, backend=backend)
    if device is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "No MJPEG capture device available",
                "hint": (
                    "No video capture index could be opened. The thermal camera itself is "
                    "not UVC, so this is expected when no external video source is attached. "
                    "Use radiometric polling of /api/v1/thermal-frame instead - it streams "
                    "real thermal data at 9 Hz without video hardware."
                ),
                "driver": stream_driver.status()
            }
        )

    boundary = b"frame"
    print(
        f"[INFO] MJPEG stream started on index {device['index']} ({device['backend']}), "
        f"{device['width']}x{device['height']} @ {device['fps']} fps"
    )

    return StreamingResponse(
        stream_driver.mjpeg_generator(boundary=boundary, max_frames=frames if frames and frames > 0 else None),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}
    )


@app.post("/api/v1/camera/trigger-snapshot")
def trigger_camera_snapshot(wait_seconds: float = 4.0, external_command: str = ""):
    """
    Coordinates a snapshot and returns the newest physically valid radiometric frame.

    Runs an external trigger command only when one is configured (`FLIR_TRIGGER_CMD` or
    the `external_command` parameter), waits (bounded) for the camera to write a new
    file, then extracts it through the normal Planck pipeline. USB power / sysfs are
    deliberately never touched: unbinding the storage interface would only reset the SD
    reader that album ingestion relies on and cannot fire the instrument shutter.
    """
    try:
        result = coordinate_snapshot(
            camera_driver,
            wait_seconds=wait_seconds,
            external_command=external_command or None
        )
    except Exception as err:
        print(f"[ERROR] Snapshot coordination failed: {err}")
        raise HTTPException(status_code=500, detail=f"Snapshot coordination failed: {str(err)}")

    frame = result["frame"]
    matrix = np.array(frame["data"], dtype=np.float32)

    return {
        "status": "success",
        "trigger": result["trigger"],
        "externalCommand": result["externalCommand"],
        "externalCommandError": result["externalCommandError"],
        "newFilesDetected": result["newFilesDetected"],
        "newFileDetection": result.get("newFileDetection"),
        "waitedSeconds": result["waitedSeconds"],
        "filename": frame["name"],
        "mtime": frame["mtime"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "width": int(matrix.shape[1]),
        "height": int(matrix.shape[0]),
        "min_temp": float(np.round(matrix.min(), 2)),
        "max_temp": float(np.round(matrix.max(), 2)),
        "unit": "degC",
        "data": frame["data"]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081)