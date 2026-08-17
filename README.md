# FLIR Thermal Processing Pipeline — `feature/web-client`

## Overview
A scalable thermal-image capture, processing, and visualization pipeline integrating FLIR hardware ingestion at the edge, a lightweight desktop consumer, and a static web client for advanced interactive diagnostic analysis.

This branch (`feature/web-client`) introduces a modular, browser-based user interface (`webapp/`) that consumes live thermal frame REST APIs, handles raw semicolon FLIR CSV files, computes signed 3x3 spatial thermal gradients, renders 3D topography, and generates automated lab reports.

---

## Repository Structure

```text
flir-thermal-pipeline/
├── desktop_client/       # Python desktop consumer (desktop_client/app.py)
├── edge_collector/       # FLIR capture & extraction utilities (flir_hardware.py, main.py, mock_flir.py)
├── exiftool.exe          # Bundled ExifTool binary for radiometric metadata extraction
├── exiftool_files/       # Working directory for ExifTool outputs
├── requirements.txt      # Python dependencies for edge collector and desktop consumer
└── webapp/               # Modular static web client
    ├── index.html        # Single-page Tailwind UI layout and canvas containers
    └── js/
        ├── app.js        # DOM controls, IndexedDB storage, Plotly renderers, and report exporters
        ├── thermalEngine.js # Radiometric math, FLIR CSV parser, signed convolution, isotherm masking
        └── gifEngine.js   # Dual two-pass scale locking and animated GIF compiler
```

---

## Web Client Features (`webapp/`)

* **Strict FLIR CSV Parser:** Parses Russian semicolon/comma CSV exports (`34,192` → `34.192`) cleanly without false artifacts.
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
