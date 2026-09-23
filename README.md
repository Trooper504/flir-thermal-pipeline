# FLIR Thermal Processing Pipeline — `feature/web-client`

## Overview
A scalable thermal-image capture, processing, and visualization pipeline integrating FLIR hardware ingestion at the edge, a lightweight desktop consumer, and a static web client for advanced interactive diagnostic analysis.

This branch (`feature/web-client`) introduces a modular, browser-based user interface (`webapp/`) that consumes live thermal frame REST APIs, handles raw semicolon FLIR CSV files, computes signed 3x3 spatial thermal gradients, renders 3D topography, and generates automated lab reports.

---

## Repository Structure

```text
flir-thermal-pipeline/
├── desktop_client/       # Python desktop consumer (desktop_client/app.py)
├── edge_collector/       # FLIR capture & extraction utilities
│   ├── flir_hardware.py  # Radiometric extraction, sanity guard, live-frame reverse scan
│   ├── main.py           # FastAPI routes (frame / album / stream / trigger)
│   ├── live_stream_driver.py # Bounded MJPEG reader + snapshot coordination
│   └── mock_flir.py      # Hardware-free simulator
├── exiftool.exe          # Bundled ExifTool binary for radiometric metadata extraction
├── exiftool_files/       # Working directory for ExifTool outputs
├── requirements.txt      # Python dependencies for edge collector and desktop consumer
└── webapp/               # Modular static web client
    ├── index.html        # Workbench: ingestion, thermograms, reports
    ├── live.html         # Live Video & Acquisition Studio
    ├── micro_inspector.html # Sub-millimetre Particle & Thermal Dynamics Studio
    └── js/
        ├── app.js        # DOM controls, IndexedDB storage, Plotly renderers, and report exporters
        ├── thermalEngine.js # Radiometric math, FLIR CSV parser, signed convolution, isotherm masking
        ├── microEngine.js   # Percentile clipping, ROI slicing, MAD statistics, flux/divergence fields
        ├── microApp.js      # Micro Inspector UI, 4-camera Plotly grid, CSV/JSON exporters
        ├── liveApp.js       # Live studio controller (MJPEG + radiometric polling modes)
        └── gifEngine.js     # Dual two-pass scale locking and animated GIF compiler
```

---

## Web Client Features (`webapp/`)

* **Strict FLIR CSV Parser:** Parses Russian semicolon/comma CSV exports (`34,192` → `34.192`) cleanly without false artifacts.
* **Full-Album & Incremental Ingestion:** `START STREAM` pulls the entire camera album, while `INGEST LAST N` extracts only the newest *N* captures (`?limit=N`) so a session can be resumed by importing just the shots taken since the last import. Captures already stored are skipped by filename.
* **Click-to-Pick Differential Points:** `Pick P1` / `Pick P2` arm the 2D thermogram; a click writes the pixel coordinates straight into the `pt1X/pt1Y/pt2X/pt2Y` inputs (auto-advancing P1 → P2 → P1 for two-click pairing), draws cyan/amber markers plus a P1 → P2 guide line through `Plotly.relayout`, and stays synchronized with manual typing (which clamps to the frame bounds).
* **Micro Inspector Studio (`micro_inspector.html`):** unblurred (`zsmooth: false`) thermograms with percentile-clipped contrast, arbitrary center-anchored ROIs ($2\times3$, $4\times5$, $20\times20$, rectangle or ellipse, plus free-hand drawing through Plotly's draw tools), MAD/robust-σ micro statistics, sub-pixel thermal centroid, aspect-matched 3D micro-topography (linear or shifted-log), $-\nabla T$ flux quivers with magnitude-scaled opacity, and $\nabla\cdot\vec q$ source/sink divergence with dual CSV/JSON export.
* **Live Studio (`live.html`):** MJPEG viewfinder mode plus a hardware-free *radiometric polling* mode that paints genuine Planck-calibrated frames at 9 Hz, with an OSD crosshair, measured FPS, resolution telemetry and a snapshot hand-off that links straight into the workbench or the Micro Inspector.
* **Signed 3x3 Spatial Thermal Gradient:** Calculates local pixel temperature deviation ($T_{\text{center}} - \bar{T}_{\text{neighbors}}$) with symmetric dynamic scaling centered at $0.0\text{ °C}$.
* **3D Thermal Topography Surface:** Renders radiometric matrices as interactive 3D surface plots with projected isothermal contour lines.
* **Differential Point Inspection:** Real-time point-to-point temperature delta calculation ($\Delta T_{1-2} = |T(P_1) - T(P_2)|$).
* **Isothermal Range Masking:** Highlights specific temperature bands (TIso_min and TIso_Max) with high-contrast color overlays and calculates surface area percentage coverage.
* **Multi-Palette Colormap Selector:** On-the-fly switching between `YlOrRd`, `Jet/Ironbow`, `Greys`, `Viridis`, and `Coolwarm`.
* **Dual Two-Pass GIF Compiler:** Scans selected batch sequences to lock global temperature bounds before compiling and downloading separate Heatmap and Spatial Gradient `.gif` animations.
* **Structured JSON & PDF Report Exporter:** Export complete statistical frame reports with embedded Base64 canvas images or print formatted PDF diagnostic report cards.

---

## How It Fits Together

1. **Edge Collector (`edge_collector/`):** Extracts raw FLIR radiometric metadata and temperature matrices, serving frames over a REST API endpoint.
2. **Consumers (`desktop_client/` & `webapp/`):** Both clients pull thermal frame payloads (numeric 2D matrix + metadata) from the REST API endpoint (default: `http://localhost:8081/api/v1/thermal-frame`).
3. **Web Client (`webapp/`):** Runs locally or statically. Accepts live streaming API feeds, offline simulation data, or manual CSV uploads. Persists imported sequences in IndexedDB.

### Deployment topology (typical lab setup)

The **Raspberry Pi owns the camera** and serves the REST API; the workstation only runs the
HTML pages, so the browser must be pointed at the Pi rather than at itself:

```text
  FLIR E8-XT ──USB(mass storage)──►  Raspberry Pi
                                     ├── /media/raspberrypi_local/07F5-01A9/DCIM/100_FLIR
                                     ├── edge_collector/main.py  →  0.0.0.0:8081
                                     └── exiftool + Planck extraction
                                             ▲  http://<pi-address>:8081
                                             │
                                     Workstation (browser only)
                                     └── webapp/*.html  (served locally or opened from disk)
```

* Endpoint fields are pre-filled from the page's own host when the pages are served over
  http(s), otherwise from the last address you typed — which is remembered per browser via
  `localStorage` (`webapp/js/apiConfig.js`). Enter `http://<pi-address>:8081` once and every
  API-backed page reuses it.
* CORS is open on the collector (`allow_origins=["*"]`, origin reflected), so the pages work
  whether served from a local web server **or opened directly from disk** (`file://`).
* The **Micro Inspector is entirely client-side** (IndexedDB / CSV / demo data), so it needs no
  collector connection at all.
* **Pi prerequisites for the live viewfinder:** the E8-XT enumerates as USB mass storage, not as
  a camera, so MJPEG mode requires a real video device on the Pi
  (`ls /dev/video*` — e.g. a USB capture dongle wired to the camera's video output). Without one,
  `/api/v1/stream/live-mjpeg` returns HTTP 503 and the Live Studio falls back to radiometric
  polling, which needs no video hardware.

---

## Getting Started

### Prerequisites
* Python 3.8+
* Modern Web Browser (Chrome, Firefox, Edge)

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Run Edge Collector
Captures frames from connected FLIR hardware or runs a development mock:
```bash
python3 edge_collector/main.py
```

### 3. Run Desktop Consumer (Optional)
Fetches frames from the REST API and plots them locally using Matplotlib/Plotly:
```bash
python3 desktop_client/app.py
```

### 4. Run Web Client

#### Option A — Quick Local Static Server (Recommended)
Serve the `webapp/` directory on port 8000:
```bash
python3 -m http.server 8000 -d webapp
```
Then open `http://localhost:8000/` in your browser.

#### Option B — Direct File Access
Simply double-click or open `webapp/index.html` directly in any web browser.

---

## API Schema Expectations

The client components expect a JSON endpoint returning:
```json
{
  "width": 80,
  "height": 60,
  "timestamp": "2026-08-13T20:00:00Z",
  "data": [
    [32.1, 32.3, 32.5],
    [32.0, 34.8, 32.2]
  ]
}
```

### Album endpoint

`GET /api/v1/thermal-album` returns every capture on the camera, oldest first:

```json
{
  "status": "success",
  "total_frames": 2,
  "requested_limit": 0,
  "frames": [
    { "name": "FLIR0001.jpg", "mtime": 1770000000.0, "width": 320, "height": 240, "data": [[32.1]] }
  ]
}
```

Pass `?limit=N` to return only the `N` most recent captures (used by the **INGEST LAST N** button).
`limit` defaults to `0`, meaning the complete album; negative values are rejected with HTTP 400.
ExifTool is only invoked for the selected files, so a large `N` is far cheaper than a full scan.

### Live frame endpoint

`GET /api/v1/thermal-frame` returns the newest **usable** capture. Non-radiometric or corrupted
files (e.g. a visual screenshot copied into the DCIM folder) are skipped with a warning, scanning
backwards through up to `LIVE_FRAME_LOOKBACK` (3) candidates, so one stray file cannot stall
polling. Already-probed candidates are cached against their mtime + size, so a 1 Hz poll performs
no ExifTool work while the mount is unchanged. Repeating the `mtime` the client already holds
returns HTTP 204, and the compared timestamp is the one the client received, so the same frame is
never re-delivered in a loop.

### Live viewfinder & snapshot endpoints

| Route | Purpose |
|---|---|
| `GET /api/v1/stream/devices` | Active MJPEG binding, available OpenCV backends, and (with `?probe=true`) every capture index that opens. |
| `GET /api/v1/stream/live-mjpeg` | `multipart/x-mixed-replace` MJPEG at the E8-XT's 9 Hz. `?index=N` / `?backend=dshow\|v4l2` bind a device explicitly, `?frames=N` caps the stream for diagnostics, and HTTP 503 is returned when nothing opens. |
| `POST /api/v1/camera/trigger-snapshot` | Coordinates a capture, waits (bounded) for a new file to appear and returns the newest radiometric frame. Runs `FLIR_TRIGGER_CMD` when configured, reports `trigger: hardware \| software`, and never touches USB power or sysfs. |

> **Hardware reality for the live route.** The FLIR E-series (E4 … E8-XT) is a USB *mass-storage*
> instrument with no UVC / DirectShow / V4L2 video interface, so `cv2.VideoCapture` cannot
> enumerate it — on a laptop the only capture device is usually the built-in webcam. Live view
> from these cameras is reachable only through FLIR's own software paths (Wi-Fi / composite
> video), and the shutter/NUC cannot be commanded over mass storage. `webapp/live.html` therefore
> reports exactly which device a stream is bound to and offers **radiometric polling** of
> `/api/v1/thermal-frame` as a hardware-free thermal feed.

---

## Developer Notes

* **Modular Architecture:** Frontend code is separated into `thermalEngine.js` (math/parsing), `gifEngine.js` (animations), and `app.js` (UI/IndexedDB/Plotly).
* **Zero Build Step:** Built as a native HTML5/ES6 static app using Tailwind CSS, Plotly.js, and GIF.js via CDNs for simple edge deployment.
* **ExifTool Processing:** `edge_collector/flir_hardware.py` contains the parsing logic converting raw ExifTool outputs into radiometric matrices. If you update the frame schema, align both `flir_hardware.py` and `webapp/js/thermalEngine.js`.

---

## Technical Specifications & Theoretical Whitepaper

To read the full theoretical foundation of the FLIR Radiometric Web Platform, including all 9 core analytical modules, use the link below:

[View the Technical Specifications & Whitepaper](https://tinyurl.com/2hwfsrsn)

> The document is available in view-only mode.

---

## License & Contribution
Maintains project repository license and contribution guidelines.