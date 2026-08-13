let db = null;
let frameBuffer = [];
let selectedIndices = new Set();
let activeInspectedIdx = null;
let isImporting = false;
let importIntervalId = null;

// --- INDEXEDDB STORAGE ENGINE ---
function initDatabase() {
  const request = indexedDB.open("FlirThermalPipelineDB", 1);
  request.onupgradeneeded = function(e) {
    db = e.target.result;
    if (!db.objectStoreNames.contains("frames")) {
      db.createObjectStore("frames", { keyPath: "id" });
    }
  };
  request.onsuccess = function(e) {
    db = e.target.result;
    loadFramesFromDatabase();
  };
}

function saveFrameToDatabase(frameData) {
  if (!db) return;
  const tx = db.transaction("frames", "readwrite");
  tx.objectStore("frames").put(frameData);
}

function loadFramesFromDatabase() {
  if (!db) return;
  const tx = db.transaction("frames", "readonly");
  const request = tx.objectStore("frames").getAll();

  request.onsuccess = function() {
    const storedFrames = request.result;
    if (storedFrames && storedFrames.length > 0) {
      const currentEmissivity = parseFloat(document.getElementById("cfgEmissivity").value);
      frameBuffer = storedFrames.map(f => {
        f.calibratedMatrix = applyPlanckRecalibration(f.rawMatrix, currentEmissivity, 20.0, 0.95);
        return f;
      });

      document.getElementById("lblFrameCount").innerText = frameBuffer.length;
      document.getElementById("galleryGrid").innerHTML = "";
      frameBuffer.forEach(f => appendThumbnailToGallery(f));
    }
  };
}

function clearDbAndGallery() {
  if (confirm("Delete all stored frames from IndexedDB?")) {
    if (db) {
      const tx = db.transaction("frames", "readwrite");
      tx.objectStore("frames").clear();
    }
    frameBuffer = [];
    selectedIndices.clear();
    activeInspectedIdx = null;
    document.getElementById("galleryGrid").innerHTML = "";
    document.getElementById("lblFrameCount").innerText = "0";
    document.getElementById("inspectorPanel").classList.add("hidden");
    updateBatchUI();
  }
}

// --- UI HANDLERS ---
function handleSourceChange() {
  const source = document.getElementById("cfgDataSource").value;
  const apiInput = document.getElementById("cfgApiUrl");
  const csvContainer = document.getElementById("csvUploadContainer");
  
  if (source === "pi") {
    apiInput.disabled = false;
    apiInput.classList.remove("text-slate-600", "opacity-60");
    apiInput.classList.add("text-slate-200");
    csvContainer.classList.add("hidden");
  } else if (source === "csv") {
    apiInput.disabled = true;
    apiInput.classList.add("text-slate-600", "opacity-60");
    csvContainer.classList.remove("hidden");
  } else {
    apiInput.disabled = true;
    apiInput.classList.add("text-slate-600", "opacity-60");
    csvContainer.classList.add("hidden");
  }
}

async function handleCsvFilesUpload(event) {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  for (const file of files) {
    const text = await file.text();
    const matrix = parseFlirCsvText(text);
    if (matrix && matrix.length > 0) {
      const currentEmissivity = parseFloat(document.getElementById("cfgEmissivity").value);
      const frameData = {
        id: frameBuffer.length,
        timestamp: file.name,
        rawMatrix: matrix,
        calibratedMatrix: applyPlanckRecalibration(matrix, currentEmissivity, 20.0, 0.95),
        width: matrix[0].length,
        height: matrix.length
      };
      frameBuffer.push(frameData);
      saveFrameToDatabase(frameData);
      appendThumbnailToGallery(frameData);
    }
  }
  document.getElementById("lblFrameCount").innerText = frameBuffer.length;
  updateBatchUI();
}

function triggerRecalibration() {
  const targetEmissivity = parseFloat(document.getElementById("cfgEmissivity").value);
  frameBuffer.forEach(frame => {
    frame.calibratedMatrix = applyPlanckRecalibration(frame.rawMatrix, targetEmissivity, 20.0, 0.95);
  });
  if (activeInspectedIdx !== null) inspectFrame(activeInspectedIdx);
}

function replotActiveCanvas() {
  if (activeInspectedIdx !== null) inspectFrame(activeInspectedIdx);
}

// --- STREAM INGESTION ---
function startImportStream() {
  isImporting = true;
  document.getElementById("btnImport").disabled = true;
  document.getElementById("btnImport").classList.add("opacity-50", "cursor-not-allowed");
  
  const stopBtn = document.getElementById("btnStop");
  stopBtn.disabled = false;
  stopBtn.classList.remove("opacity-50", "cursor-not-allowed", "text-slate-600");
  stopBtn.classList.add("text-slate-200", "hover:bg-slate-900");

  const sourceMode = document.getElementById("cfgDataSource").value;
  document.getElementById("statusBadge").innerText = `INGESTING (${sourceMode.toUpperCase()})`;

  importIntervalId = setInterval(ingestFrame, 1000);
}

function stopImportStream() {
  isImporting = false;
  if (importIntervalId) clearInterval(importIntervalId);

  document.getElementById("btnImport").disabled = false;
  document.getElementById("btnImport").classList.remove("opacity-50", "cursor-not-allowed");

  const stopBtn = document.getElementById("btnStop");
  stopBtn.disabled = true;
  stopBtn.classList.add("opacity-50", "cursor-not-allowed", "text-slate-600");

  document.getElementById("statusBadge").innerText = "SYSTEM IDLE";
}

async function ingestFrame() {
  const sourceMode = document.getElementById("cfgDataSource").value;
  let rawMatrix = null;
  let width = 80, height = 60;

  if (sourceMode === "pi") {
    const url = document.getElementById("cfgApiUrl").value;
    try {
      const res = await fetch(url);
      const json = await res.json();
      rawMatrix = json.data;
      width = json.width;
      height = json.height;
    } catch (err) {
      console.error("Fetch error:", err);
      return;
    }
  } else if (sourceMode === "simulation") {
    rawMatrix = generateMockThermalMatrix(60, 80);
  } else {
    return;
  }

  const currentEmissivity = parseFloat(document.getElementById("cfgEmissivity").value);
  const frameData = {
    id: frameBuffer.length,
    timestamp: new Date().toLocaleTimeString(),
    rawMatrix: rawMatrix,
    calibratedMatrix: applyPlanckRecalibration(rawMatrix, currentEmissivity, 20.0, 0.95),
    width: width,
    height: height
  };
  
  frameBuffer.push(frameData);
  saveFrameToDatabase(frameData);

  document.getElementById("lblFrameCount").innerText = frameBuffer.length;
  appendThumbnailToGallery(frameData);
}

function appendThumbnailToGallery(frame) {
  const grid = document.getElementById("galleryGrid");
  const thumb = document.createElement("div");
  thumb.className = "bg-slate-950 border border-slate-800 p-2 rounded cursor-pointer hover:border-slate-600 transition";
  
  thumb.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <input type="checkbox" class="frame-checkbox rounded bg-slate-900 border-slate-700 text-slate-400 focus:ring-0" 
             onchange="toggleFrameSelect(${frame.id}, event)">
      <span class="text-[10px] font-mono text-slate-500">#${frame.id + 1}</span>
    </div>
    <div onclick="inspectFrame(${frame.id})" class="text-center py-1.5 bg-slate-900 rounded border border-slate-800">
      <div class="text-[10px] font-mono text-slate-300 truncate">${frame.timestamp}</div>
    </div>
  `;
  grid.appendChild(thumb);
}

function toggleFrameSelect(idx, event) {
  event.stopPropagation();
  if (selectedIndices.has(idx)) {
    selectedIndices.delete(idx);
  } else {
    selectedIndices.add(idx);
  }
  updateBatchUI();
}

function selectAllFrames() {
  frameBuffer.forEach((_, idx) => selectedIndices.add(idx));
  document.querySelectorAll('.frame-checkbox').forEach(cb => cb.checked = true);
  updateBatchUI();
}

function updateBatchUI() {
  const group = document.getElementById("batchActionGroup");
  const countLbl = document.getElementById("lblSelectedCount");
  const gifBtn = document.getElementById("btnGenerateGif");
  
  const count = selectedIndices.size;
  countLbl.innerText = count;

  if (count >= 1) {
    group.classList.remove("hidden");
    if (count >= 2) {
      gifBtn.disabled = false;
      gifBtn.classList.remove("opacity-50", "cursor-not-allowed");
    } else {
      gifBtn.disabled = true;
      gifBtn.classList.add("opacity-50", "cursor-not-allowed");
    }
  } else {
    group.classList.add("hidden");
  }
}

// --- INSPECTION DASHBOARD ---
// --- INSPECT FRAME WITH ISOTHERMAL MASK OVERLAY ---
// --- INSPECT FRAME WITH DYNAMIC PALETTE SELECTION ---
function inspectFrame(idx) {
  activeInspectedIdx = idx;
  const frame = frameBuffer[idx];
  if (!frame) return;

  document.getElementById("inspectorPanel").classList.remove("hidden");
  document.getElementById("inspectorTimestamp").innerText = frame.timestamp;

  const matrix = frame.calibratedMatrix;
  const minBound = parseFloat(document.getElementById("cfgMinTemp").value);
  const maxBound = parseFloat(document.getElementById("cfgMaxTemp").value);
  const sensitivity = parseFloat(document.getElementById("cfgHotspotSensitivity").value);

  // Read Selected Palette Preferences
  const heatmapPalette = document.getElementById("cfgHeatmapPalette")?.value || "YlOrRd";
  const gradientPalette = document.getElementById("cfgGradientPalette")?.value || "RdBu";

  const roi = detectHotspotROI(matrix, sensitivity);
  const alertContainer = document.getElementById("hotspotAlert");

  if (roi.hasHotspot) {
    alertContainer.innerHTML = `
      <span class="text-slate-200 font-mono">
        HOTSPOT: Peak ${roi.peakTemp.toFixed(1)} deg C at (${roi.peakCoord.x}, ${roi.peakCoord.y})
      </span>
    `;
  } else {
    alertContainer.innerHTML = `<span class="text-slate-600 font-mono">NO HOTSPOT DETECTED</span>`;
  }

  // Differential Point Calculations
  const p1x = Math.max(0, Math.min(matrix[0].length - 1, parseInt(document.getElementById("pt1X").value) || 0));
  const p1y = Math.max(0, Math.min(matrix.length - 1, parseInt(document.getElementById("pt1Y").value) || 0));
  const p2x = Math.max(0, Math.min(matrix[0].length - 1, parseInt(document.getElementById("pt2X").value) || 0));
  const p2y = Math.max(0, Math.min(matrix.length - 1, parseInt(document.getElementById("pt2Y").value) || 0));

  const tempP1 = matrix[p1y][p1x];
  const tempP2 = matrix[p2y][p2x];
  const deltaT = Math.abs(tempP1 - tempP2);

  document.getElementById("lblP1Temp").innerText = `${tempP1.toFixed(2)} deg C`;
  document.getElementById("lblDeltaT").innerText = `${deltaT.toFixed(2)} deg C`;

  document.getElementById("tblMinTemp").innerText = `${roi.minTemp.toFixed(2)} deg C`;
  document.getElementById("tblMaxTemp").innerText = `${roi.peakTemp.toFixed(2)} deg C`;
  document.getElementById("tblMeanTemp").innerText = `${roi.meanTemp.toFixed(2)} deg C`;
  document.getElementById("tblStdDev").innerText = `${roi.stdDev.toFixed(2)} deg C`;
  document.getElementById("tblDeltaTVal").innerText = `${deltaT.toFixed(2)} deg C`;

  // Isothermal Mask Processing
  const isIsoEnabled = document.getElementById("chkEnableIso")?.checked || false;
  const isoMin = parseFloat(document.getElementById("isoMinTemp")?.value) || 33.0;
  const isoMax = parseFloat(document.getElementById("isoMaxTemp")?.value) || 35.0;
  const isoColorChoice = document.getElementById("isoMaskColor")?.value || "magenta";

  let heatmapTraces = [{
    z: matrix,
    type: 'heatmap',
    colorscale: heatmapPalette, // Dynamic Heatmap Palette
    zmin: minBound,
    zmax: maxBound,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>Temp: %{z:.2f} deg C<extra></extra>'
  }];

  if (isIsoEnabled) {
    const isoResult = computeIsothermMask(matrix, isoMin, isoMax);
    document.getElementById("lblIsoPixelCount").innerText = `${isoResult.matchCount} px`;
    document.getElementById("lblIsoAreaPct").innerText = `${isoResult.areaPercentage.toFixed(2)} %`;

    const colorHexMap = { magenta: '#ff00ff', cyan: '#00ffff', lime: '#00ff00' };
    const targetColor = colorHexMap[isoColorChoice] || '#ff00ff';

    heatmapTraces.push({
      z: isoResult.maskMatrix,
      type: 'heatmap',
      colorscale: [[0, targetColor], [1, targetColor]],
      showscale: false,
      hovertemplate: 'X: %{x}<br>Y: %{y}<br><b>ISOTHERM: %{z:.2f} deg C</b><extra></extra>'
    });
  } else {
    document.getElementById("lblIsoPixelCount").innerText = `0 px`;
    document.getElementById("lblIsoAreaPct").innerText = `0.00 %`;
  }

  const grad = computeGradient2D(matrix);

  let gradMin = Infinity, gradMax = -Infinity;
  grad.forEach(row => row.forEach(v => {
    if (v < gradMin) gradMin = v;
    if (v > gradMax) gradMax = v;
  }));
  const maxAbsVal = Math.max(Math.abs(gradMin), Math.abs(gradMax));

  let layoutShapes = [];
  if (roi.hasHotspot) {
    layoutShapes.push({
      type: 'rect',
      x0: roi.bbox.x0 - 1, y0: roi.bbox.y0 - 1,
      x1: roi.bbox.x1 + 1, y1: roi.bbox.y1 + 1,
      line: { color: '#e2e8f0', width: 1.5 }
    });
  }

  layoutShapes.push({
    type: 'circle',
    x0: p1x - 1, y0: p1y - 1, x1: p1x + 1, y1: p1y + 1,
    fillcolor: '#38bdf8', line: { color: '#ffffff', width: 1 }
  });
  layoutShapes.push({
    type: 'circle',
    x0: p2x - 1, y0: p2y - 1, x1: p2x + 1, y1: p2y + 1,
    fillcolor: '#f43f5e', line: { color: '#ffffff', width: 1 }
  });

  // Render Radiometric Heatmap
  Plotly.newPlot('thermalPlot', heatmapTraces, { 
    margin: { t: 5, b: 5, l: 25, r: 5 }, 
    paper_bgcolor: 'transparent', 
    plot_bgcolor: 'transparent', 
    font: { color: '#94a3b8' },
    shapes: layoutShapes
  });

  // Render Spatial Gradient with Selected Palette
  Plotly.newPlot('gradientPlot', [{
    z: grad,
    type: 'heatmap',
    colorscale: gradientPalette, // Dynamic Gradient Palette
    reversescale: gradientPalette === 'RdBu',
    zmin: -maxAbsVal,
    zmax: maxAbsVal,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>dT: %{z:.3f} deg C<extra></extra>'
  }], { 
    margin: { t: 5, b: 5, l: 25, r: 5 }, 
    paper_bgcolor: 'transparent', 
    plot_bgcolor: 'transparent', 
    font: { color: '#94a3b8' } 
  });

  // Render 3D Surface Topography
  Plotly.newPlot('surface3DPlot', [{
    z: matrix,
    type: 'surface',
    colorscale: heatmapPalette, // Dynamic 3D Surface Palette
    cmin: minBound,
    cmax: maxBound,
    contours: {
      z: { show: true, usecolormap: true, highlightcolor: "#e2e8f0", project: { z: true } }
    },
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>Temp: %{z:.2f} deg C<extra></extra>'
  }], {
    margin: { t: 10, b: 10, l: 10, r: 10 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    scene: {
      xaxis: { title: 'X', color: '#64748b', gridcolor: '#1e293b' },
      yaxis: { title: 'Y', color: '#64748b', gridcolor: '#1e293b' },
      zaxis: { title: 'Temp (deg C)', color: '#64748b', gridcolor: '#1e293b', range: [minBound, maxBound] },
      aspectratio: { x: 1, y: 1, z: 0.4 }
    }
  });

  const thermalPlotEl = document.getElementById('thermalPlot');
  thermalPlotEl.on('plotly_hover', function(data){
    const pt = data.points[0];
    document.getElementById("hoverCoords").innerText = `(${pt.x}, ${pt.y})`;
    document.getElementById("hoverTemp").innerText = `${pt.z.toFixed(2)} deg C`;
  });

  updateLineProfile();
}

function updateLineProfile() {
  if (activeInspectedIdx === null) return;
  const frame = frameBuffer[activeInspectedIdx];
  if (!frame) return;

  const matrix = frame.calibratedMatrix;
  const orientation = document.getElementById("sliceOrientation").value;
  let idx = parseInt(document.getElementById("sliceIndex").value);

  let sliceData = [];
  let axisLabels = [];

  if (orientation === "horizontal") {
    idx = Math.max(0, Math.min(matrix.length - 1, idx));
    sliceData = matrix[idx];
    axisLabels = sliceData.map((_, i) => i);
  } else {
    idx = Math.max(0, Math.min(matrix[0].length - 1, idx));
    sliceData = matrix.map(row => row[idx]);
    axisLabels = sliceData.map((_, i) => i);
  }

  Plotly.newPlot('lineProfilePlot', [{
    x: axisLabels,
    y: sliceData,
    type: 'scatter',
    mode: 'lines',
    line: { color: '#cbd5e1', width: 1.5 }
  }], {
    margin: { t: 10, b: 25, l: 30, r: 10 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    xaxis: { title: orientation === 'horizontal' ? 'Pixel X' : 'Pixel Y', color: '#64748b' },
    yaxis: { title: 'Temp (deg C)', color: '#64748b' }
  });
}

function exportSelectedCSV() {
  if (selectedIndices.size === 0) return;
  const selectedFrames = Array.from(selectedIndices).map(i => frameBuffer[i]);
  
  selectedFrames.forEach((frame) => {
    let csvContent = "data:text/csv;charset=utf-8,";
    frame.calibratedMatrix.forEach(row => {
      csvContent += row.map(val => val.toFixed(2)).join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `thermal_frame_${frame.id + 1}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
}
// --- STRUCTURED JSON REPORT EXPORTER ---
async function exportLabReportJSON() {
  if (activeInspectedIdx === null || !frameBuffer[activeInspectedIdx]) {
    alert("Select a frame from the gallery to generate a lab report.");
    return;
  }

  const frame = frameBuffer[activeInspectedIdx];
  const matrix = frame.calibratedMatrix;
  const sensitivity = parseFloat(document.getElementById("cfgHotspotSensitivity").value);
  const emissivity = parseFloat(document.getElementById("cfgEmissivity").value);

  const roi = detectHotspotROI(matrix, sensitivity);

  // Read Differential Point Coordinates
  const p1x = parseInt(document.getElementById("pt1X").value) || 0;
  const p1y = parseInt(document.getElementById("pt1Y").value) || 0;
  const p2x = parseInt(document.getElementById("pt2X").value) || 0;
  const p2y = parseInt(document.getElementById("pt2Y").value) || 0;

  const tempP1 = matrix[p1y] ? matrix[p1y][p1x] : 0;
  const tempP2 = matrix[p2y] ? matrix[p2y][p2x] : 0;
  const deltaT = Math.abs(tempP1 - tempP2);

  // Read Isothermal Mask Metrics
  const isIsoEnabled = document.getElementById("chkEnableIso")?.checked || false;
  const isoMin = parseFloat(document.getElementById("isoMinTemp")?.value) || 33.0;
  const isoMax = parseFloat(document.getElementById("isoMaxTemp")?.value) || 35.0;
  const isoResult = isIsoEnabled ? computeIsothermMask(matrix, isoMin, isoMax) : null;

  // Capture Base64 Rendered Images from Canvases
  const heatmapImgUrl = await Plotly.toImage('thermalPlot', { format: 'png', width: 800, height: 500 });
  const gradientImgUrl = await Plotly.toImage('gradientPlot', { format: 'png', width: 800, height: 500 });

  const reportObject = {
    reportMetadata: {
      generatedAt: new Date().toISOString(),
      softwareVersion: "FLIR Radiometric Processing Unit v2.4",
      frameTimestamp: frame.timestamp,
      frameIndex: frame.id + 1
    },
    radiometricParameters: {
      emissivity: emissivity,
      hotspotCutoffMultiplier: sensitivity,
      matrixDimensions: { rows: matrix.length, cols: matrix[0].length }
    },
    statisticalSummary: {
      minTemperatureDegC: parseFloat(roi.minTemp.toFixed(2)),
      maxTemperatureDegC: parseFloat(roi.peakTemp.toFixed(2)),
      meanTemperatureDegC: parseFloat(roi.meanTemp.toFixed(2)),
      standardDeviationDegC: parseFloat(roi.stdDev.toFixed(2))
    },
    differentialPointAnalysis: {
      point1: { x: p1x, y: p1y, temperatureDegC: parseFloat(tempP1.toFixed(2)) },
      point2: { x: p2x, y: p2y, temperatureDegC: parseFloat(tempP2.toFixed(2)) },
      deltaTDegC: parseFloat(deltaT.toFixed(2))
    },
    isothermalMaskAnalysis: {
      enabled: isIsoEnabled,
      temperatureRangeDegC: { min: isoMin, max: isoMax },
      matchingPixelCount: isoResult ? isoResult.matchCount : 0,
      surfaceAreaPercentage: isoResult ? parseFloat(isoResult.areaPercentage.toFixed(2)) : 0.0
    },
    renderedImageArtifacts: {
      heatmapPngBase64: heatmapImgUrl,
      spatialGradientPngBase64: gradientImgUrl
    }
  };

  // Trigger JSON file download
  const blob = new Blob([JSON.stringify(reportObject, null, 2)], { type: "application/json" });
  const downloadLink = document.createElement("a");
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = `thermal_lab_report_frame_${frame.id + 1}_${Date.now()}.json`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
}

// --- PRINTABLE HTML / PDF REPORT GENERATOR ---
async function generatePrintableLabReport() {
  if (activeInspectedIdx === null || !frameBuffer[activeInspectedIdx]) {
    alert("Select a frame from the gallery to generate a lab report.");
    return;
  }

  const frame = frameBuffer[activeInspectedIdx];
  const matrix = frame.calibratedMatrix;
  const sensitivity = parseFloat(document.getElementById("cfgHotspotSensitivity").value);
  const emissivity = parseFloat(document.getElementById("cfgEmissivity").value);

  const roi = detectHotspotROI(matrix, sensitivity);

  const p1x = parseInt(document.getElementById("pt1X").value) || 0;
  const p1y = parseInt(document.getElementById("pt1Y").value) || 0;
  const p2x = parseInt(document.getElementById("pt2X").value) || 0;
  const p2y = parseInt(document.getElementById("pt2Y").value) || 0;

  const tempP1 = matrix[p1y] ? matrix[p1y][p1x] : 0;
  const tempP2 = matrix[p2y] ? matrix[p2y][p2x] : 0;
  const deltaT = Math.abs(tempP1 - tempP2);

  const heatmapImgUrl = await Plotly.toImage('thermalPlot', { format: 'png', width: 600, height: 400 });
  const gradientImgUrl = await Plotly.toImage('gradientPlot', { format: 'png', width: 600, height: 400 });

  const reportWindow = window.open('', '_blank');
  reportWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Thermal Diagnostic Report - Frame ${frame.id + 1}</title>
      <style>
        body { font-family: monospace; padding: 20px; background: #ffffff; color: #1e293b; }
        h1 { font-size: 18px; border-bottom: 2px solid #0f172a; padding-bottom: 8px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
        th { background: #f8fafc; }
        img { width: 100%; border: 1px solid #cbd5e1; }
      </style>
    </head>
    <body>
      <h1>RADIOMETRIC THERMAL DIAGNOSTIC REPORT</h1>
      <p><strong>Frame Identifier:</strong> ${frame.timestamp} | <strong>Emissivity:</strong> ${emissivity}</p>
      
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Min Temperature</td><td>${roi.minTemp.toFixed(2)} deg C</td></tr>
        <tr><td>Max Temperature (Peak)</td><td>${roi.peakTemp.toFixed(2)} deg C</td></tr>
        <tr><td>Mean Temperature</td><td>${roi.meanTemp.toFixed(2)} deg C</td></tr>
        <tr><td>Standard Deviation (sigma)</td><td>${roi.stdDev.toFixed(2)} deg C</td></tr>
        <tr><td>Differential Delta T (P1 vs P2)</td><td>${deltaT.toFixed(2)} deg C</td></tr>
      </table>

      <div class="grid" style="margin-top: 20px;">
        <div>
          <h3>Radiometric Heatmap</h3>
          <img src="${heatmapImgUrl}" />
        </div>
        <div>
          <h3>Spatial Thermal Gradient</h3>
          <img src="${gradientImgUrl}" />
        </div>
      </div>
      
      <script>window.onload = function() { window.print(); };<\/script>
    </body>
    </html>
  `);
  reportWindow.document.close();
}

window.onload = initDatabase;