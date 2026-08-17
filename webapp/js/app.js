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
      frameBuffer = storedFrames.map(f => {
        f.calibratedMatrix = calibrateFrameMatrix(f.rawMatrix);
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
// --- ADAPTIVE EMISSIVITY ZONES STATE & CONTROLS ---
let activeEmissivityZones = [];

function addEmissivityZone() {
  const nameInput = document.getElementById("zoneName");
  const minInput = document.getElementById("zoneMinTemp");
  const maxInput = document.getElementById("zoneMaxTemp");
  const epsInput = document.getElementById("zoneEmissivity");

  const name = nameInput.value.trim() || `Zone ${activeEmissivityZones.length + 1}`;
  const minTemp = parseFloat(minInput.value);
  const maxTemp = parseFloat(maxInput.value);
  const emissivity = parseFloat(epsInput.value);

  if (isNaN(minTemp) || isNaN(maxTemp) || isNaN(emissivity) || minTemp >= maxTemp) {
    alert("Please enter valid range thresholds (Min < Max) and emissivity (0.05 - 1.0).");
    return;
  }

  activeEmissivityZones.push({
    id: Date.now(),
    name: name,
    minTemp: minTemp,
    maxTemp: maxTemp,
    emissivity: Math.max(0.05, Math.min(1.0, emissivity))
  });

  nameInput.value = "";
  renderZonesTable();
  triggerRecalibration();
}

function removeEmissivityZone(id) {
  activeEmissivityZones = activeEmissivityZones.filter(z => z.id !== id);
  renderZonesTable();
  triggerRecalibration();
}

function renderZonesTable() {
  const tbody = document.getElementById("tblEmissivityZones");
  if (!tbody) return;

  if (activeEmissivityZones.length === 0) {
    tbody.innerHTML = `
      <tr class="border-b border-slate-900 text-slate-500 italic">
        <td colspan="4" class="py-2 px-2 text-center">No custom zones added. (Default baseline emissivity applied to entire scene).</td>
      </tr>`;
    return;
  }

  tbody.innerHTML = activeEmissivityZones.map(zone => `
    <tr class="border-b border-slate-800/60 hover:bg-slate-900/50">
      <td class="py-1 px-2 text-slate-300 font-bold">${zone.name}</td>
      <td class="py-1 px-2 text-slate-400">${zone.minTemp.toFixed(1)} &deg;C &ndash; ${zone.maxTemp.toFixed(1)} &deg;C</td>
      <td class="py-1 px-2 text-sky-400 font-bold">&epsilon; = ${zone.emissivity.toFixed(2)}</td>
      <td class="py-1 px-2">
        <button onclick="removeEmissivityZone(${zone.id})" class="text-rose-400 hover:text-rose-300 text-[11px] underline">Remove</button>
      </td>
    </tr>
  `).join("");
}

// --- UNIFIED CALIBRATION & SPATIAL FILTERING PIPELINE ---
function calibrateFrameMatrix(rawMatrix) {
  if (!rawMatrix || rawMatrix.length === 0) return rawMatrix;

  const isAstm = document.getElementById("chkEnableAstm")?.checked || false;
  const isZoning = document.getElementById("chkEnableZoning")?.checked || false;
  const isBilateral = document.getElementById("chkEnableBilateral")?.checked || false;
  const defaultEmissivity = parseFloat(document.getElementById("cfgEmissivity")?.value) || 0.95;

  let calibrated = null;

  // 1. Radiometric Inversion Selection
  if (isZoning && activeEmissivityZones.length > 0) {
    const epsMatrix = generateEmissivityMatrix(rawMatrix, activeEmissivityZones, defaultEmissivity);
    calibrated = applyZonedRadiometricCorrection(rawMatrix, epsMatrix, 20.0, 0.95);
  } else if (isAstm) {
    const params = {
      emissivity: defaultEmissivity,
      distanceMeters: parseFloat(document.getElementById("cfgDistance")?.value) || 1.5,
      relativeHumidity: parseFloat(document.getElementById("cfgHumidity")?.value) || 50.0,
      atmTempC: parseFloat(document.getElementById("cfgAtmTemp")?.value) || 20.0,
      reflTempC: parseFloat(document.getElementById("cfgReflTemp")?.value) || 20.0,
      winTrans: parseFloat(document.getElementById("cfgWinTrans")?.value) || 1.0,
      winTempC: parseFloat(document.getElementById("cfgWinTemp")?.value) || 20.0
    };
    const res = applyAstmCalibration(rawMatrix, params);
    calibrated = res.calibratedMatrix;
  } else {
    calibrated = applyPlanckRecalibration(rawMatrix, defaultEmissivity, 20.0, 0.95);
  }

  // 2. Edge-Preserving Bilateral Denoising
  if (isBilateral) {
    const radius = parseInt(document.getElementById("cfgFilterRadius")?.value) || 2;
    const sigmaSpace = parseFloat(document.getElementById("cfgSigmaSpace")?.value) || 2.5;
    const sigmaColor = parseFloat(document.getElementById("cfgSigmaColor")?.value) || 1.2;
    calibrated = applyBilateralFilter2D(calibrated, radius, sigmaSpace, sigmaColor);
  }

  return calibrated;
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
      const frameData = {
        id: frameBuffer.length,
        timestamp: file.name,
        rawMatrix: matrix,
        calibratedMatrix: calibrateFrameMatrix(matrix),
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
  const isAstm = document.getElementById("chkEnableAstm")?.checked || false;
  const emissivity = parseFloat(document.getElementById("cfgEmissivity")?.value) || 0.95;

  const astmParams = {
    emissivity: emissivity,
    distanceMeters: parseFloat(document.getElementById("cfgDistance")?.value) || 1.5,
    relativeHumidity: parseFloat(document.getElementById("cfgHumidity")?.value) || 50.0,
    atmTempC: parseFloat(document.getElementById("cfgAtmTemp")?.value) || 20.0,
    reflTempC: parseFloat(document.getElementById("cfgReflTemp")?.value) || 20.0,
    winTrans: parseFloat(document.getElementById("cfgWinTrans")?.value) || 1.0,
    winTempC: parseFloat(document.getElementById("cfgWinTemp")?.value) || 20.0,
    baseEmissivity: 0.95
  };

  frameBuffer.forEach(frame => {
    // 1. Unified pipeline executes zoned emissivity, ASTM, and bilateral filtering
    frame.calibratedMatrix = calibrateFrameMatrix(frame.rawMatrix);

    // 2. Preserve ASTM metadata for diagnostic readouts
    if (isAstm && typeof computeAtmosphericTransmission === "function") {
      frame.tau_atm = computeAtmosphericTransmission(
        astmParams.distanceMeters,
        astmParams.relativeHumidity,
        astmParams.atmTempC
      );
      frame.total_opt_gain = frame.tau_atm * astmParams.winTrans;
    } else {
      frame.tau_atm = 1.0;
      frame.total_opt_gain = 1.0;
    }
  });

  // 3. Re-render active viewport and plots
  if (activeInspectedIdx !== null) {
    inspectFrame(activeInspectedIdx);
  }
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
}async function ingestFrame() {
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

  const frameData = {
    id: frameBuffer.length,
    timestamp: new Date().toLocaleTimeString(),
    rawMatrix: rawMatrix,
    calibratedMatrix: calibrateFrameMatrix(rawMatrix),
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
  // Compute Offset / Difference Matrix (T_corrected - T_raw)
  const isAstm = document.getElementById("chkEnableAstm")?.checked || false;
  let offsetMatrix = Array.from({ length: matrix.length }, () => new Array(matrix[0].length).fill(0));
  let sumOffset = 0, totalPx = matrix.length * matrix[0].length;

  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[0].length; c++) {
      const diff = frame.calibratedMatrix[r][c] - frame.rawMatrix[r][c];
      offsetMatrix[r][c] = diff;
      sumOffset += diff;
    }
  }

  const meanOffset = sumOffset / totalPx;
  if (document.getElementById("lblAtmTrans")) {
    document.getElementById("lblAtmTrans").innerText = (frame.tau_atm || 1.0).toFixed(4);
    document.getElementById("lblTotalOptGain").innerText = (frame.total_opt_gain || 1.0).toFixed(4);
    document.getElementById("lblMeanOffset").innerText = `${meanOffset >= 0 ? '+' : ''}${meanOffset.toFixed(2)} °C`;
  }

  // Render ASTM Offset Plot
  if (isAstm) {
    Plotly.newPlot('astmCorrectionPlot', [{
      z: offsetMatrix,
      type: 'heatmap',
      colorscale: 'RdBu',
      reversescale: true,
      hovertemplate: 'X: %{x}<br>Y: %{y}<br>Offset: %{z:+.2f} °C<extra></extra>'
    }], {
      margin: { t: 5, b: 5, l: 25, r: 5 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8' }
    });
  }
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

// --- RUN ADVANCED PPT AND TSR ANALYSIS ---
function runPptAnalysis() {
  const framesToProcess = selectedIndices.size >= 3 
    ? Array.from(selectedIndices).sort((a,b) => a - b).map(i => frameBuffer[i])
    : frameBuffer;

  const sequenceLength = framesToProcess.length;
  const depthLbl = document.getElementById("lblSequenceDepth");
  if (depthLbl) depthLbl.innerText = `${sequenceLength} frames`;

  if (sequenceLength < 3) {
    alert("PPT requires a sequence of at least 3 temporal frames (select frames or stream frames into buffer).");
    return;
  }

  const freqBin = parseInt(document.getElementById("cfgFftBin")?.value) || 1;
  const phasePalette = document.getElementById("cfgPhasePalette")?.value || "Viridis";

  // 1. Compute PPT Phase and Amplitude
  const ppt = computePptMaps(framesToProcess, freqBin);
  if (ppt) {
    Plotly.newPlot('pptPhasePlot', [{
      z: ppt.phaseMatrix,
      type: 'heatmap',
      colorscale: phasePalette,
      hovertemplate: 'X: %{x}<br>Y: %{y}<br>Phase: %{z:.3f} rad<extra></extra>'
    }], {
      margin: { t: 5, b: 5, l: 25, r: 5 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8' }
    });

    Plotly.newPlot('pptAmpPlot', [{
      z: ppt.amplitudeMatrix,
      type: 'heatmap',
      colorscale: 'Hot',
      hovertemplate: 'X: %{x}<br>Y: %{y}<br>Amplitude: %{z:.3f}<extra></extra>'
    }], {
      margin: { t: 5, b: 5, l: 25, r: 5 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8' }
    });
  }

  // 2. Compute TSR & Time Derivatives at Point 1 (P1)
  const p1x = parseInt(document.getElementById("pt1X")?.value) || 20;
  const p1y = parseInt(document.getElementById("pt1Y")?.value) || 20;
  const tsr = computeTsrDerivatives(framesToProcess, p1x, p1y);

  if (tsr) {
    Plotly.newPlot('tsrDerivativePlot', [
      {
        x: tsr.timeSteps,
        y: tsr.tempSeries,
        name: 'T(t) deg C',
        type: 'scatter',
        mode: 'lines+markers',
        line: { color: '#f59e0b', width: 2 }
      },
      {
        x: tsr.timeSteps,
        y: tsr.firstDerivative,
        name: '1st Deriv (dT/dt)',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#38bdf8', dash: 'dot', width: 1.5 },
        yaxis: 'y2'
      },
      {
        x: tsr.timeSteps,
        y: tsr.secondDerivative,
        name: '2nd Deriv (d2T/dt2)',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#ec4899', dash: 'dash', width: 1.5 },
        yaxis: 'y2'
      }
    ], {
      margin: { t: 10, b: 25, l: 40, r: 40 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#94a3b8' },
      xaxis: { title: 'Frame Sequence Index (t)', color: '#64748b' },
      yaxis: { title: 'Temp (deg C)', color: '#f59e0b' },
      yaxis2: {
        title: 'Derivatives',
        color: '#38bdf8',
        overlaying: 'y',
        side: 'right'
      },
      legend: { orientation: 'h', y: 1.15 }
    });
  }
}
// --- PRINCIPAL COMPONENT THERMOGRAPHY (PCT) CONTROLLER ---
function runPctAnalysis() {
  const framesToProcess = selectedIndices.size >= 3 
    ? Array.from(selectedIndices).sort((a,b) => a - b).map(i => frameBuffer[i])
    : frameBuffer;

  if (framesToProcess.length < 3) {
    alert("PCT requires at least 3 temporal frames. Select frames from the gallery or stream data.");
    return;
  }

  const selectedMode = parseInt(document.getElementById("cfgPctMode")?.value) || 2;
  const palette = document.getElementById("cfgPctPalette")?.value || "Viridis";
  const pctResult = computePctModes(framesToProcess, 3);

  if (!pctResult) return;

  const modeIdx = Math.min(selectedMode - 1, pctResult.eofSpatialMaps.length - 1);
  const activeEof = pctResult.eofSpatialMaps[modeIdx];
  const activeVariance = pctResult.varianceRatios[modeIdx];

  // Update Variance Metric Readout
  const varLbl = document.getElementById("lblPctVariance");
  if (varLbl) varLbl.innerText = `${activeVariance.toFixed(2)} %`;

  // 1. Render Active EOF Spatial Map
  Plotly.newPlot('pctSpatialPlot', [{
    z: activeEof,
    type: 'heatmap',
    colorscale: palette,
    reversescale: palette === 'RdBu',
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>EOF Amplitude: %{z:.4f}<extra></extra>'
  }], {
    margin: { t: 5, b: 5, l: 25, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' }
  });

  // 2. Render Scree Spectrum Plot
  Plotly.newPlot('pctScreePlot', [{
    x: pctResult.varianceRatios.map((_, i) => `EOF ${i + 1}`),
    y: pctResult.varianceRatios,
    type: 'bar',
    marker: {
      color: pctResult.varianceRatios.map((_, i) => i === modeIdx ? '#38bdf8' : '#334155')
    }
  }], {
    margin: { t: 15, b: 30, l: 35, r: 10 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'Principal Component', color: '#64748b' },
    yaxis: { title: 'Variance Explained (%)', color: '#64748b' }
  });
}
// --- RADIOMETRIC PLANCK RE-CALIBRATION ---
function applyPlanckRecalibration(matrix, targetEmissivity = 0.95, reflTempC = 20.0, baseEmissivity = 0.95) {
  const eps = Math.max(0.05, Math.min(1.0, parseFloat(targetEmissivity)));
  const eps_base = Math.max(0.05, Math.min(1.0, parseFloat(baseEmissivity)));
  const T_refl_K4 = Math.pow(parseFloat(reflTempC) + 273.15, 4);

  return matrix.map(row => row.map(tempC => {
    const T_raw_K4 = Math.pow(tempC + 273.15, 4);
    
    // Stefan-Boltzmann radiometric energy balance
    const W_tot = eps_base * T_raw_K4 + (1.0 - eps_base) * T_refl_K4;
    const W_obj = (W_tot - (1.0 - eps) * T_refl_K4) / eps;
    
    const T_corrected_K = Math.pow(Math.max(0, W_obj), 0.25);
    return parseFloat((T_corrected_K - 273.15).toFixed(2));
  }));
}


window.onload = initDatabase;