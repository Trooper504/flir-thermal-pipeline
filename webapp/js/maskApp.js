// --- webapp/js/maskApp.js ---
// UI + Plotly orchestration for the Global Polygonal Mask Studio.
// All geometry and statistics live in maskEngine.js (validated separately); this
// file only does DOM wiring, drawing capture, batch scheduling and downloads.

let maskDb = null;
let maskFrames = [];            // { label, matrix, origin }
let maskActiveIdx = null;
let maskDrawMode = true;        // Mask Mode: clicks draw vertices instead of panning
let maskAnalysis = null;        // { frame, matrix, roi, compatible, stats, contrast, ... }
let maskBatchRows = [];
let maskBatchRunning = false;
let maskBatchCancelRequested = false;
let maskShapeGuard = false;     // re-entrancy guard for plotly_relayout

// Phase 3 state storage: the single reusable cookie-cutter applied to every frame.
// Indexed as globalROI.mask[y - globalROI.bbox.y0][x - globalROI.bbox.x0].
window.globalROI = null;

const MASK_ROI_SHAPE_TAG = 'global-mask-roi';

// --- INDEXEDDB (same database/store as the main workbench and Micro Inspector) ---
function initMaskDatabase() {
  const request = indexedDB.open('FlirThermalPipelineDB', 1);
  request.onupgradeneeded = function (e) {
    maskDb = e.target.result;
    if (!maskDb.objectStoreNames.contains('frames')) {
      maskDb.createObjectStore('frames', { keyPath: 'id' });
    }
  };
  request.onsuccess = function (e) {
    maskDb = e.target.result;
    loadMaskFrames();
  };
  request.onerror = function () {
    setMaskStatus('IndexedDB unavailable - import CSV files or load the demo sequence');
    loadMaskDemoSequence();
  };
}

function loadMaskFrames() {
  if (!maskDb) return;
  const tx = maskDb.transaction('frames', 'readonly');
  const request = tx.objectStore('frames').getAll();
  request.onsuccess = function () {
    const stored = (request.result || [])
      .map(f => ({
        label: f.timestamp || `frame ${f.id}`,
        matrix: f.calibratedMatrix || f.rawMatrix,
        origin: 'indexeddb'
      }))
      .filter(f => f.matrix && f.matrix.length && f.matrix[0] && f.matrix[0].length);

    maskFrames = stored;
    populateMaskFrameSelect();

    if (maskFrames.length) {
      setMaskStatus(`${maskFrames.length} stored frame(s) available - draw a lasso to define the global mask`);
      selectMaskFrame(0);
    } else {
      setMaskStatus('No stored frames - loading the synthetic demo sequence');
      loadMaskDemoSequence();
    }
  };
}

function populateMaskFrameSelect() {
  const select = document.getElementById('maskFrameSelect');
  if (!select) return;
  select.innerHTML = maskFrames
    .map((f, i) => `<option value="${i}">${f.label}${f.origin === 'indexeddb' ? '' : ' (memory)'}</option>`)
    .join('');
}

function getActiveMaskMatrix() {
  const frame = maskFrames[maskActiveIdx];
  return frame ? frame.matrix : null;
}

function getActiveMaskFrame() {
  return maskFrames[maskActiveIdx] || null;
}

function setMaskStatus(text) {
  const el = document.getElementById('maskStatus');
  if (el) el.innerText = text;
}

function selectMaskFrame(idx) {
  if (!maskFrames[idx]) return;
  maskActiveIdx = idx;
  recomputeMaskAnalysis();
}

function handleMaskFrameChange(event) {
  selectMaskFrame(parseInt(event.target.value, 10) || 0);
}

// --- SOURCES: CSV IMPORTS AND A SYNTHETIC SEQUENCE ---
async function handleMaskCsvUpload(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  let imported = 0;
  for (const file of files) {
    const text = await file.text();
    const matrix = parseFlirCsvText(text);        // shared strict FLIR CSV parser
    if (matrix && matrix.length && matrix[0] && matrix[0].length) {
      maskFrames.push({ label: file.name, matrix, origin: 'csv' });
      imported += 1;
    }
  }

  if (!imported) {
    setMaskStatus('No usable numeric matrices found in the selected CSV file(s)');
    return;
  }

  populateMaskFrameSelect();
  selectMaskFrame(maskFrames.length - 1);
  setMaskStatus(`${imported} CSV frame(s) imported - ${maskFrames.length} frame(s) in the batch queue`);
}

/** Hardware-free sequence so the page is usable before any capture exists. */
function loadMaskDemoSequence(count = 12) {
  if (maskFrames.some(f => f.origin === 'demo')) {
    selectMaskFrame(maskFrames.findIndex(f => f.origin === 'demo'));
    return;
  }

  for (let i = 0; i < count; i++) {
    maskFrames.push({
      label: `DEMO_frame_${String(i + 1).padStart(2, '0')}`,
      matrix: generateMockThermalMatrix(60, 80),
      origin: 'demo'
    });
  }

  populateMaskFrameSelect();
  selectMaskFrame(maskFrames.length - count);
  setMaskStatus(`${count} synthetic demo frames loaded (80 x 60 px) - draw a lasso to define the mask`);
}

// --- MASK MODE: DRAWING A CLOSED POLYGON INSTEAD OF PANNING ---
// Layout default `dragmode: 'drawclosedpath'` is what stops an operator's drag from
// panning the heatmap; the modebar button below flips it back for inspection.
function updateMaskDrawModeUi() {
  const btn = document.getElementById('maskDrawModeBtn');
  if (btn) {
    btn.innerText = maskDrawMode ? 'MASK MODE: ON - drag to lasso' : 'MASK MODE: OFF - pan / zoom';
    btn.className = maskDrawMode
      ? 'px-3 py-1.5 rounded border border-fuchsia-700 bg-fuchsia-900/40 hover:bg-fuchsia-800/50 text-fuchsia-200 text-xs font-mono transition'
      : 'px-3 py-1.5 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono transition';
  }
  const hint = document.getElementById('maskDrawHint');
  if (hint) {
    hint.innerText = maskDrawMode
      ? 'Draw mode active: click-drag a closed lasso on the left thermogram (or use the rectangle tool). Panning is disabled.'
      : 'Draw mode off: the left thermogram pans and zooms normally. Switch Mask Mode on to draw a new polygon.';
  }
}

function toggleMaskDrawMode() {
  maskDrawMode = !maskDrawMode;
  const plotDiv = document.getElementById('maskHeatmap');
  if (plotDiv && typeof Plotly !== 'undefined' && plotDiv.layout) {
    Plotly.relayout('maskHeatmap', { dragmode: maskDrawMode ? 'drawclosedpath' : 'zoom' });
  }
  updateMaskDrawModeUi();
}

/**
 * plotly_relayout entry point. Both the incremental (`shapes[0].path`) and the
 * wholesale (`shapes: [...]`) event payloads are covered: the authoritative list is
 * read back from the plot's own layout, minus our own tagged overlay shape.
 */
function handleMaskRelayout(eventData) {
  if (!eventData || maskShapeGuard) return;

  const keys = Object.keys(eventData);
  const touchesShapes = keys.some(k => k === 'shapes' || /^shapes\[\d+\]\./.test(k));
  if (!touchesShapes) return;

  maskShapeGuard = true;
  try {
    if (consumeDrawnShapes()) return;

    // Fallback: the event carried the path but the layout was not re-read yet.
    const pathKey = keys.find(k => /^shapes\[\d+\]\.path$/.test(k));
    if (pathKey && typeof eventData[pathKey] === 'string' && eventData[pathKey].trim()) {
      applyDrawnPath(eventData[pathKey]);
      return;
    }
    applyDrawnRectFromEvent(eventData, keys);
  } finally {
    maskShapeGuard = false;
  }
}

/** Consumes the newest operator-drawn shape (anything not tagged as our overlay). */
function consumeDrawnShapes() {
  const plotDiv = document.getElementById('maskHeatmap');
  const shapes = plotDiv && plotDiv.layout && Array.isArray(plotDiv.layout.shapes)
    ? plotDiv.layout.shapes
    : [];
  const drawn = shapes.filter(s => s && String(s.name || '').indexOf(MASK_ROI_SHAPE_TAG) !== 0);
  if (!drawn.length) return false;

  const shape = drawn[drawn.length - 1];
  if (shape.type === 'path' && typeof shape.path === 'string' && shape.path.trim()) {
    applyDrawnPath(shape.path);
    return true;
  }

  const { x0, y0, x1, y1 } = shape;
  if ([x0, y0, x1, y1].every(v => isFinite(Number(v)))) {
    commitDrawnVertices(polygonFromRect(Number(x0), Number(y0), Number(x1), Number(y1)), 'plotly-drawrect');
    return true;
  }
  return false;
}

function applyDrawnRectFromEvent(eventData, keys) {
  const collect = prop => {
    const key = keys.find(k => k.endsWith('.' + prop));
    return key ? Number(eventData[key]) : NaN;
  };
  const x0 = collect('x0');
  const y0 = collect('y0');
  const x1 = collect('x1');
  const y1 = collect('y1');
  if (![x0, y0, x1, y1].every(v => isFinite(v))) return;

  commitDrawnVertices(polygonFromRect(x0, y0, x1, y1), 'plotly-drawrect');
}

/** SVG path -> integer vertices -> global mask. Also logs the data-space check. */
function applyDrawnPath(pathString) {
  const matrix = getActiveMaskMatrix();
  if (!matrix) {
    setMaskStatus('No frame loaded - nothing to mask');
    return;
  }

  const width = matrix[0].length;
  const height = matrix.length;
  const parsed = parseSvgPathToPoints(pathString);
  const space = verifyCoordinateSpace(parsed.points, width, height);

  // Phase 2 verification: confirm Plotly returned data-space (matrix) coordinates.
  console.log('[global-mask] drawclosedpath raw path:', pathString);
  console.log('[global-mask] parsed vertices:', parsed.points,
    '| closed:', parsed.closed, '| commands:', parsed.commands.join(','));
  console.log('[global-mask] coordinate-space check:', space,
    `| frame ${width} x ${height} px (W x H)`);

  if (space.suspectScreenSpace) {
    setMaskStatus('Drawn path lies outside the matrix for every vertex - Plotly returned screen-space pixels, no mask was created (see console)');
    return;
  }

  commitDrawnVertices(parsed.points, 'plotly-drawclosedpath');
}

/** Rasterises the polygon once and installs it as the reusable global mask. */
function commitDrawnVertices(points, source) {
  const frame = getActiveMaskFrame();
  const matrix = frame ? frame.matrix : null;
  if (!matrix) return;

  const roi = createGlobalRoi(points, matrix[0].length, matrix.length, {
    source,
    frameLabel: frame.label
  });

  if (!roi) {
    setMaskStatus('Polygon collapsed to fewer than 3 distinct whole pixels - draw a larger closed shape');
    return;
  }

  window.globalROI = roi;
  maskBatchRows = [];                 // a new mask invalidates the previous sweep
  renderMaskBatchTable();

  if (!roi.insideCount) {
    setMaskStatus('Polygon encloses no pixel centre - widen the shape (empty mask, nothing to measure)');
  } else {
    setMaskStatus(`Global mask ready: ${describeRoi(roi)}`);
  }

  recomputeMaskAnalysis();
}

// --- ANALYSIS & RENDERING ---
function maskPalette() {
  return document.getElementById('maskPalette')?.value || 'YlOrRd';
}

/** Applies the saved global mask to the selected frame (Phase 4, single frame). */
function recomputeMaskAnalysis() {
  const frame = getActiveMaskFrame();
  const matrix = frame ? frame.matrix : null;
  if (!matrix) return;

  const roi = window.globalROI;
  const compatible = roi ? isRoiCompatible(matrix, roi) : false;

  maskAnalysis = {
    frame,
    matrix,
    roi: roi || null,
    compatible,
    stats: compatible ? computeMaskedStatistics(matrix, roi) : null,
    contrast: compatible ? computeMaskedContrast(matrix, roi) : null,
    maskedMatrix: compatible ? maskedMatrixForDisplay(matrix, roi) : null,
    frameContrast: computeContrastBounds(matrix, null, 2, 98)
  };

  renderMaskStudio();
  updateMaskReadouts();

  if (roi && !compatible) {
    setMaskStatus(`Mask was drawn on a ${roi.matWidth} x ${roi.matHeight} px frame but this frame is `
      + `${matrix[0].length} x ${matrix.length} px - redraw the polygon on this frame`);
  }
}

/** Polygon outline as an SVG path string in data space (what Plotly draws). */
function roiShapePath(roi) {
  if (!roi || !roi.vertices || !roi.vertices.length) return null;
  return 'M ' + roi.vertices.map(v => `${v.x} ${v.y}`).join(' L ') + ' Z';
}

function renderMaskStudio() {
  if (!maskAnalysis) return;

  const { matrix, roi, compatible, contrast, maskedMatrix, frameContrast } = maskAnalysis;
  const palette = maskPalette();
  const shapes = [];

  if (roi && compatible) {
    shapes.push({
      type: 'path',
      path: roiShapePath(roi),
      line: { color: '#e879f9', width: 2 },
      fillcolor: 'rgba(232, 121, 249, 0.10)',
      name: MASK_ROI_SHAPE_TAG,
      editable: false,
      layer: 'above'
    });
    shapes.push({
      type: 'rect',
      x0: roi.bbox.x0 - 0.5, y0: roi.bbox.y0 - 0.5,
      x1: roi.bbox.x1 + 0.5, y1: roi.bbox.y1 + 0.5,
      line: { color: '#38bdf8', width: 1, dash: 'dot' },
      fillcolor: 'rgba(0, 0, 0, 0)',
      name: `${MASK_ROI_SHAPE_TAG}-bbox`,
      editable: false,
      layer: 'above'
    });
  }

  // 1. Full thermogram with the polygon and its bounding box overlaid.
  Plotly.newPlot('maskHeatmap', [{
    z: matrix,
    type: 'heatmap',
    zsmooth: false,
    colorscale: palette,
    zmin: frameContrast ? frameContrast.min : undefined,
    zmax: frameContrast ? frameContrast.max : undefined,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>T: %{z:.2f} \u00B0C<extra></extra>'
  }], {
    margin: { t: 5, b: 30, l: 40, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    // Phase 1: in Mask Mode a drag draws vertices instead of panning the plot.
    dragmode: maskDrawMode ? 'drawclosedpath' : 'zoom',
    xaxis: { title: 'Pixel X', color: '#64748b', gridcolor: '#1e293b' },
    yaxis: { title: 'Pixel Y', color: '#64748b', gridcolor: '#1e293b' },
    shapes
  }, {
    // Phase 1: expose Plotly's native closed-path lasso plus the rectangle fallback.
    modeBarButtonsToAdd: ['drawclosedpath', 'drawrect', 'eraseshape'],
    newshape: {
      line: { color: '#e879f9', width: 2 },
      fillcolor: 'rgba(232, 121, 249, 0.10)'
    },
    displaylogo: false,
    responsive: true
  });

  // 2. Cookie-cutter preview: masked pixels only, everything else transparent.
  Plotly.newPlot('maskCookie', [{
    z: maskedMatrix || matrix,
    type: 'heatmap',
    zsmooth: false,
    colorscale: palette,
    zmin: contrast ? contrast.min : (frameContrast ? frameContrast.min : undefined),
    zmax: contrast ? contrast.max : (frameContrast ? frameContrast.max : undefined),
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>T inside mask: %{z:.2f} \u00B0C<extra></extra>'
  }], {
    margin: { t: 5, b: 30, l: 40, r: 5 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    dragmode: 'pan',
    xaxis: { title: 'Pixel X', color: '#64748b', gridcolor: '#1e293b' },
    yaxis: { title: 'Pixel Y', color: '#64748b', gridcolor: '#1e293b' }
  }, { displaylogo: false, responsive: true });

  bindMaskDrawEvents();
}

/** plotly_relayout is the only event that carries a completed drawn shape. */
function bindMaskDrawEvents() {
  const plotDiv = document.getElementById('maskHeatmap');
  if (!plotDiv || typeof plotDiv.on !== 'function') return;
  if (typeof plotDiv.removeAllListeners === 'function') {
    plotDiv.removeAllListeners('plotly_relayout');
  }
  plotDiv.on('plotly_relayout', handleMaskRelayout);
}

function clearMaskRoi() {
  window.globalROI = null;
  maskBatchRows = [];
  renderMaskBatchTable();
  recomputeMaskAnalysis();
  setMaskStatus('Global mask cleared - draw a new closed polygon on the thermogram');
}

// --- READOUTS ---
function updateMaskReadouts() {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
  };

  const analysis = maskAnalysis;
  const frame = analysis ? analysis.frame : null;
  const matrix = analysis ? analysis.matrix : null;

  set('maskActiveFrame', frame && matrix
    ? `${frame.label} - ${matrix[0].length} x ${matrix.length} px (W x H)`
    : '--');

  const roi = analysis ? analysis.roi : null;
  if (!roi) {
    ['maskRoiLabel', 'maskBbox', 'maskPixelCount', 'maskCoverage', 'maskCoordinateSpace',
      'maskStatMax', 'maskStatMin', 'maskStatMean', 'maskStatMedian', 'maskStatMad',
      'maskStatRobustStd', 'maskStatSigma', 'maskStatDeltaT', 'maskStatPixelCount', 'maskClipInfo']
      .forEach(id => set(id, '--'));
    set('maskRoiLabel', 'No global mask - switch Mask Mode on and drag a closed lasso');
    return;
  }

  set('maskRoiLabel', describeRoi(roi));
  set('maskBbox', `${roi.bbox.width} x ${roi.bbox.height} px at [x ${roi.bbox.x0}..${roi.bbox.x1}] `
    + `x [y ${roi.bbox.y0}..${roi.bbox.y1}]${roi.bbox.clamped ? ' (edge-clamped)' : ''}`);
  set('maskPixelCount', `${roi.insideCount} px`);
  set('maskCoverage', `${roi.coverageOfBboxPercent.toFixed(1)}% of bbox / `
    + `${roi.coverageOfFramePercent.toFixed(1)}% of frame`);

  const space = verifyCoordinateSpace(roi.vertices, roi.matWidth, roi.matHeight);
  set('maskCoordinateSpace', space.suspectScreenSpace
    ? 'WARNING: every vertex lies outside the matrix (screen-space pixels?)'
    : `data space (matrix indices) - ${Math.round(space.insideFraction * 100)}% of `
      + `${roi.vertexCount} vertices inside ${roi.matWidth} x ${roi.matHeight} px`);

  const stats = analysis.stats;
  if (!analysis.compatible) {
    ['maskStatMax', 'maskStatMin', 'maskStatMean', 'maskStatMedian', 'maskStatMad',
      'maskStatRobustStd', 'maskStatSigma', 'maskStatDeltaT'].forEach(id => set(id, '--'));
    set('maskStatPixelCount', 'redraw on this frame');
    set('maskClipInfo', 'mask was rasterised on a different pixel grid');
    return;
  }

  if (!stats) {
    set('maskStatMax', 'empty mask');
    ['maskStatMin', 'maskStatMean', 'maskStatMedian', 'maskStatMad',
      'maskStatRobustStd', 'maskStatSigma', 'maskStatDeltaT'].forEach(id => set(id, '--'));
    set('maskStatPixelCount', '0 px');
    set('maskClipInfo', 'no pixel centre inside the polygon');
    return;
  }

  set('maskStatMax', `${stats.max.toFixed(2)} \u00B0C`);
  set('maskStatMin', `${stats.min.toFixed(2)} \u00B0C`);
  set('maskStatMean', `${stats.mean.toFixed(2)} \u00B0C`);
  set('maskStatMedian', `${stats.median.toFixed(2)} \u00B0C`);
  set('maskStatMad', `${stats.mad.toFixed(3)} \u00B0C`);
  set('maskStatRobustStd', `${stats.robustStd.toFixed(3)} \u00B0C`);
  set('maskStatSigma', `${stats.stdDev.toFixed(3)} \u00B0C`);
  set('maskStatDeltaT', `${stats.deltaT.toFixed(2)} \u00B0C`);
  set('maskStatPixelCount', `${stats.pixelCount} px`);

  const contrast = analysis.contrast;
  set('maskClipInfo', contrast
    ? `p${contrast.lowPct}-p${contrast.highPct} over masked pixels: `
      + `[${contrast.min.toFixed(2)}, ${contrast.max.toFixed(2)}] \u00B0C`
    : '--');
}

// --- BATCH AUTOMATION (one mask, N frames) ---
function setMaskProgress(done, total) {
  const bar = document.getElementById('maskProgressBar');
  const label = document.getElementById('maskProgressLabel');
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.innerText = `${done} / ${total} frame(s) - ${pct}%`;
}

/**
 * Phase 5: the polygon was rasterised once, so each frame only pays for the
 * cookie-cutter extraction. `await setTimeout(0)` per frame keeps the UI painting.
 */
async function runMaskBatch() {
  if (maskBatchRunning) return;

  const roi = window.globalROI;
  if (!roi || !roi.active) {
    setMaskStatus('Draw a global mask before running the batch sweep');
    return;
  }
  if (!maskFrames.length) {
    setMaskStatus('No frames in the batch queue - import CSV files or load the demo sequence');
    return;
  }

  maskBatchRunning = true;
  maskBatchCancelRequested = false;
  maskBatchRows = [];
  renderMaskBatchTable();

  const total = maskFrames.length;
  setMaskProgress(0, total);
  setMaskStatus(`Batch sweep started over ${total} frame(s)...`);

  let measured = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    if (maskBatchCancelRequested) break;

    const frame = maskFrames[i];
    let status = 'ok';
    let stats = null;

    if (!isRoiCompatible(frame.matrix, roi)) {
      status = 'dimension-mismatch';
    } else {
      stats = computeMaskedStatistics(frame.matrix, roi);
      if (!stats) status = 'empty-mask';
    }

    if (status === 'ok') measured += 1;
    else skipped += 1;

    maskBatchRows.push({ index: i, label: frame.label, status, stats });
    setMaskProgress(i + 1, total);
    renderMaskBatchTable();

    // Yield to the render thread so the progress bar actually paints.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  maskBatchRunning = false;
  const cancelled = maskBatchCancelRequested;
  maskBatchCancelRequested = false;

  setMaskStatus(`${cancelled ? 'Batch cancelled' : 'Batch complete'}: ${measured} frame(s) measured, `
    + `${skipped} skipped (empty mask or a different pixel grid) - export the time series below`);
}

function cancelMaskBatch() {
  if (!maskBatchRunning) {
    setMaskStatus('No batch sweep is running');
    return;
  }
  maskBatchCancelRequested = true;
  setMaskStatus('Cancelling the batch sweep...');
}

function escapeMaskHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMaskBatchTable() {
  const body = document.getElementById('maskBatchTableBody');
  if (!body) return;

  const count = document.getElementById('maskBatchCount');

  if (!maskBatchRows.length) {
    body.innerHTML = '<tr><td colspan="8" class="py-2 text-slate-500">'
      + 'No sweep yet - draw a mask and run the batch.</td></tr>';
    if (count) count.innerText = '0 rows';
    return;
  }

  const recent = maskBatchRows.slice(-10);
  body.innerHTML = recent.map(row => {
    const s = row.stats;
    const cells = s
      ? [s.max.toFixed(2), s.mean.toFixed(2), s.min.toFixed(2), s.median.toFixed(2), String(s.pixelCount)]
      : ['--', '--', '--', '--', '--'];
    const statusClass = row.status === 'ok' ? 'text-emerald-400' : 'text-amber-400';
    return `<tr class="border-t border-slate-800/70">
      <td class="py-1 pr-2 text-slate-500">${row.index}</td>
      <td class="py-1 pr-2 text-slate-300 truncate max-w-[15rem]">${escapeMaskHtml(row.label)}</td>
      <td class="py-1 pr-2 ${statusClass}">${row.status}</td>
      <td class="py-1 pr-2 text-right text-rose-300">${cells[0]}</td>
      <td class="py-1 pr-2 text-right text-slate-200">${cells[1]}</td>
      <td class="py-1 pr-2 text-right text-sky-300">${cells[2]}</td>
      <td class="py-1 pr-2 text-right text-slate-300">${cells[3]}</td>
      <td class="py-1 text-right text-slate-400">${cells[4]}</td>
    </tr>`;
  }).join('');

  if (count) {
    count.innerText = `${maskBatchRows.length} row(s)`
      + (maskBatchRows.length > recent.length ? ` - showing the last ${recent.length}` : '');
  }
}

// --- EXPORT ENGINE (client-side Blob downloads, no server round-trip) ---
function triggerMaskDownload(filename, text, mimeType) {
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

function maskExportPayload() {
  const analysis = maskAnalysis;
  const roi = window.globalROI;
  const frame = analysis ? analysis.frame : null;
  const matrix = analysis ? analysis.matrix : null;

  return {
    roi: roi || null,
    rows: maskBatchRows.slice(),
    stats: analysis ? analysis.stats : null,
    matrixWidth: matrix ? matrix[0].length : (roi ? roi.matWidth : null),
    matrixHeight: matrix ? matrix.length : (roi ? roi.matHeight : null),
    frameLabel: frame ? frame.label : null,
    includeMask: !!document.getElementById('maskIncludeMask')?.checked,
    generatedAt: new Date().toISOString()
  };
}

function exportMaskBatchCsv() {
  const payload = maskExportPayload();
  if (!payload.roi) {
    setMaskStatus('Nothing to export - draw a global mask first');
    return;
  }
  if (!payload.rows.length) {
    setMaskStatus('Nothing to export - run the batch sweep first');
    return;
  }

  const stamp = payload.generatedAt.replace(/[:.]/g, '-');
  triggerMaskDownload(`flir_global_mask_timeseries_${stamp}.csv`,
    buildMaskBatchCsv(payload), 'text/csv;charset=utf-8');
  setMaskStatus(`Batch CSV exported (${payload.rows.length} frame row(s))`);
}

function exportMaskJson() {
  const payload = maskExportPayload();
  if (!payload.roi) {
    setMaskStatus('Nothing to export - draw a global mask first');
    return;
  }

  const stamp = payload.generatedAt.replace(/[:.]/g, '-');
  triggerMaskDownload(`flir_global_mask_${stamp}.json`,
    JSON.stringify(buildMaskJson(payload), null, 2), 'application/json;charset=utf-8');
  setMaskStatus(payload.rows.length
    ? `JSON report exported (mask + ${payload.rows.length} batch row(s))`
    : 'JSON report exported (mask only - run the batch for a time series)');
}

window.onload = function () {
  updateMaskDrawModeUi();
  renderMaskBatchTable();
  setMaskProgress(0, 0);
  initMaskDatabase();
};
