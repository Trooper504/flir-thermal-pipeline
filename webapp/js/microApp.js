// --- webapp/js/microApp.js ---
// UI + Plotly orchestration for the Sub-Millimetre Particle & Thermal Dynamics Studio.
// All numerical work lives in microEngine.js (validated separately).

let microDb = null;
let microFrames = [];
let microActiveIdx = null;
let microAnchor = { x: 0, y: 0 };
let microRoi = null;
let microMaxArrows = 140;

const MICRO_ROI_SHAPE_TAG = 'micro-roi';

// --- INDEXEDDB (same database/store as the main workbench) ---
function initMicroDatabase() {
  const request = indexedDB.open('FlirThermalPipelineDB', 1);
  request.onupgradeneeded = function (e) {
    microDb = e.target.result;
    if (!microDb.objectStoreNames.contains('frames')) {
      microDb.createObjectStore('frames', { keyPath: 'id' });
    }
  };
  request.onsuccess = function (e) {
    microDb = e.target.result;
    loadMicroFrames();
  };
  request.onerror = function () {
    setMicroStatus('IndexedDB unavailable - use CSV import or the demo matrix');
  };
}

function loadMicroFrames() {
  if (!microDb) return;
  const tx = microDb.transaction('frames', 'readonly');
  const request = tx.objectStore('frames').getAll();
  request.onsuccess = function () {
    microFrames = (request.result || []).map(f => {
      f.calibratedMatrix = f.calibratedMatrix || f.rawMatrix;
      return f;
    });
    populateMicroFrameSelect();
    setMicroStatus(microFrames.length
      ? `${microFrames.length} stored frame(s) available`
      : 'No stored frames - import a CSV or load the demo matrix');
    if (microFrames.length) selectMicroFrame(0);
  };
}

function populateMicroFrameSelect() {
  const select = document.getElementById('microFrameSelect');
  if (!select) return;
  select.innerHTML = microFrames
    .map((f, i) => `<option value="${i}">${f.timestamp || 'frame ' + (i + 1)}</option>`)
    .join('');
}

function selectMicroFrame(idx) {
  const frame = microFrames[idx];
  if (!frame) return;
  microActiveIdx = idx;

  const matrix = frame.calibratedMatrix;
  const height = matrix.length;
  const width = matrix[0].length;

  // Default anchor: centre of the frame, then clamp into range
  microAnchor = { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  // Keep a sensible default ROI inside the frame
  const wInput = document.getElementById('microRoiW');
  const hInput = document.getElementById('microRoiH');
  if (wInput && parseInt(wInput.value, 10) > width) wInput.value = Math.min(4, width);
  if (hInput && parseInt(hInput.value, 10) > height) hInput.value = Math.min(5, height);

  recomputeMicroAnalysis();
}

function handleMicroFrameChange(event) {
  selectMicroFrame(parseInt(event.target.value, 10) || 0);
}

function getActiveMicroMatrix() {
  const frame = microFrames[microActiveIdx];
  return frame ? frame.calibratedMatrix : null;
}

function setMicroStatus(text) {
  const el = document.getElementById('microStatus');
  if (el) el.innerText = text;
}

function microRoiParams() {
  return {
    width: parseInt(document.getElementById('microRoiW')?.value, 10) || 4,
    height: parseInt(document.getElementById('microRoiH')?.value, 10) || 5,
    geometry: document.getElementById('microRoiGeometry')?.value || 'rect'
  };
}

/** Preset buttons: 2x3, 4x4, 4x5, 20x20 ... */
function applyMicroRoiPreset(width, height) {
  const wInput = document.getElementById('microRoiW');
  const hInput = document.getElementById('microRoiH');
  if (wInput) wInput.value = width;
  if (hInput) hInput.value = height;
  recomputeMicroAnalysis();
}

function setMicroAnchorFromInputs() {
  const x = parseInt(document.getElementById('microAnchorX')?.value, 10);
  const y = parseInt(document.getElementById('microAnchorY')?.value, 10);
  const matrix = getActiveMicroMatrix();
  if (!matrix) return;
  microAnchor = {
    x: Math.max(0, Math.min(matrix[0].length - 1, isNaN(x) ? microAnchor.x : x)),
    y: Math.max(0, Math.min(matrix.length - 1, isNaN(y) ? microAnchor.y : y))
  };
  recomputeMicroAnalysis();
}

function syncMicroAnchorInputs() {
  const xInput = document.getElementById('microAnchorX');
  const yInput = document.getElementById('microAnchorY');
  if (xInput) xInput.value = microAnchor.x;
  if (yInput) yInput.value = microAnchor.y;
}

// --- CORE ANALYSIS PIPELINE ---
let microAnalysis = null;

function microContrastPercentiles() {
  const low = parseFloat(document.getElementById('microLowPct')?.value);
  const high = parseFloat(document.getElementById('microHighPct')?.value);
  return {
    low: isNaN(low) ? 2 : Math.max(0, Math.min(50, low)),
    high: isNaN(high) ? 98 : Math.max(50, Math.min(100, high))
  };
}

function recomputeMicroAnalysis() {
  const matrix = getActiveMicroMatrix();
  if (!matrix) return;

  const params = microRoiParams();
  microRoi = applyDynamicRoiAtPoint(matrix, microAnchor.x, microAnchor.y,
    params.width, params.height, params.geometry);
  if (!microRoi) {
    setMicroStatus('ROI could not be derived from the current anchor/size');
    return;
  }

  syncMicroAnchorInputs();

  const { patch, mask, bounds } = microRoi;
  const pct = microContrastPercentiles();
  const stats = computePatchStatistics(patch, mask);
  const centroidLocal = computeThermalCentroid(patch, mask);
  const centroid = centroidLocal
    ? Object.assign(toAbsolutePoint(centroidLocal, bounds), {
        localX: centroidLocal.x,
        localY: centroidLocal.y,
        weightSum: centroidLocal.weightSum,
        floorTemp: centroidLocal.floorTemp
      })
    : null;

  microAnalysis = {
    matrix,
    patch,
    mask,
    bounds,
    geometry: microRoi.geometry,
    stats,
    centroid,
    contrast: computeContrastBounds(patch, mask, pct.low, pct.high),
    frameContrast: computeContrastBounds(matrix, null, pct.low, pct.high),
    flux: computeFluxField(patch),
    divergence: computeDivergenceField(patch)
  };

  renderMicroPlots();
  updateMicroReadouts();
}

// --- RENDERING ---
function renderMicroPlots() {
  if (!microAnalysis) return;
  const { matrix, patch, bounds, geometry, contrast, frameContrast, flux, divergence } = microAnalysis;

  const clipToRoi = (document.getElementById('microContrastSource')?.value || 'roi') === 'roi';
  const clip = clipToRoi ? contrast : frameContrast;
  const palette = document.getElementById('microPalette')?.value || 'YlOrRd';

  // 1. Full-frame thermogram with the ROI outlined. zsmooth:false keeps single-pixel
  //    particles as hard blocks instead of bilinear-blurring them into neighbours.
  Plotly.newPlot('microHeatmap', [{
    z: matrix,
    type: 'heatmap',
    zsmooth: false,
    colorscale: palette,
    zmin: clip ? clip.min : undefined,
    zmax: clip ? clip.max : undefined,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>T: %{z:.2f} \u00B0C<extra></extra>'
  }], {
    margin: { t: 5, b: 25, l: 30, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'Pixel X', color: '#64748b', gridcolor: '#1e293b' },
    yaxis: { title: 'Pixel Y', color: '#64748b', gridcolor: '#1e293b' },
    shapes: [{
      type: geometry === 'ellipse' ? 'circle' : 'rect',
      x0: bounds.x0 - 0.5, y0: bounds.y0 - 0.5, x1: bounds.x1 + 0.5, y1: bounds.y1 + 0.5,
      line: { color: '#38bdf8', width: 1.5, dash: 'dot' },
      fillcolor: 'rgba(56, 189, 248, 0.08)',
      name: MICRO_ROI_SHAPE_TAG
    }]
  }, {
    // Free-hand ROI: expose Plotly's draw tools so plotly_relayout can pick up the
    // operator's rectangle / circle and translate it into the W x H inputs.
    modeBarButtonsToAdd: ['drawrect', 'drawcircle', 'eraseshape'],
    newshape: { line: { color: '#38bdf8', width: 2, dash: 'dot' }, fillcolor: 'rgba(56, 189, 248, 0.08)' },
    displaylogo: false,
    responsive: true
  });

  // 2. 3D micro-topography of the isolated patch, aspect-ratio matched to W x H
  const surface = buildSurfaceZ(patch, document.getElementById('microSurfaceScale')?.value || 'linear');
  const aspect = computeAspectRatio(bounds.width, bounds.height);

  Plotly.newPlot('microSurface', [{
    z: surface.z,
    text: surface.text,
    customdata: surface.customdata,
    type: 'surface',
    colorscale: palette,
    cmin: surface.cmin,
    cmax: surface.cmax,
    contours: { z: { show: true, usecolormap: true, highlightcolor: '#e2e8f0', project: { z: true } } },
    hovertemplate: surface.hovertemplate
  }], {
    margin: { t: 5, b: 5, l: 5, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    scene: {
      xaxis: { title: 'X', color: '#64748b', gridcolor: '#1e293b' },
      yaxis: { title: 'Y', color: '#64748b', gridcolor: '#1e293b' },
      zaxis: { title: surface.title, color: '#64748b', gridcolor: '#1e293b', range: surface.range },
      aspectratio: aspect
    }
  });

  // 3. Flux quiver: -gradT arrows over the patch, opacity scaled by |q|
  const stride = computeQuiverStride(bounds.width, bounds.height, microMaxArrows);
  const arrows = buildQuiverAnnotations(flux, { x0: 0, y0: 0 }, { stride, yAxisReversed: false });
  const patchContrast = computeContrastBounds(patch, null, 2, 98);

  Plotly.newPlot('microQuiver', [{
    z: patch,
    type: 'heatmap',
    zsmooth: false,
    colorscale: palette,
    zmin: patchContrast ? patchContrast.min : undefined,
    zmax: patchContrast ? patchContrast.max : undefined,
    hoverinfo: 'skip',
    showscale: false
  }], {
    margin: { t: 5, b: 25, l: 30, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'Pixel X', color: '#64748b', gridcolor: '#1e293b', range: [-0.5, bounds.width - 0.5] },
    yaxis: { title: 'Pixel Y', color: '#64748b', gridcolor: '#1e293b', range: [-0.5, bounds.height - 0.5] },
    annotations: arrows
  });

  // 4. Divergence map: red = source, blue = sink, colour centre pinned to zero
  let absMax = 0;
  divergence.divergence.forEach(row => row.forEach(v => { if (Math.abs(v) > absMax) absMax = Math.abs(v); }));

  Plotly.newPlot('microDivergence', [{
    z: divergence.divergence,
    type: 'heatmap',
    zsmooth: false,
    colorscale: 'RdBu',
    reversescale: true,
    zmid: 0,
    zmin: -absMax,
    zmax: absMax,
    colorbar: { title: { text: 'div q', font: { color: '#94a3b8' } }, tickfont: { color: '#94a3b8' } },
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>div q: %{z:.3f}<extra></extra>'
  }], {
    margin: { t: 5, b: 25, l: 30, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'Pixel X', color: '#64748b', gridcolor: '#1e293b' },
    yaxis: { title: 'Pixel Y', color: '#64748b', gridcolor: '#1e293b' }
  });

  // Click-to-anchor plus drawn-shape ROI binding (idempotent across renders)
  setupMicroPointPicker('microHeatmap');
}

// --- READOUTS ---
function updateMicroReadouts() {
  if (!microAnalysis) return;
  const { bounds, geometry, stats, centroid, contrast, divergence, flux, patch } = microAnalysis;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.innerText = value; };

  set('microRoiLabel', `${bounds.width} x ${bounds.height} px @ [${bounds.x0}..${bounds.x1}] x [${bounds.y0}..${bounds.y1}] ${geometry}${bounds.clamped ? ' (edge-clamped)' : ''}`);
  set('microStatMin', `${stats.min.toFixed(2)} \u00B0C`);
  set('microStatMax', `${stats.max.toFixed(2)} \u00B0C`);
  set('microStatMean', `${stats.mean.toFixed(2)} \u00B0C`);
  set('microStatMedian', `${stats.median.toFixed(2)} \u00B0C`);
  set('microStatMad', `${stats.mad.toFixed(3)} \u00B0C`);
  set('microStatRobustStd', `${stats.robustStd.toFixed(3)} \u00B0C`);
  set('microStatDeltaT', `${stats.deltaT.toFixed(2)} \u00B0C`);
  set('microStatPixelCount', `${stats.pixelCount} px`);
  set('microClipInfo', contrast
    ? `p${contrast.lowPct}-p${contrast.highPct}: [${contrast.min.toFixed(2)}, ${contrast.max.toFixed(2)}] \u00B0C (raw [${contrast.rawMin.toFixed(2)}, ${contrast.rawMax.toFixed(2)}])`
    : '--');

  set('microCentroid', centroid
    ? `(${centroid.x.toFixed(3)}, ${centroid.y.toFixed(3)}) abs px`
    : 'isothermal patch');
  set('microCentroidLocal', centroid
    ? `(${centroid.localX.toFixed(3)}, ${centroid.localY.toFixed(3)}) patch-local`
    : '--');

  const summary = divergence.summary;
  set('microDivMaxSource', `${summary.maxSource.toFixed(3)}${summary.maxSourceAt ? ` @ (${summary.maxSourceAt.x}, ${summary.maxSourceAt.y})` : ''}`);
  set('microDivMaxSink', `${summary.maxSink.toFixed(3)}${summary.maxSinkAt ? ` @ (${summary.maxSinkAt.x}, ${summary.maxSinkAt.y})` : ''}`);
  set('microDivNet', summary.net.toFixed(3));

  let peak = 0;
  flux.magnitude.forEach(row => row.forEach(v => { if (v > peak) peak = v; }));
  set('microFluxPeak', peak.toFixed(3));

  setMicroStatus(`${patch.length} x ${patch[0].length} patch analysed (${stats.pixelCount} px)`);
}

// --- INTERACTION: CLICK TO ANCHOR, DRAW TO DEFINE THE ROI ---
function setupMicroPointPicker(divId = 'microHeatmap') {
  const plotDiv = document.getElementById(divId);
  if (!plotDiv || typeof plotDiv.on !== 'function') return;

  if (typeof plotDiv.removeAllListeners === 'function') {
    plotDiv.removeAllListeners('plotly_click');
    plotDiv.removeAllListeners('plotly_relayout');
  }

  plotDiv.on('plotly_click', function (data) {
    if (!data || !data.points || !data.points.length) return;
    const pt = data.points[0];
    if (pt.x === undefined || pt.y === undefined) return;

    const matrix = getActiveMicroMatrix();
    if (!matrix) return;

    const xInput = document.getElementById('microAnchorX');
    const yInput = document.getElementById('microAnchorY');
    if (xInput) xInput.value = Math.round(pt.x);
    if (yInput) yInput.value = Math.round(pt.y);
    setMicroAnchorFromInputs();
  });

  // Free-hand ROI: read rectangles/circles drawn with the Plotly modebar draw tools
  plotDiv.on('plotly_relayout', function (eventData) {
    if (!eventData) return;
    const shapes = eventData.shapes;
    if (shapes && shapes.length) return;   // shapes array replaced wholesale: ignore

    const keys = Object.keys(eventData);
    const isDraw = keys.some(k => /^shapes\[\d+\]\.(x0|x1|y0|y1|type|path)$/.test(k));
    if (!isDraw) return;

    const collect = prop => {
      const key = keys.find(k => k.endsWith('.' + prop));
      return key ? Number(eventData[key]) : NaN;
    };
    const x0 = collect('x0');
    const x1 = collect('x1');
    const y0 = collect('y0');
    const y1 = collect('y1');
    if ([x0, x1, y0, y1].some(v => !isFinite(v))) return;

    const width = Math.max(1, Math.round(Math.abs(x1 - x0)));
    const height = Math.max(1, Math.round(Math.abs(y1 - y0)));
    const shapeType = keys.some(k => eventData[k] === 'circle') ? 'ellipse' : 'rect';

    const wInput = document.getElementById('microRoiW');
    const hInput = document.getElementById('microRoiH');
    const gInput = document.getElementById('microRoiGeometry');
    if (wInput) wInput.value = width;
    if (hInput) hInput.value = height;
    if (gInput) gInput.value = shapeType;

    microAnchor = {
      x: Math.round((x0 + x1) / 2),
      y: Math.round((y0 + y1) / 2)
    };
    recomputeMicroAnalysis();

    // Clear the operator's scratch shape: the ROI overlay is redrawn by the renderer
    Plotly.relayout(divId, { shapes: [] });
    setMicroStatus(`ROI taken from drawn ${shapeType} (${width} x ${height} px)`);
  });
}

// --- EXPORT ENGINE (client-side Blob downloads, no server round-trip) ---
function microExportPayload() {
  if (!microAnalysis) return null;
  const { matrix, patch, bounds, geometry, stats, centroid, contrast, flux, divergence } = microAnalysis;

  let peak = 0;
  flux.magnitude.forEach(row => row.forEach(v => { if (v > peak) peak = v; }));
  const frame = microFrames[microActiveIdx];

  return {
    matrix: patch.map(row => row.slice()),
    divergence: divergence.divergence.map(row => row.slice()),
    bounds,
    geometry,
    stats,
    centroid,
    contrast,
    divergenceSummary: divergence.summary,
    fluxSummary: { peakMagnitude: peak, note: 'q = -k*gradT with k = 1 (relative units)' },
    sensorWidth: matrix[0].length,
    sensorHeight: matrix.length,
    sourceLabel: frame ? frame.timestamp : 'unsaved source',
    timestamp: new Date().toISOString()
  };
}

function triggerMicroDownload(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMicroCsv() {
  const payload = microExportPayload();
  if (!payload) { setMicroStatus('Nothing to export - analyse a patch first'); return; }

  const stamp = payload.timestamp.replace(/[:.]/g, '-');
  triggerMicroDownload(`flir_micro_patch_${stamp}.csv`, buildMicroCsv(payload), 'text/csv;charset=utf-8');
  setMicroStatus(`CSV exported (${payload.bounds.width} x ${payload.bounds.height} patch)`);
}

function exportMicroJson() {
  const payload = microExportPayload();
  if (!payload) { setMicroStatus('Nothing to export - analyse a patch first'); return; }

  const stamp = payload.timestamp.replace(/[:.]/g, '-');
  triggerMicroDownload(`flir_micro_patch_${stamp}.json`,
    JSON.stringify(buildMicroJson(payload), null, 2), 'application/json;charset=utf-8');
  setMicroStatus(`JSON exported (${payload.bounds.width} x ${payload.bounds.height} patch)`);
}

// --- SOURCES: CSV FILES AND A SYNTHETIC PARTICLE CLUSTER ---
async function handleMicroCsvUpload(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  for (const file of files) {
    const text = await file.text();
    const matrix = parseFlirCsvText(text);      // shared strict FLIR parser
    if (matrix && matrix.length) {
      microFrames.push({
        id: microFrames.length,
        timestamp: file.name,
        rawMatrix: matrix,
        calibratedMatrix: matrix,
        width: matrix[0].length,
        height: matrix.length
      });
    }
  }

  populateMicroFrameSelect();
  selectMicroFrame(microFrames.length - 1);
  setMicroStatus(`${files.length} CSV patch(es) imported`);
}

/** Synthetic sub-millimetre particle cluster: 1 px core + 4 px skirt on a cool bias. */
function loadMicroDemoMatrix() {
  const width = 80, height = 60;
  const matrix = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => 24 + 0.02 * x - 0.015 * y));

  const plant = (cx, cy, peak, radius) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        matrix[y][x] += peak * Math.exp(-r2 / (2 * radius * radius));
      }
    }
  };

  plant(40, 30, 26, 0.85);    // 1-2 px particle: sharper than the pixel pitch
  plant(58, 22, 14, 1.6);     // slightly larger cluster
  plant(24, 44, 9, 2.4);      // diffuse warm region
  matrix[30][40] += 6;        // single-pixel hot spot for zsmooth verification

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) matrix[y][x] = Math.round(matrix[y][x] * 100) / 100;
  }

  microFrames.push({
    id: microFrames.length,
    timestamp: 'DEMO_micro_particles.jpg',
    rawMatrix: matrix,
    calibratedMatrix: matrix,
    width, height
  });

  populateMicroFrameSelect();
  selectMicroFrame(microFrames.length - 1);
  setMicroStatus('Demo particle cluster loaded (1 px core + skirt)');
}

window.onload = function () {
  initMicroDatabase();
};
