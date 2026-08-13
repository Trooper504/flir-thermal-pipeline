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

  Plotly.newPlot('thermalPlot', [{
    z: matrix,
    type: 'heatmap',
    colorscale: 'YlOrRd',
    zmin: minBound,
    zmax: maxBound,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>Temp: %{z:.2f} deg C<extra></extra>'
  }], { 
    margin: { t: 5, b: 5, l: 25, r: 5 }, 
    paper_bgcolor: 'transparent', 
    plot_bgcolor: 'transparent', 
    font: { color: '#94a3b8' },
    shapes: layoutShapes
  });

  Plotly.newPlot('gradientPlot', [{
    z: grad,
    type: 'heatmap',
    colorscale: 'RdBu',
    reversescale: true,
    zmin: -maxAbsVal,
    zmax: maxAbsVal,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>dT: %{z:.3f} deg C<extra></extra>'
  }], { 
    margin: { t: 5, b: 5, l: 25, r: 5 }, 
    paper_bgcolor: 'transparent', 
    plot_bgcolor: 'transparent', 
    font: { color: '#94a3b8' } 
  });

  Plotly.newPlot('surface3DPlot', [{
    z: matrix,
    type: 'surface',
    colorscale: 'YlOrRd',
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

window.onload = initDatabase;