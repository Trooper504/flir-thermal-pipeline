// --- webapp/js/maskEngine.js ---
// Global polygonal masking math for the Mask Studio: draw ONE closed polygon on a
// thermogram, rasterise it once into a boolean cookie-cutter, then reuse that mask
// for every frame in the album without re-doing the geometry work.
//
// DOM-free pure functions so the whole path stays testable outside the browser.
// Depends on:
//   * microEngine.js -> computePatchStatistics() (min/max/mean/median/MAD engine)
//
// Coordinate convention (identical to the rest of the pipeline): matrices are
// row-major, i.e. matrix[Y][X]. Every mask in this file is likewise indexed
// mask[y - bbox.y0][x - bbox.x0] -- never mask[x][y].

// ============================================================================
// 1. SVG PATH -> MATRIX COORDINATES
// ============================================================================

// Plotly hands the drawn lasso back as an SVG path string, e.g.
//   "M 12.5 20.3 L 13.1 21.9 L 20.4 25.0 Z"
// The regex below is a tokeniser, not a parser: command letters and numbers.
const SVG_PATH_TOKEN = /([MmLlHhVvZzCcSsQqTtAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
const SVG_PATH_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

// Argument count per command. For curves only the on-curve endpoint is kept, which
// is exactly what a polygon rasteriser needs (freehand lassos are straight L runs).
const SVG_PATH_ARITY = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 };

/**
 * Parses an SVG path string into absolute data-space vertices.
 * Supports absolute and relative forms plus implicit repeated coordinates
 * ("M 1 2 3 4" == "M 1 2 L 3 4"). Curves contribute their endpoint only.
 *
 * @returns {{points: Array<{x:number,y:number}>, commands: Array<string>, closed: boolean, tokenCount: number}}
 */
function parseSvgPathToPoints(pathString) {
  const tokens = String(pathString === undefined || pathString === null ? '' : pathString).match(SVG_PATH_TOKEN) || [];
  const points = [];
  const commands = [];
  let cursor = { x: 0, y: 0 };
  let command = null;
  let closed = false;
  let index = 0;

  const takeNumber = () => {
    if (index >= tokens.length || !SVG_PATH_NUMBER.test(tokens[index])) return NaN;
    index += 1;
    return Number(tokens[index - 1]);
  };

  while (index < tokens.length) {
    if (!SVG_PATH_NUMBER.test(tokens[index])) {
      command = tokens[index];
      index += 1;
    } else if (!command) {
      break;                        // numbers with no command: nothing to interpret
    }

    const upper = String(command).toUpperCase();
    const relative = command !== upper;

    if (upper === 'Z') {
      closed = true;
      command = null;
      continue;
    }

    const arity = SVG_PATH_ARITY[upper];
    if (!arity) {                   // unknown command letter: drop it and resync
      command = null;
      continue;
    }

    const args = [];
    for (let k = 0; k < arity; k++) {
      const value = takeNumber();
      if (!isFinite(value)) break;
      args.push(value);
    }
    if (args.length < arity) break; // truncated path: keep what was decoded

    let end;
    if (upper === 'H') {
      end = { x: relative ? cursor.x + args[0] : args[0], y: cursor.y };
    } else if (upper === 'V') {
      end = { x: cursor.x, y: relative ? cursor.y + args[0] : args[0] };
    } else if (upper === 'C') {
      end = { x: relative ? cursor.x + args[4] : args[4], y: relative ? cursor.y + args[5] : args[5] };
    } else if (upper === 'S' || upper === 'Q') {
      end = { x: relative ? cursor.x + args[2] : args[2], y: relative ? cursor.y + args[3] : args[3] };
    } else if (upper === 'A') {
      end = { x: relative ? cursor.x + args[5] : args[5], y: relative ? cursor.y + args[6] : args[6] };
    } else {
      end = { x: relative ? cursor.x + args[0] : args[0], y: relative ? cursor.y + args[1] : args[1] };
    }

    if (!isFinite(end.x) || !isFinite(end.y)) break;
    cursor = end;
    points.push({ x: end.x, y: end.y });
    commands.push(upper);

    // After a moveto every following coordinate pair is an implicit lineto.
    if (upper === 'M') command = relative ? 'l' : 'L';
  }

  return { points, commands, closed, tokenCount: tokens.length };
}

/** Rounds vertices to whole pixels and collapses duplicates (incl. the closing vertex). */
function roundPolygonPoints(points) {
  const rounded = [];
  (points || []).forEach(p => {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const last = rounded[rounded.length - 1];
    if (last && last.x === x && last.y === y) return;
    rounded.push({ x, y });
  });

  while (rounded.length > 1) {
    const first = rounded[0];
    const last = rounded[rounded.length - 1];
    if (first.x === last.x && first.y === last.y) rounded.pop();
    else break;
  }
  return rounded;
}

/**
 * Phase 2 sanity check: are the decoded numbers matrix indices (data space) or
 * screen pixels? A polygon touching the frame at least once scores above zero.
 */
function verifyCoordinateSpace(points, matWidth, matHeight) {
  const list = points || [];
  if (!list.length || !(matWidth > 0) || !(matHeight > 0)) {
    return {
      insideFraction: 0, maxX: NaN, maxY: NaN, suspectScreenSpace: true,
      matrixWidth: matWidth, matrixHeight: matHeight
    };
  }

  let maxX = -Infinity;
  let maxY = -Infinity;
  let inside = 0;
  list.forEach(p => {
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    if (p.x >= 0 && p.x <= matWidth - 1 && p.y >= 0 && p.y <= matHeight - 1) inside += 1;
  });

  const insideFraction = inside / list.length;
  return {
    insideFraction,
    maxX,
    maxY,
    // Not a single vertex inside the frame -> almost certainly screen coordinates.
    suspectScreenSpace: insideFraction === 0,
    matrixWidth: matWidth,
    matrixHeight: matHeight
  };
}

/** Axis-aligned bounding box of the polygon, clamped to the frame. */
function polygonBounds(points, matWidth, matHeight) {
  if (!points || !points.length) return null;

  let maxX = -Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  points.forEach(p => {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  if (!isFinite(minX) || !isFinite(minY)) return null;

  const raw = {
    x0: Math.round(minX),
    y0: Math.round(minY),
    x1: Math.round(maxX),
    y1: Math.round(maxY)
  };

  let x0 = raw.x0;
  let y0 = raw.y0;
  let x1 = raw.x1;
  let y1 = raw.y1;
  if (matWidth > 0) { x0 = Math.max(0, x0); x1 = Math.min(matWidth - 1, x1); }
  if (matHeight > 0) { y0 = Math.max(0, y0); y1 = Math.min(matHeight - 1, y1); }
  if (x1 < x0 || y1 < y0) return null;

  return {
    x0, y0, x1, y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    raw,
    clamped: raw.x0 !== x0 || raw.y0 !== y0 || raw.x1 !== x1 || raw.y1 !== y1
  };
}

// ============================================================================
// 2. RAY CASTING -> REUSABLE BOOLEAN MASK (computed once, reused everywhere)
// ============================================================================

/**
 * Even-odd ray casting (a horizontal ray towards +x).
 *
 * The half-open edge rule `(yi > py) !== (yj > py)` is what stops a ray that lands
 * exactly on a vertex from being counted twice: an edge counts only if the test
 * point's y is >= the edge's lower y and strictly < its upper y.
 */
function pointInPolygon(px, py, points) {
  if (!points || points.length < 3) return false;

  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const yi = points[i].y;
    const yj = points[j].y;
    if ((yi > py) === (yj > py)) continue;      // edge cannot cross this scanline

    const xi = points[i].x;
    const xj = points[j].x;
    const xCross = xi + ((py - yi) / (yj - yi)) * (xj - xi);
    if (px < xCross) inside = !inside;
  }
  return inside;
}

/**
 * Rasterises the polygon over its bounding box only.
 * Returns mask[y - bbox.y0][x - bbox.x0] === true for pixels whose centre is inside.
 */
function buildPolygonMask(points, bbox) {
  const width = bbox ? bbox.width : 0;
  const height = bbox ? bbox.height : 0;
  const mask = Array.from({ length: height }, () => new Array(width).fill(false));

  let insideCount = 0;
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    const row = mask[y - bbox.y0];
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (!pointInPolygon(x, y, points)) continue;
      row[x - bbox.x0] = true;
      insideCount += 1;
    }
  }
  return { mask, insideCount };
}

/**
 * Builds the reusable global ROI state object that the UI stores in window.globalROI.
 *
 * @param {Array<{x:number,y:number}>} points vertices (data space, may be fractional)
 * @param {number} matWidth  frame width  (columns)
 * @param {number} matHeight frame height (rows)
 * @param {{source?:string}} [options]
 * @returns {object|null} null when the polygon cannot be reduced to 3+ whole pixels
 */
function createGlobalRoi(points, matWidth, matHeight, options = {}) {
  const vertices = roundPolygonPoints(points);
  if (vertices.length < 3) return null;

  const bbox = polygonBounds(vertices, matWidth, matHeight);
  if (!bbox) return null;

  const { mask, insideCount } = buildPolygonMask(vertices, bbox);
  const framePixels = Math.max(1, (matWidth || 0) * (matHeight || 0));

  return {
    active: true,
    vertices,
    vertexCount: vertices.length,
    bbox,
    mask,
    insideCount,
    coverageOfBboxPercent: (insideCount / Math.max(1, bbox.width * bbox.height)) * 100,
    coverageOfFramePercent: (insideCount / framePixels) * 100,
    matWidth,
    matHeight,
    source: options.source || 'plotly-drawclosedpath',
    createdAt: new Date().toISOString(),
    // Filled in by the UI layer; kept here so a serialised ROI is self-describing.
    frameLabel: options.frameLabel || null
  };
}

/** Converts a drawn rectangle (x0/y0/x1/y1, data space) into polygon vertices. */
function polygonFromRect(x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ];
}

/** Human-readable one-liner for the status bar / exports. */
function describeRoi(roi) {
  if (!roi || !roi.active) return 'no mask';
  const b = roi.bbox;
  return `${roi.vertexCount}-vertex polygon | bbox ${b.width} x ${b.height} px at `
    + `[x ${b.x0}..${b.x1}] x [y ${b.y0}..${b.y1}] | ${roi.insideCount} px masked `
    + `(${roi.coverageOfBboxPercent.toFixed(1)}% of bbox, ${roi.coverageOfFramePercent.toFixed(1)}% of frame)`
    + (b.clamped ? ' | clamped at frame edge' : '');
}

// ============================================================================
// 3. EXTRACTION (THE COOKIE-CUTTER) AND ITS STATISTICS
// ============================================================================

/** True when the frame has exactly the pixel grid the mask was rasterised on. */
function isRoiCompatible(matrix, roi) {
  if (!matrix || !matrix.length || !roi || !roi.active) return false;
  return matrix.length === roi.matHeight && matrix[0].length === roi.matWidth;
}

/**
 * Walks the bounding box only and returns the masked temperatures as a flat 1-D
 * array. Non-finite cells and out-of-frame indices are skipped, never coerced.
 */
function extractMaskedValues(matrix, roi) {
  if (!matrix || !matrix.length || !roi || !roi.active) return [];

  const values = [];
  const { x0, y0, x1, y1 } = roi.bbox;
  const lastY = Math.min(y1, matrix.length - 1);

  for (let y = y0; y <= lastY; y++) {
    const row = matrix[y];
    const maskRow = roi.mask[y - y0];
    if (!row || !maskRow) continue;

    const lastX = Math.min(x1, row.length - 1);
    for (let x = x0; x <= lastX; x++) {
      if (!maskRow[x - x0]) continue;
      const value = row[x];
      if (typeof value === 'number' && isFinite(value)) values.push(value);
    }
  }
  return values;
}

/**
 * Mask statistics for one frame.
 * The flat 1-D array is handed straight to the existing microEngine statistics
 * engine as a single-row matrix, so max/min/mean/median/MAD stay identical to the
 * Micro Inspector. A polygon that covers no pixel centre yields null, never NaN.
 */
function computeMaskedStatistics(matrix, roi) {
  const values = extractMaskedValues(matrix, roi);
  if (!values.length) return null;
  return computePatchStatistics([values]);
}

/** Percentile clipping bounds computed over the masked pixels only. */
function computeMaskedContrast(matrix, roi, lowPct = 2, highPct = 98) {
  const values = extractMaskedValues(matrix, roi);
  if (!values.length) return null;
  return computeContrastBounds([values], null, lowPct, highPct);
}

/** Cookie-cutter preview: everything outside the polygon becomes null (transparent). */
function maskedMatrixForDisplay(matrix, roi) {
  if (!matrix || !roi || !roi.active) return null;
  const { x0, y0, x1, y1 } = roi.bbox;

  return matrix.map((row, y) => row.map((value, x) => {
    const insideBox = y >= y0 && y <= y1 && x >= x0 && x <= x1;
    if (!insideBox) return null;
    return roi.mask[y - y0][x - x0] ? value : null;
  }));
}

/** Compact run-length-safe encoding of the boolean mask ("0110") for JSON export. */
function maskBitstrings(roi) {
  if (!roi || !roi.active) return [];
  return roi.mask.map(row => row.map(inside => (inside ? '1' : '0')).join(''));
}

/** Vertices as a single export-friendly string: "12,20 40,18 44,33". */
function formatVertexList(roi) {
  if (!roi || !roi.active) return '';
  return roi.vertices.map(v => `${v.x},${v.y}`).join(' ');
}

// ============================================================================
// 4. BATCH EXPORTS (one mask, N frames)
// ============================================================================

const MASK_BATCH_COLUMNS = [
  'index', 'frame', 'status',
  't_max_degC', 't_min_degC', 't_mean_degC', 't_median_degC',
  'mad_degC', 'robust_std_degC', 'std_degC', 'delta_t_degC', 'pixel_count'
];

/** Minimal CSV escaping (filenames can contain commas or quotes). */
function maskCsvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Statistics block with the same key names the Micro Inspector JSON exporter uses. */
function maskStatsToJson(stats) {
  if (!stats) return null;
  return {
    max: stats.max,
    min: stats.min,
    mean: stats.mean,
    median: stats.median,
    mad: stats.mad,
    robustStandardDeviation: stats.robustStd,
    standardDeviation: stats.stdDev,
    defectContrastDeltaT: stats.deltaT,
    pixelCount: stats.pixelCount
  };
}

/**
 * Time-series CSV: one row per ingested frame, mask metadata in a leading comment
 * block so the file stays self-describing when it leaves the browser.
 */
function buildMaskBatchCsv(payload) {
  const { roi, rows, generatedAt } = payload || {};
  const lines = [];

  lines.push('# FLIR E8-XT GLOBAL POLYGONAL MASK - BATCH ROI TIME SERIES');
  lines.push(`# Generated: ${generatedAt || new Date().toISOString()}`);
  if (roi) {
    lines.push(`# Mask source: ${roi.source} | drawn on: ${roi.frameLabel || 'unspecified'}`);
    lines.push(`# Polygon: ${roi.vertexCount} vertices, data-space matrix indices (rounded to whole pixels)`);
    lines.push(`# Vertices: ${formatVertexList(roi)}`);
    lines.push(`# Bounding box: ${roi.bbox.width} x ${roi.bbox.height} px at `
      + `[x ${roi.bbox.x0}..${roi.bbox.x1}] x [y ${roi.bbox.y0}..${roi.bbox.y1}]`
      + (roi.bbox.clamped ? ' (clamped at frame edge)' : ''));
    lines.push(`# Mask raster: ${roi.insideCount} px inside `
      + `(${roi.coverageOfBboxPercent.toFixed(2)}% of bbox, ${roi.coverageOfFramePercent.toFixed(2)}% of frame) `
      + `of a ${roi.matWidth} x ${roi.matHeight} px matrix (W x H)`);
  } else {
    lines.push('# Mask source: none (empty export)');
  }
  lines.push('# Statistics: min/max/mean/median/MAD over the masked pixel set only');
  lines.push(`# Frames processed: ${(rows || []).length}`);
  lines.push(MASK_BATCH_COLUMNS.join(','));

  (rows || []).forEach(row => {
    const s = row.stats;
    lines.push([
      row.index,
      maskCsvCell(row.label),
      row.status,
      s ? s.max.toFixed(3) : '',
      s ? s.min.toFixed(3) : '',
      s ? s.mean.toFixed(3) : '',
      s ? s.median.toFixed(3) : '',
      s ? s.mad.toFixed(3) : '',
      s ? s.robustStd.toFixed(3) : '',
      s ? s.stdDev.toFixed(3) : '',
      s ? s.deltaT.toFixed(3) : '',
      s ? s.pixelCount : ''
    ].join(','));
  });

  return lines.join('\n') + '\n';
}

/** Structured JSON report: polygon + mask geometry + per-frame statistics. */
function buildMaskJson(payload) {
  const { roi, rows, stats, matrixWidth, matrixHeight, frameLabel, includeMask, timestamp } = payload || {};

  return {
    reportType: 'FLIR_E8XT_GLOBAL_POLYGONAL_MASK',
    timestamp: timestamp || new Date().toISOString(),
    source: {
      frame: frameLabel || null,
      sensorMatrixPixels: { width: matrixWidth, height: matrixHeight }
    },
    polygon: roi ? {
      vertexCount: roi.vertexCount,
      vertices: roi.vertices.map(v => ({ x: v.x, y: v.y })),
      vertexString: formatVertexList(roi),
      coordinateSpace: 'matrix indices (X = column, Y = row)',
      source: roi.source,
      createdAt: roi.createdAt
    } : null,
    mask: roi ? {
      bounds: { x0: roi.bbox.x0, y0: roi.bbox.y0, x1: roi.bbox.x1, y1: roi.bbox.y1 },
      width: roi.bbox.width,
      height: roi.bbox.height,
      pixelsInside: roi.insideCount,
      coverageOfBoundingBoxPercent: Number(roi.coverageOfBboxPercent.toFixed(3)),
      coverageOfFramePercent: Number(roi.coverageOfFramePercent.toFixed(3)),
      clampedAtFrameEdge: roi.bbox.clamped,
      bitstrings: includeMask ? maskBitstrings(roi) : null
    } : null,
    statisticsDegC: maskStatsToJson(stats),
    batch: (rows || []).map(row => ({
      index: row.index,
      frame: row.label,
      status: row.status,
      statisticsDegC: maskStatsToJson(row.stats)
    }))
  };
}
