# FLIR Thermal Processing Pipeline — `feature/web-client`

## Overview
A scalable thermal-image capture, processing, and visualization pipeline integrating FLIR hardware ingestion at the edge, a lightweight desktop consumer, and a static web client for advanced interactive diagnostic analysis.

This branch (`feature/web-client`) introduces a modular, browser-based user interface (`webapp/`) that consumes live thermal frame REST APIs, handles raw semicolon FLIR CSV files, computes signed 3x3 spatial thermal gradients, renders 3D topography, and generates automated lab reports.

---

## Repository Structure

```text
flir-thermal-pipeline/
├── desktop_client/       # Python desktop consumer (desktop_client/app.py)
├── deploy/               # Raspberry Pi host setup: setup_pi.sh + flir-collector.service
├── edge_collector/       # FLIR capture & extraction utilities
│   ├── flir_hardware.py  # Radiometric extraction, sanity guard, live-frame reverse scan
│   ├── main.py           # FastAPI routes (frame / album / stream / trigger)
│   ├── live_stream_driver.py # Bounded MJPEG reader, snapshot coordination, UVC capability probe
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
* **ExifTool** — radiometric extraction shells out to `exiftool`, so it must be resolvable from the
  collector's working directory:
  * **Raspberry Pi / Linux:** `sudo apt install libimage-exiftool-perl` (lands on `PATH`).
  * **Windows:** the repository bundles `exiftool.exe` at its root, which Python resolves only when
    the collector is started **from the repo root** (`python edge_collector/main.py`). Launching it
    from another directory makes every capture fail to parse - the server logs `[WARN] Error parsing ...`
    and `/api/v1/thermal-album` returns 0 frames (the client shows `NO PI FRAMES FOUND FOR LAST N`).

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

### 5. Raspberry Pi host setup (server side)

The Pi is the host that owns the camera and serves every endpoint, so the server-side work belongs
there. `deploy/setup_pi.sh` does it in one pass and is safe to re-run:

```bash
cd ~/flir-thermal-pipeline
./deploy/setup_pi.sh --dry-run            # print the plan, change nothing
./deploy/setup_pi.sh                      # system packages, virtualenv, host checks
./deploy/setup_pi.sh --install-service    # ...plus flir-collector.service, enabled at boot
```

What each step is for:

| Step | Why it is needed on the Pi |
| --- | --- |
| `apt-get install python3-venv python3-pip libimage-exiftool-perl v4l-utils libgl1 libglib2.0-0 libsm6 libxext6` | ExifTool performs the radiometric extraction, `v4l2-ctl` supplies the pixel-format / control evidence that `?capabilities=true` reports, and the GL libraries are what `import cv2` links against on a headless host |
| `python3 -m venv venv` + `pip install -r requirements.txt` | the same layout the Windows instructions use (`venv/` is git-ignored). On **32-bit ARM** (`armv7l`) PyPI has no `opencv-python` wheel, so the script installs Debian's `python3-opencv` and creates the venv with `--system-site-packages` rather than compiling for hours |
| `usermod -aG video <user>` | `/dev/video*` is `root:video 0660`, so the service account cannot see a video device until it is in that group (log out/in, or reboot, for it to take effect) |
| `deploy/flir-collector.service` → `/etc/systemd/system/` | server-side deploy: starts at boot, restarts on failure, and `RequiresMountsFor=` the camera mount so ingestion cannot race the automount (with nothing plugged in there is no mount unit, so the dependency adds nothing) |
| host checks | `import cv2/numpy/fastapi/uvicorn`, `exiftool` and `v4l2-ctl` on `PATH`, the `/dev/video*` nodes, and whether the camera mount actually holds JPEGs |

The unit sets the collector's configuration through the environment, so the module is never edited
per host. Every variable is optional - the defaults reproduce a plain `python3 edge_collector/main.py`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLIR_COLLECTOR_HOST` / `FLIR_COLLECTOR_PORT` | `0.0.0.0` / `8081` | listener; 8081 is what `webapp/` and `desktop_client/` assume |
| `FLIR_MOUNT_PATH` | `/media/raspberrypi_local/07F5-01A9/DCIM/100_FLIR` | where the camera's SD card is mounted on **this** host. Raspberry Pi OS mounts removable media under `/media/<user>/`, so a differently named account otherwise reads 0 frames silently |
| `FLIR_VIDEO_INDEX` / `FLIR_VIDEO_BACKEND` | unset | pins the MJPEG viewfinder when several `/dev/video*` nodes exist (e.g. a UVC node plus its metadata node) |
| `V4L2_CTL_PATH` | `v4l2-ctl` from `PATH` | override when v4l-utils lives somewhere unusual |
| `USE_SIMULATION` | `false` | `true` runs the mock driver with no hardware and no ExifTool |

Verify the deployed host with:

```bash
systemctl status flir-collector                                        # running?
journalctl -u flir-collector -f                                        # logs
curl -s "http://localhost:8081/api/v1/stream/devices?capabilities=true&read_test=true" | python3 -m json.tool
ls -l /dev/video* ; v4l2-ctl --list-devices                            # what the kernel actually sees
ls /media/$USER/                                                       # the camera's SD card (volume name = its UUID)
```

`deploy/flir-collector.service` is a **template**: `setup_pi.sh --install-service` substitutes the
service user, repository path, virtualenv name, port and mount, then runs `systemd-analyze verify`
before enabling it. Installing it by hand means replacing those fields first (or running
`--install-service --dry-run` and copying the unit it prints) - copying the file unchanged would
hand the placeholders to systemd verbatim.

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
| `GET /api/v1/stream/devices` | Active MJPEG binding, available OpenCV backends, and (with `?probe=true`) every capture index that opens. `?capabilities=true` adds the UVC capability probe (negotiated fourcc, USB interface class, advertised pixel formats, control list and a Scenario A/B verdict); `?read_test=true` also reads one frame per index **in a child process** to catch a metadata node that opens but never streams, and `?max_index=N` / `?budget_seconds=N` bound how far and how long the sweep may run. An identical repeat inside a few seconds is answered from the previous result (`cached: true`) unless `?fresh=true`. |
| `GET /api/v1/stream/live-mjpeg` | `multipart/x-mixed-replace` MJPEG at the E8-XT's 9 Hz. `?index=N` / `?backend=dshow\|v4l2` bind a device explicitly, `?frames=N` caps the stream for diagnostics, and HTTP 503 is returned when nothing opens. |
| `POST /api/v1/camera/trigger-snapshot` | Coordinates a capture, waits (bounded) for a new file to appear and returns the newest radiometric frame. Runs `FLIR_TRIGGER_CMD` when configured, reports `trigger: hardware \| software`, and never touches USB power or sysfs. |

> **Hardware reality for the live route.** The FLIR E-series (E4 … E8-XT) is a USB *mass-storage*
> instrument with no UVC / DirectShow / V4L2 video interface, so `cv2.VideoCapture` cannot
> enumerate it — on a laptop the only capture device is usually the built-in webcam. Live view
> from these cameras is reachable only through FLIR's own software paths (Wi-Fi / composite
> video), and the shutter/NUC cannot be commanded over mass storage. `webapp/live.html` therefore
> reports exactly which device a stream is bound to and offers **radiometric polling** of
> `/api/v1/thermal-frame` as a hardware-free thermal feed.

> **Is the camera actually UVC?** The note above is the project's expectation, not a measurement,
> so the collector can check it on the host instead: `GET /api/v1/stream/devices?capabilities=true`
> (the **UVC CAPABILITY PROBE** button on `live.html`) reports, per capture index, the fourcc OpenCV
> negotiated, the USB interface class behind `/dev/videoN` (`0e` == Video Class), every pixel format
> `v4l2-ctl` advertises, and the control list — a vendor-named control section is where UVC
> extension-unit (XU) commands such as shutter / FFC live. Verdicts are blunt on purpose:
> `no-capture-device` (mass-storage-only camera, exactly as expected here),
> `scenario-a-8-bit-viewfinder` (a real live picture with no temperature meaning),
> `scenario-b-radiometric-y16` (16-bit detector counts — still **no** Planck constants in the
> stream), `metadata-nodes-only` (opens, never streams) and `capture-device-unclassified`
> (format not reported). The same evidence by hand on the Pi:
> `lsusb -v -d <vid:pid> | grep bInterfaceClass` (look for `0e`), `dmesg | grep -i uvcvideo`,
> `v4l2-ctl --list-devices`, `v4l2-ctl -d /dev/video0 --list-formats-ext`, `v4l2-ctl -d /dev/video0 -l`.
> Install `v4l-utils` (`sudo apt install v4l-utils`) — without it the format list is unavailable, and
> add `?read_test=true` when a metadata node is suspected, because it opens happily and then never
> delivers a frame (which is what would otherwise stop the MJPEG route mid-stream).
>
> Every probe is bounded in the way each part can actually be bounded. The **frame-read test**
> (`?read_test=true`) runs in a **child process**, so `subprocess` kills it on timeout: an OpenCV
> capture cannot be interrupted from inside the interpreter, and abandoning one in-process was
> tried here — the blocked call still owned the capture, which wedged the collector and then took
> the whole process down under DirectShow. The child also means a crashing camera backend cannot
> reach the API, and a timeout reports `ok: null` ("no evidence") rather than a failed device. The
> **sweep** gets a 20 s budget (`?budget_seconds=N`) which is deliberately *soft*: it stops starting
> new work, but an index already being inspected cannot be interrupted — `scanTruncated` says
> plainly when the scan stopped early rather than implying that no device exists. Probing is also
> the only route here that touches the devices, so an identical repeat within 10 s is answered from
> the previous result (`cached: true`) unless `?fresh=true`: on a Windows workstation the *third*
> consecutive probe of the same host stopped answering entirely, with no read test involved, which
> is exactly what a double-clicked button would have caused. (Opening `/dev/videoN` on the Pi is
> cheap and does not show this behaviour.)
>
> An operating system can also refuse a camera to a desktop app **without failing the open**: the
> capture is created and the read simply never returns, so a blocked camera looks exactly like
> wedged hardware. Every probe therefore reports the host's own camera-access policy as well
> (`hostCameraAccess`: the Windows *desktop apps* consent value, the per-user toggle and the
> machine-wide one). When the policy is `Deny`, the summary says so and the timed-out read test is
> labelled as that refusal instead of implying a faulty device; clear it in
> `Settings → Privacy & security → Camera → Let desktop apps access your camera`, then re-probe
> with `?fresh=true`. Reading the policy touches no device, costs nothing, and cannot wedge
> anything.
>
> `?probe=true` (the older `PROBE DEVICES` button) is deliberately unchanged: it opens every index
> **in-process**, and an OpenCV open cannot be interrupted - so on a host that blocks or wedges a
> camera that request can hang. Use `?capabilities=true` on such a host; the bounded probe is the
> one to trust.

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