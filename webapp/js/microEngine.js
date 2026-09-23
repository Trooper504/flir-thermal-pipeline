// --- webapp/js/microEngine.js ---
// Sub-millimetre particle & thermal-dynamics math for the Micro Inspector studio.
// DOM-free pure functions so the whole analysis path stays unit-testable.

// ============================================================================
// 1. LOCAL CONTRAST STRETCHING (PERCENTILE CLIPPING)
// ============================================================================

/** Flattens a matrix to an ascending numeric array (skips non-finite values). */
function sortedValues(matrix, mask = null) {
  const out = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (mask && !mask[y][x]) continue;
      const v = matrix[y][x];
      if (typeof v === "number" && isFinite(v)) out.push(v);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Linear-interpolated percentile (matches numpy.percentile's default method). */
function computePercentile(sortedAsc, pct) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/** Robust display bounds: percentiles instead of the full min/max range. */
function computeContrastBounds(matrix, mask = null, lowPct = 2, highPct = 98) {
  const sorted = sortedValues(matrix, mask);
  if (!sorted.length) return null;

  const min = computePercentile(sorted, lowPct);
  const max = computePercentile(sorted, highPct);
  return {
    min,
    max,
    rawMin: sorted[0],
    rawMax: sorted[sorted.length - 1],
    count: sorted.length,
    lowPct,
    highPct,
    isDegenerate: !(max > min)
  };
}

// ============================================================================
// 2. ARBITRARY DYNAMIC ROI (CENTER-ANCHORED SUB-MATRIX)
// ============================================================================

function normalizeGeometry(geometry) {
  return String(geometry).toLowerCase() === "ellipse" ? "ellipse" : "rect";
}

/** Center-anchored, edge-clamped bounding box around (cx, cy). */
function computeRoiBounds(cx, cy, width, height, matWidth, matHeight) {
  if (!(matWidth > 0) || !(matHeight > 0)) return null;

  const reqW = Math.max(1, Math.round(Number(width) || 1));
  const reqH = Math.max(1, Math.round(Number(height) || 1));
  const centerX = Math.max(0, Math.min(matWidth - 1, Math.round(Number(cx) || 0)));
  const centerY = Math.max(0, Math.min(matHeight - 1, Math.round(Number(cy) || 0)));

  let x0 = centerX - Math.floor((reqW - 1) / 2);
  let y0 = centerY - Math.floor((reqH - 1) / 2);
  let x1 = x0 + reqW - 1;
  let y1 = y0 + reqH - 1;

  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(matWidth - 1, x1);
  y1 = Math.min(matHeight - 1, y1);
  if (x1 < x0 || y1 < y0) return null;

  return {
    x0, y0, x1, y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    requestedWidth: reqW,
    requestedHeight: reqH,
    clamped: (x1 - x0 + 1) !== reqW || (y1 - y0 + 1) !== reqH
  };
}

function extractSubMatrix(matrix, bounds) {
  const patch = [];
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    const row = [];
    for (let x = bounds.x0; x <= bounds.x1; x++) row.push(matrix[y][x]);
    patch.push(row);
  }
  return patch;
}

/** Inscribed ellipse mask, or an all-true mask for the rectangular geometry. */
function buildRoiMask(width, height, geometry = "rect") {
  if (normalizeGeometry(geometry) === "rect") {
    return Array.from({ length: height }, () => new Array(width).fill(true));
  }

  const halfX = (width - 1) / 2;
  const halfY = (height - 1) / 2;
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const dx = halfX === 0 ? 0 : (x - halfX) / halfX;
      const dy = halfY === 0 ? 0 : (y - halfY) / halfY;
      return dx * dx + dy * dy <= 1.0 + 1e-9;
    }));
}

function applyDynamicRoiAtPoint(matrix, cx, cy, width, height, geometry = "rect") {
  if (!matrix || !matrix.length || !matrix[0]) return null;
  const bounds = computeRoiBounds(cx, cy, width, height, matrix[0].length, matrix.length);
  if (!bounds) return null;

  return {
    bounds,
    patch: extractSubMatrix(matrix, bounds),
    mask: buildRoiMask(bounds.width, bounds.height, geometry),
    geometry: normalizeGeometry(geometry)
  };
}

// ============================================================================
// 3. MICRO-SCALE STATISTICS & SUB-PIXEL THERMAL CENTROID
// ============================================================================

function computePatchStatistics(patch, mask = null) {
  const values = sortedValues(patch, mask);
  if (!values.length) return null;

  const n = values.length;
  const min = values[0];
  const max = values[n - 1];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const median = computePercentile(values, 50);

  const absDev = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = computePercentile(absDev, 50);
  const variance = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;

  return {
    min,
    max,
    mean,
    median,
    mad,
    robustStd: 1.4826 * mad,   // MAD scaled into a robust sigma estimate
    stdDev: Math.sqrt(variance),
    deltaT: max - min,         // defect contrast: peak vs local patch floor
    pixelCount: n
  };
}

/** Sub-pixel thermal centre of mass in patch-local coordinates (weights = contrast). */
function computeThermalCentroid(patch, mask = null) {
  const values = sortedValues(patch, mask);
  if (!values.length) return null;
  const floorTemp = values[0];

  let sumW = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < patch.length; y++) {
    for (let x = 0; x < patch[y].length; x++) {
      if (mask && !mask[y][x]) continue;
      const w = patch[y][x] - floorTemp;
      if (!(w > 0)) continue;
      sumW += w;
      sumX += x * w;
      sumY += y * w;
    }
  }
  if (!(sumW > 0)) return null;   // isothermal patch: no centre of generation

  return { x: sumX / sumW, y: sumY / sumW, weightSum: sumW, floorTemp };
}

/** Converts a patch-local point into absolute matrix coordinates. */
function toAbsolutePoint(localPoint, bounds) {
  return { x: localPoint.x + bounds.x0, y: localPoint.y + bounds.y0 };
}

// ============================================================================
// 4. DISCRETE FIELD OPERATORS (FOURIER FLUX -gradT AND ITS DIVERGENCE)
// ============================================================================

/** dT/dx per cell: central differences inside, one-sided at the x borders. */
function computeGradientX(patch) {
  const h = patch.length;
  const w = patch[0].length;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (w === 1) return 0;
      if (x === 0) return patch[y][1] - patch[y][0];
      if (x === w - 1) return patch[y][w - 1] - patch[y][w - 2];
      return (patch[y][x + 1] - patch[y][x - 1]) / 2;
    }));
}

/** dT/dy per cell: central differences inside, one-sided at the y borders. */
function computeGradientY(patch) {
  const h = patch.length;
  const w = patch[0].length;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (h === 1) return 0;
      if (y === 0) return patch[1][x] - patch[0][x];
      if (y === h - 1) return patch[h - 1][x] - patch[h - 2][x];
      return (patch[y + 1][x] - patch[y - 1][x]) / 2;
    }));
}

/**
 * Fourier's law: q = -k * gradT.
 * Units are relative (k = 1) unless a calibrated conductivity is supplied; the shown
 * magnitudes are only absolute once k and the true IFOV are known for the setup.
 */
function computeFluxField(patch, conductivity = 1.0) {
  const dTdx = computeGradientX(patch);
  const dTdy = computeGradientY(patch);
  const qx = dTdx.map(row => row.map(v => -conductivity * v));
  const qy = dTdy.map(row => row.map(v => -conductivity * v));
  const magnitude = qx.map((row, y) => row.map((v, x) => Math.hypot(v, qy[y][x])));
  return { dTdx, dTdy, qx, qy, magnitude, conductivity };
}

/**
 * Divergence of the heat flux from the 5-point cross stencil, i.e. the discrete
 * Laplacian:   lap = d2T/dx2 + d2T/dy2,   div(q) = -k * lap
 *
 * In the interior this is exactly T_left + T_right + T_up + T_down - 4*T_center.
 * At the patch borders a one-sided (forward/backward) second difference is used
 * instead: replicating the edge value would degrade the stencil into a first
 * difference and paint spurious sources/sinks along the rim of every ROI.
 * For an axis shorter than 3 px no curvature is resolvable, so that axis is 0.
 *
 * Positive = heat source, negative = heat sink.
 */
function computeDivergenceField(patch, conductivity = 1.0) {
  const h = patch.length;
  const w = patch[0].length;

  const secondX = (y, x) => {
    if (w < 3) return 0;
    if (x === 0) return patch[y][2] - 2 * patch[y][1] + patch[y][0];
    if (x === w - 1) return patch[y][w - 1] - 2 * patch[y][w - 2] + patch[y][w - 3];
    return patch[y][x + 1] - 2 * patch[y][x] + patch[y][x - 1];
  };

  const secondY = (y, x) => {
    if (h < 3) return 0;
    if (y === 0) return patch[2][x] - 2 * patch[1][x] + patch[0][x];
    if (y === h - 1) return patch[h - 1][x] - 2 * patch[h - 2][x] + patch[h - 3][x];
    return patch[y + 1][x] - 2 * patch[y][x] + patch[y - 1][x];
  };

  const laplacian = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => secondX(y, x) + secondY(y, x)));

  const divergence = laplacian.map(row => row.map(v => -conductivity * v));

  let maxSource = -Infinity, maxSink = Infinity, net = 0;
  let maxSourceAt = null, maxSinkAt = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = divergence[y][x];
      net += v;
      if (v > maxSource) { maxSource = v; maxSourceAt = { x, y }; }
      if (v < maxSink) { maxSink = v; maxSinkAt = { x, y }; }
    }
  }

  return {
    laplacian,
    divergence,
    summary: {
      maxSource: isFinite(maxSource) ? maxSource : 0,
      maxSink: isFinite(maxSink) ? maxSink : 0,
      net,
      maxSourceAt,
      maxSinkAt,
      cellCount: h * w,
      // Divergence theorem: the sum over a finite window equals the net flux through
      // its boundary, so it is exactly 0 for any locally linear field and non-zero
      // whenever the ROI clips a source or a sink.
      netInterpretation: 'net flux crossing the ROI boundary (relative units)'
    }
  };
}

/** Arrow stride that keeps the quiver plot readable for large patches. */
function computeQuiverStride(width, height, maxArrows = 120) {
  const cells = Math.max(1, width * height);
  return Math.max(1, Math.ceil(Math.sqrt(cells / Math.max(1, maxArrows))));
}

/**
 * Directional flux arrows as Plotly annotations: the tail sits on the pixel centre and
 * the head points along +q (the direction heat dissipates). Length and opacity both
 * scale with |q| so steep boundaries dominate and isothermal regions stay clean.
 * `ax`/`ay` are pixel offsets (screen space, +ay = down), hence the y sign flip.
 */
function buildQuiverAnnotations(flux, bounds, options = {}) {
  const {
    stride = 1,
    arrowLengthPx = 14,
    minAlpha = 0.08,
    maxAlpha = 0.95,
    maxArrows = 400,
    yAxisReversed = false
  } = options;

  const h = flux.magnitude.length;
  const w = flux.magnitude[0].length;
  const step = Math.max(1, Math.round(Number(stride) || 1));

  let peak = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (flux.magnitude[y][x] > peak) peak = flux.magnitude[y][x];
    }
  }
  if (!(peak > 0)) return [];

  const arrows = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const m = flux.magnitude[y][x];
      const rel = m / peak;
      if (!(rel > 0.002)) continue;

      const alpha = Math.min(maxAlpha, Math.max(minAlpha, minAlpha + rel * (maxAlpha - minAlpha)));
      const ux = (flux.qx[y][x] / m) || 0;
      const uy = (flux.qy[y][x] / m) || 0;
      const len = arrowLengthPx * rel;

      arrows.push({
        x: bounds.x0 + x,
        y: bounds.y0 + y,
        xref: 'x',
        yref: 'y',
        ax: ux * len,
        ay: (yAxisReversed ? uy : -uy) * len,
        axref: 'pixel',
        ayref: 'pixel',
        showarrow: true,
        arrowhead: 2,
        arrowsize: 0.7,
        arrowwidth: 1,
        text: '',
        arrowcolor: `rgba(226, 232, 240, ${alpha.toFixed(3)})`,
        name: 'micro-quiver'
      });
      if (arrows.length >= maxArrows) return arrows;
    }
  }
  return arrows;
}

// ============================================================================
// 5. 3D MICRO-TOPOGRAPHY SCALING
// ============================================================================

/** Geometric aspect ratio so non-square patches (2x3, 4x5) render undistorted. */
function computeAspectRatio(width, height) {
  const safeW = Math.max(1, Number(width) || 1);
  const safeH = Math.max(1, Number(height) || 1);
  return { x: 1, y: safeH / safeW, z: 0.4 };
}

function buildTextMatrix(patch) {
  return patch.map(row => row.map(v => (typeof v === 'number' ? v.toFixed(2) : '')));
}

/**
 * Vertical scaling for the 3D surface: direct degC, or shifted-log ln(1 + dT) to lift
 * faint micro-conduction gradients while compressing peak summits. The raw Celsius grid
 * always travels in `text` (and `customdata`) so tooltips never show log-space numbers.
 */
function buildSurfaceZ(patch, mode = "linear") {
  const values = sortedValues(patch);
  if (!values.length) return null;
  const frameMin = values[0];
  const frameMax = values[values.length - 1];

  if (String(mode).toLowerCase() === "log") {
    const z = patch.map(row => row.map(v => Math.log1p(Math.max(0, v - frameMin))));
    let maxLog = 0;
    z.forEach(row => row.forEach(v => { if (v > maxLog) maxLog = v; }));
    return {
      z,
      text: buildTextMatrix(patch),
      customdata: patch,
      mode: 'log',
      title: 'ln(1 + \u0394T)',
      range: [0, maxLog],
      cmin: 0,
      cmax: maxLog,
      frameMin,
      frameMax,
      hovertemplate: 'X: %{x}<br>Y: %{y}<br>T: %{text} \u00B0C<br>ln(1+\u0394T): %{z:.3f}<extra></extra>'
    };
  }

  return {
    z: patch.map(row => row.slice()),
    text: buildTextMatrix(patch),
    customdata: patch,
    mode: 'linear',
    title: 'Temp (\u00B0C)',
    range: [frameMin, frameMax],
    cmin: frameMin,
    cmax: frameMax,
    frameMin,
    frameMax,
    hovertemplate: 'X: %{x}<br>Y: %{y}<br>T: %{text} \u00B0C<extra></extra>'
  };
}

// ============================================================================
// 6. MULTI-MODAL EXPORT BUILDERS (CSV + JSON)
// ============================================================================

const MICRO_TEMP_BLOCK = '[CALIBRATED_TEMPERATURE_MATRIX_DEG_C]';
const MICRO_DIVERGENCE_BLOCK = '[HEAT_FLUX_DIVERGENCE_MATRIX_RELATIVE_UNITS]';

function formatMatrixBlock(matrix, digits = 3) {
  return matrix
    .map(row => row.map(v => (typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '')).join(','))
    .join('\n');
}

function buildMicroCsv(payload) {
  const {
    matrix, divergence, bounds, geometry, stats, centroid,
    divergenceSummary, contrast, timestamp, sourceLabel
  } = payload;

  const lines = [];
  lines.push('# FLIR E8-XT MICRO-PATCH ANALYSIS');
  lines.push(`# Generated: ${timestamp || new Date().toISOString()}`);
  if (sourceLabel) lines.push(`# Source frame: ${sourceLabel}`);
  lines.push(`# ROI: ${bounds.width} x ${bounds.height} px at [x ${bounds.x0}..${bounds.x1}] x [y ${bounds.y0}..${bounds.y1}]`);
  lines.push(`# Requested: ${bounds.requestedWidth} x ${bounds.requestedHeight} px | Geometry: ${geometry} | Edge-clamped: ${bounds.clamped}`);
  if (contrast) {
    lines.push(`# Percentile clipping ${contrast.lowPct}%-${contrast.highPct}%: [${contrast.min.toFixed(3)}, ${contrast.max.toFixed(3)}] degC`
      + ` (raw [${contrast.rawMin.toFixed(3)}, ${contrast.rawMax.toFixed(3)}] degC)`);
  }
  lines.push(`# T_max=${stats.max.toFixed(3)} T_min=${stats.min.toFixed(3)} T_mean=${stats.mean.toFixed(3)} T_median=${stats.median.toFixed(3)} degC`);
  lines.push(`# MAD=${stats.mad.toFixed(3)} robust_std(1.4826*MAD)=${stats.robustStd.toFixed(3)} std=${stats.stdDev.toFixed(3)} degC`);
  lines.push(`# Defect contrast dT(T_max-T_min)=${stats.deltaT.toFixed(3)} degC over ${stats.pixelCount} px`);
  if (centroid) {
    lines.push(`# Thermal centroid (sub-pixel): absolute Xc=${centroid.x.toFixed(3)} Yc=${centroid.y.toFixed(3)}`
      + ` | patch-local ${centroid.localX.toFixed(3)}, ${centroid.localY.toFixed(3)}`);
  }
  lines.push(`# Divergence: max_source=${divergenceSummary.maxSource.toFixed(3)} max_sink=${divergenceSummary.maxSink.toFixed(3)}`
    + ` net_integrated=${divergenceSummary.net.toFixed(3)} (relative units, k=1)`);
  lines.push(MICRO_TEMP_BLOCK);
  lines.push(formatMatrixBlock(matrix, 3));
  lines.push(MICRO_DIVERGENCE_BLOCK);
  lines.push(formatMatrixBlock(divergence, 3));
  return lines.join('\n') + '\n';
}

function buildMicroJson(payload) {
  const {
    matrix, divergence, bounds, geometry, stats, centroid, divergenceSummary,
    contrast, sourceLabel, sensorWidth, sensorHeight, fluxSummary, timestamp
  } = payload;

  return {
    reportType: 'FLIR_E8XT_MICRO_PATCH_ANALYSIS',
    timestamp: timestamp || new Date().toISOString(),
    source: {
      frame: sourceLabel || null,
      sensorMatrixPixels: { width: sensorWidth, height: sensorHeight }
    },
    roi: {
      requestedPixels: { width: bounds.requestedWidth, height: bounds.requestedHeight },
      actualPixels: { width: bounds.width, height: bounds.height },
      bounds: { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 },
      geometry,
      clampedAtSensorEdge: bounds.clamped
    },
    statisticsDegC: stats ? {
      max: stats.max,
      min: stats.min,
      mean: stats.mean,
      median: stats.median,
      mad: stats.mad,
      robustStandardDeviation: stats.robustStd,
      standardDeviation: stats.stdDev,
      defectContrastDeltaT: stats.deltaT,
      pixelCount: stats.pixelCount
    } : null,
    displayClipping: contrast ? {
      lowPercentile: contrast.lowPct,
      highPercentile: contrast.highPct,
      zmin: contrast.min,
      zmax: contrast.max,
      rawMin: contrast.rawMin,
      rawMax: contrast.rawMax
    } : null,
    thermalCentroid: centroid ? {
      subPixelAbsolute: { x: centroid.x, y: centroid.y },
      subPixelPatchLocal: { x: centroid.localX, y: centroid.localY },
      weightSumDeltaT: centroid.weightSum,
      floorTempDegC: centroid.floorTemp
    } : null,
    fluxSummary: fluxSummary ? {
      units: 'relative (k=1)',
      peakMagnitudeRelative: fluxSummary.peakMagnitude,
      note: fluxSummary.note
    } : null,
    divergence: {
      units: 'relative (k=1)',
      maxSource: divergenceSummary.maxSource,
      maxSink: divergenceSummary.maxSink,
      netIntegrated: divergenceSummary.net,
      maxSourceLocation: divergenceSummary.maxSourceAt,
      maxSinkLocation: divergenceSummary.maxSinkAt,
      cellCount: divergenceSummary.cellCount
    },
    temperatureMatrixDegC: matrix,
    divergenceMatrixRelativeUnits: divergence
  };
}
