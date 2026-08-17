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
// --- COMPREHENSIVE STRUCTURED JSON REPORT EXPORTER ---
async function exportLabReportJSON() {
  if (activeInspectedIdx === null || !frameBuffer[activeInspectedIdx]) {
    alert("Select a frame from the gallery to generate a lab report.");
    return;
  }

  const frame = frameBuffer[activeInspectedIdx];
  const matrix = frame.calibratedMatrix;
  const rawMatrix = frame.rawMatrix;
  const sensitivity = parseFloat(document.getElementById("cfgHotspotSensitivity")?.value) || 2.0;
  const emissivity = parseFloat(document.getElementById("cfgEmissivity")?.value) || 0.95;
  const roi = detectHotspotROI(matrix, sensitivity);

  // 1. Differential Points
  const p1x = parseInt(document.getElementById("pt1X")?.value) || 0;
  const p1y = parseInt(document.getElementById("pt1Y")?.value) || 0;
  const p2x = parseInt(document.getElementById("pt2X")?.value) || 0;
  const p2y = parseInt(document.getElementById("pt2Y")?.value) || 0;
  const tempP1 = matrix[p1y] ? matrix[p1y][p1x] : 0;
  const tempP2 = matrix[p2y] ? matrix[p2y][p2x] : 0;
  const deltaT = Math.abs(tempP1 - tempP2);

  // 2. Isothermal Masking
  const isIsoEnabled = document.getElementById("chkEnableIso")?.checked || false;
  const isoMin = parseFloat(document.getElementById("isoMinTemp")?.value) || 33.0;
  const isoMax = parseFloat(document.getElementById("isoMaxTemp")?.value) || 35.0;
  const isoResult = isIsoEnabled ? computeIsothermMask(matrix, isoMin, isoMax) : null;

  // 3. ASTM Radiometric Atmosphere & Window Settings
  const isAstm = document.getElementById("chkEnableAstm")?.checked || false;
  const astmConfig = {
    enabled: isAstm,
    targetDistanceMeters: parseFloat(document.getElementById("cfgDistance")?.value) || 1.5,
    relativeHumidityPct: parseFloat(document.getElementById("cfgHumidity")?.value) || 50.0,
    atmosphericTempC: parseFloat(document.getElementById("cfgAtmTemp")?.value) || 20.0,
    reflectedTempC: parseFloat(document.getElementById("cfgReflTemp")?.value) || 20.0,
    windowTransmittance: parseFloat(document.getElementById("cfgWinTrans")?.value) || 1.0,
    windowTempC: parseFloat(document.getElementById("cfgWinTemp")?.value) || 20.0,
    calculatedAtmosphericTransmittance: frame.tau_atm || 1.0,
    totalOpticalGain: frame.total_opt_gain || 1.0
  };

  // 4. Adaptive Emissivity Zoning & Spatial Bilateral Filter Settings
  const isZoning = document.getElementById("chkEnableZoning")?.checked || false;
  const isBilateral = document.getElementById("chkEnableBilateral")?.checked || false;
  const filterConfig = {
    zoningEnabled: isZoning,
    activeZones: isZoning ? activeEmissivityZones : [],
    bilateralDenoisingEnabled: isBilateral,
    filterRadius: parseInt(document.getElementById("cfgFilterRadius")?.value) || 2,
    sigmaSpace: parseFloat(document.getElementById("cfgSigmaSpace")?.value) || 2.5,
    sigmaColor: parseFloat(document.getElementById("cfgSigmaColor")?.value) || 1.2
  };

  // 5. 1D Cross-Section Profile
  const sliceOrientation = document.getElementById("sliceOrientation")?.value || "horizontal";
  const sliceIndex = parseInt(document.getElementById("sliceIndex")?.value) || 0;
  const sliceData = sliceOrientation === "horizontal"
    ? (matrix[Math.min(matrix.length - 1, sliceIndex)] || [])
    : matrix.map(row => row[Math.min(row.length - 1, sliceIndex)]);

  // 6. Capture Base64 Visual Artifacts
  const safeCapture = async (elementId, w = 700, h = 450) => {
    try {
      const el = document.getElementById(elementId);
      if (el && el.data && el.data.length > 0) {
        return await Plotly.toImage(elementId, { format: 'png', width: w, height: h });
      }
    } catch (e) {
      console.warn(`Could not capture image for ${elementId}`, e);
    }
    return null;
  };

  const imageArtifacts = {
    radiometricHeatmapPng: await safeCapture('thermalPlot'),
    spatialGradientPng: await safeCapture('gradientPlot'),
    surfaceTopography3DPng: await safeCapture('surface3DPlot'),
    lineProfilePng: await safeCapture('lineProfilePlot', 700, 300),
    astmOffsetPng: isAstm ? await safeCapture('astmCorrectionPlot', 700, 300) : null,
    pptPhasePng: await safeCapture('pptPhasePlot'),
    pptAmplitudePng: await safeCapture('pptAmpPlot'),
    tsrDerivativesPng: await safeCapture('tsrDerivativePlot', 700, 350),
    pctSpatialModePng: await safeCapture('pctSpatialPlot'),
    pctScreeSpectrumPng: await safeCapture('pctScreePlot')
  };

  const fullReport = {
    reportMetadata: {
      generatedAt: new Date().toISOString(),
      softwareVersion: "FLIR Radiometric Analytical Platform v3.0",
      frameIdentifier: frame.timestamp,
      frameIndex: frame.id + 1,
      totalFramesInBuffer: frameBuffer.length
    },
    statisticalAnalysis: {
      minTemperatureC: parseFloat(roi.minTemp.toFixed(3)),
      maxTemperatureC: parseFloat(roi.peakTemp.toFixed(3)),
      meanTemperatureC: parseFloat(roi.meanTemp.toFixed(3)),
      standardDeviationSigma: parseFloat(roi.stdDev.toFixed(3)),
      hotspotIdentified: roi.hasHotspot,
      hotspotBoundingBox: roi.bbox,
      hotspotPeakCoordinate: roi.peakCoord
    },
    differentialAnalysis: {
      point1: { x: p1x, y: p1y, temperatureC: parseFloat(tempP1.toFixed(3)) },
      point2: { x: p2x, y: p2y, temperatureC: parseFloat(tempP2.toFixed(3)) },
      deltaTC: parseFloat(deltaT.toFixed(3))
    },
    isothermalMasking: {
      enabled: isIsoEnabled,
      temperatureRangeC: { min: isoMin, max: isoMax },
      matchedPixelCount: isoResult ? isoResult.matchCount : 0,
      surfaceAreaCoveragePct: isoResult ? parseFloat(isoResult.areaPercentage.toFixed(2)) : 0.0
    },
    crossSectionProfile: {
      orientation: sliceOrientation,
      index: sliceIndex,
      temperatureProfile: sliceData
    },
    radiometricPhysicsAndOptics: astmConfig,
    materialZoningAndFiltering: filterConfig,
    calibratedMatrixData: matrix,
    rawSensorMatrixData: rawMatrix,
    visualArtifacts: imageArtifacts
  };

  const blob = new Blob([JSON.stringify(fullReport, null, 2)], { type: "application/json" });
  const downloadLink = document.createElement("a");
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = `FLIR_Full_Diagnostic_Report_Frame_${frame.id + 1}_${Date.now()}.json`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
}

async function generatePrintableLabReport() {
  if (activeInspectedIdx === null || !frameBuffer[activeInspectedIdx]) {
    alert("Select a frame from the gallery to generate a lab report.");
    return;
  }

  const frame = frameBuffer[activeInspectedIdx];
  const matrix = frame.calibratedMatrix;
  const sensitivity = parseFloat(document.getElementById("cfgHotspotSensitivity")?.value) || 2.0;
  const emissivity = parseFloat(document.getElementById("cfgEmissivity")?.value) || 0.95;
  const roi = detectHotspotROI(matrix, sensitivity);

  const p1x = parseInt(document.getElementById("pt1X")?.value) || 0;
  const p1y = parseInt(document.getElementById("pt1Y")?.value) || 0;
  const p2x = parseInt(document.getElementById("pt2X")?.value) || 0;
  const p2y = parseInt(document.getElementById("pt2Y")?.value) || 0;
  const tempP1 = matrix[p1y] ? matrix[p1y][p1x] : 0;
  const tempP2 = matrix[p2y] ? matrix[p2y][p2x] : 0;
  const deltaT = Math.abs(tempP1 - tempP2);

  const isIsoEnabled = document.getElementById("chkEnableIso")?.checked || false;
  const isoMin = parseFloat(document.getElementById("isoMinTemp")?.value) || 33.0;
  const isoMax = parseFloat(document.getElementById("isoMaxTemp")?.value) || 35.0;
  const isoResult = isIsoEnabled ? computeIsothermMask(matrix, isoMin, isoMax) : null;

  const isAstm = document.getElementById("chkEnableAstm")?.checked || false;
  const isZoning = document.getElementById("chkEnableZoning")?.checked || false;
  const isBilateral = document.getElementById("chkEnableBilateral")?.checked || false;

  const safeCapture = async (elementId, w = 550, h = 350) => {
    try {
      const el = document.getElementById(elementId);
      if (el && el.data && el.data.length > 0) {
        return await Plotly.toImage(elementId, { format: 'png', width: w, height: h });
      }
    } catch (e) {
      console.warn(`Could not capture image for ${elementId}`, e);
    }
    return null;
  };

  // Capture all analytical views
  const [
    heatmapImg,
    gradImg,
    surfaceImg,
    lineImg,
    astmImg,
    pptPhaseImg,
    pptAmpImg,
    tsrImg,
    pctSpatialImg,
    pctScreeImg
  ] = await Promise.all([
    safeCapture('thermalPlot'),
    safeCapture('gradientPlot'),
    safeCapture('surface3DPlot'),
    safeCapture('lineProfilePlot', 550, 240),
    isAstm ? safeCapture('astmCorrectionPlot', 550, 240) : Promise.resolve(null),
    safeCapture('pptPhasePlot'),
    safeCapture('pptAmpPlot'),
    safeCapture('tsrDerivativePlot', 550, 260),
    safeCapture('pctSpatialPlot'),
    safeCapture('pctScreePlot')
  ]);

  const reportWindow = window.open('', '_blank');
  reportWindow.document.write(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>FLIR Full Research Diagnostic Report - Frame ${frame.id + 1}</title>
      <style>
        @page { size: A4; margin: 15mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #0f172a; background: #ffffff; margin: 0; padding: 10px; font-size: 11px; }
        .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f172a; padding-bottom: 8px; margin-bottom: 12px; }
        h1 { font-size: 16px; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; }
        h2 { font-size: 12px; margin: 14px 0 6px 0; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; text-transform: uppercase; color: #1e293b; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 4px; margin-bottom: 8px; }
        th, td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; }
        th { background: #f1f5f9; font-weight: 600; }
        .figure-card { border: 1px solid #cbd5e1; border-radius: 4px; padding: 6px; background: #f8fafc; page-break-inside: avoid; margin-bottom: 8px; }
        .figure-card h3 { font-size: 10px; margin: 0 0 4px 0; text-transform: uppercase; color: #475569; }
        .figure-card img { width: 100%; height: auto; display: block; border: 1px solid #e2e8f0; border-radius: 2px; }
        .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; background: #e2e8f0; }
        .page-break { page-break-before: always; }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1>FLIR Radiometric Diagnostic Lab Report</h1>
          <div style="color: #64748b; font-size: 10px;">Edge Ingestion, Multi-Parameter Calibration, Spatial Gradient & NDT Analysis</div>
        </div>
        <div style="text-align: right; font-family: monospace;">
          <div><strong>Frame:</strong> #${frame.id + 1} (${frame.timestamp})</div>
          <div><strong>Generated:</strong> ${new Date().toLocaleString()}</div>
        </div>
      </div>

      <!-- SECTION 1: STATISTICAL METRICS & DIFFERENTIAL POINT ANALYSIS -->
      <h2>1. Diagnostic Summary & Radiometric Physics</h2>
      <div class="grid-2">
        <table>
          <tr><th colspan="2">Statistical Temperature Field</th></tr>
          <tr><td>Scene Min Temperature</td><td><strong>${roi.minTemp.toFixed(2)} &deg;C</strong></td></tr>
          <tr><td>Scene Max Temperature (Peak)</td><td><strong>${roi.peakTemp.toFixed(2)} &deg;C</strong></td></tr>
          <tr><td>Scene Mean Temperature (&mu;)</td><td>${roi.meanTemp.toFixed(2)} &deg;C</td></tr>
          <tr><td>Standard Deviation (&sigma;)</td><td>${roi.stdDev.toFixed(2)} &deg;C</td></tr>
          <tr><td>Hotspot Threshold (&mu; + ${sensitivity}&sigma;)</td><td>${roi.threshold.toFixed(2)} &deg;C (${roi.hasHotspot ? 'HOTSPOT DETECTED' : 'NOMINAL'})</td></tr>
        </table>

        <table>
          <tr><th colspan="2">Differential Probe & Calibration Setup</th></tr>
          <tr><td>Point 1 (${p1x}, ${p1y})</td><td><strong>${tempP1.toFixed(2)} &deg;C</strong></td></tr>
          <tr><td>Point 2 (${p2x}, ${p2y})</td><td><strong>${tempP2.toFixed(2)} &deg;C</strong></td></tr>
          <tr><td>Differential Delta T (|P1 - P2|)</td><td><strong>${deltaT.toFixed(2)} &deg;C</strong></td></tr>
          <tr><td>Surface Baseline Emissivity (&epsilon;)</td><td>${emissivity}</td></tr>
          <tr><td>ASTM Atmospheric Correction</td><td>${isAstm ? `Active (&tau;_atm = ${(frame.tau_atm || 1.0).toFixed(3)})` : 'Disabled'}</td></tr>
        </table>
      </div>

      <!-- SECTION 2: CONFIGURATION DETAILS -->
      <div class="grid-3" style="font-size: 10px; margin-top: 4px;">
        <div class="figure-card">
          <h3>Isothermal Masking</h3>
          <div><strong>Status:</strong> ${isIsoEnabled ? 'Enabled' : 'Disabled'}</div>
          <div><strong>Band:</strong> ${isoMin.toFixed(1)} &deg;C &ndash; ${isoMax.toFixed(1)} &deg;C</div>
          <div><strong>Coverage:</strong> ${isoResult ? isoResult.areaPercentage.toFixed(2) : '0.00'}% (${isoResult ? isoResult.matchCount : 0} px)</div>
        </div>
        <div class="figure-card">
          <h3>Adaptive Emissivity Zoning</h3>
          <div><strong>Status:</strong> ${isZoning ? 'Active' : 'Disabled'}</div>
          <div><strong>Custom Zones:</strong> ${activeEmissivityZones.length} defined</div>
          <div><strong>Bilateral Filter:</strong> ${isBilateral ? 'Active (Denoised)' : 'Bypassed'}</div>
        </div>
        <div class="figure-card">
          <h3>1D Cross-Section Profile</h3>
          <div><strong>Orientation:</strong> ${document.getElementById("sliceOrientation")?.value || "horizontal"}</div>
          <div><strong>Slice Index:</strong> ${document.getElementById("sliceIndex")?.value || "0"}</div>
          <div><strong>Dimensions:</strong> ${matrix[0].length} &times; ${matrix.length} px</div>
        </div>
      </div>

      <!-- SECTION 3: 2D CANVASES & TOPOGRAPHY -->
      <h2>2. Spatial & Topographic Visualizations</h2>
      <div class="grid-2">
        <div class="figure-card">
          <h3>Radiometric Heatmap (&deg;C)</h3>
          ${heatmapImg ? `<img src="${heatmapImg}">` : '<div style="padding:40px;text-align:center;">Plot not rendered</div>'}
        </div>
        <div class="figure-card">
          <h3>Signed Spatial Thermal Gradient (dT &deg;C)</h3>
          ${gradImg ? `<img src="${gradImg}">` : '<div style="padding:40px;text-align:center;">Plot not rendered</div>'}
        </div>
      </div>

      <div class="grid-2">
        <div class="figure-card">
          <h3>3D Thermal Surface Topography</h3>
          ${surfaceImg ? `<img src="${surfaceImg}">` : '<div style="padding:40px;text-align:center;">Plot not rendered</div>'}
        </div>
        <div class="figure-card">
          <h3>1D Cross-Section Profile</h3>
          ${lineImg ? `<img src="${lineImg}">` : '<div style="padding:40px;text-align:center;">Plot not rendered</div>'}
        </div>
      </div>

      <!-- PAGE BREAK FOR ADVANCED RESEARCH MODULES -->
      <div class="page-break"></div>

      <div class="header">
        <div>
          <h1>Advanced NDT & Multi-Parameter Research Analysis</h1>
          <div style="color: #64748b; font-size: 10px;">Pulsed Phase Thermography (PPT), TSR Derivatives & PCT Modes</div>
        </div>
        <div style="text-align: right; font-family: monospace;">Frame #${frame.id + 1}</div>
      </div>

      <!-- SECTION 4: TEMPORAL NDT & TSR -->
      <h2>3. Temporal NDT (Pulsed Phase Thermography & TSR)</h2>
      <div class="grid-2">
        <div class="figure-card">
          <h3>PPT Phase Map (&phi; in Radians) &mdash; Subsurface Defect Isolation</h3>
          ${pptPhaseImg ? `<img src="${pptPhaseImg}">` : '<div style="padding:40px;text-align:center;color:#94a3b8;">Execute PPT module to populate</div>'}
        </div>
        <div class="figure-card">
          <h3>PPT Amplitude Map (A in Arbitrary Units)</h3>
          ${pptAmpImg ? `<img src="${pptAmpImg}">` : '<div style="padding:40px;text-align:center;color:#94a3b8;">Execute PPT module to populate</div>'}
        </div>
      </div>
      <div class="figure-card">
        <h3>TSR Point Profile & 1st/2nd Time Derivatives at P1 (Cooling Velocity & Inflection)</h3>
        ${tsrImg ? `<img src="${tsrImg}">` : '<div style="padding:20px;text-align:center;color:#94a3b8;">Execute PPT/TSR module to populate</div>'}
      </div>

      <!-- SECTION 5: PRINCIPAL COMPONENT THERMOGRAPHY (PCT) & ASTM CALIBRATION -->
      <h2>4. Principal Component Thermography (PCT) & ASTM Offset</h2>
      <div class="grid-2">
        <div class="figure-card">
          <h3>PCT Spatial Eigen-Surface Map (Active EOF Mode)</h3>
          ${pctSpatialImg ? `<img src="${pctSpatialImg}">` : '<div style="padding:40px;text-align:center;color:#94a3b8;">Execute PCT module to populate</div>'}
        </div>
        <div class="figure-card">
          <h3>Eigenvalue Spectrum (% Variance Explained)</h3>
          ${pctScreeImg ? `<img src="${pctScreeImg}">` : '<div style="padding:40px;text-align:center;color:#94a3b8;">Execute PCT module to populate</div>'}
        </div>
      </div>

      ${isAstm && astmImg ? `
      <div class="figure-card">
        <h3>ASTM Calibration Offset Map (&Delta;T = T_corrected - T_raw &deg;C)</h3>
        <img src="${astmImg}">
      </div>` : ''}

      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 500);
        };
      <\/script>
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