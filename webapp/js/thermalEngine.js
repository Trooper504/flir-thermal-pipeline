// --- STRICT SEMICOLON FLIR CSV PARSER ---
function parseFlirCsvText(text) {
  const lines = text.split(/\r?\n/);
  let matrix = [];

  lines.forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('Файл:') || line.startsWith('File:')) return;

    const parts = line.split(';');
    let row = [];
    parts.forEach(p => {
      p = p.trim();
      if (!p || p.startsWith('Кадр') || p.startsWith('Frame')) return;
      const val = parseFloat(p.replace(',', '.'));
      if (!isNaN(val)) row.push(val);
    });
    if (row.length > 0) matrix.push(row);
  });
  return matrix.length > 0 ? matrix : null;
}

// --- RADIOMETRIC PLANCK RE-CALIBRATION ---
function applyPlanckRecalibration(matrix, newEmissivity, reflTempC = 20.0, baseEmissivity = 0.95) {
  const e_target = parseFloat(newEmissivity);
  const e_base = parseFloat(baseEmissivity);
  const T_refl_K = parseFloat(reflTempC) + 273.15;

  return matrix.map(row => row.map(tempC => {
    const T_obj_K = tempC + 273.15;
    const W_total = e_base * Math.pow(T_obj_K, 4) + (1.0 - e_base) * Math.pow(T_refl_K, 4);
    const W_emitted = (W_total - (1.0 - e_target) * Math.pow(T_refl_K, 4)) / e_target;
    const T_corrected_K = Math.pow(Math.max(0, W_emitted), 0.25);
    return parseFloat((T_corrected_K - 273.15).toFixed(2));
  }));
}

// --- SPATIAL THERMAL GRADIENT (Center - Neighbor Avg Convolution) ---
function computeGradient2D(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  let grad = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          sum += matrix[r + dr][c + dc];
        }
      }
      const neighborAvg = sum / 8.0;
      grad[r][c] = matrix[r][c] - neighborAvg;
    }
  }
  return grad;
}

// --- HOTSPOT ROI ENGINE ---
function detectHotspotROI(matrix, sensitivityMultiplier = 2.0) {
  let sum = 0, count = 0;
  let minVal = Infinity, maxVal = -Infinity;
  let maxR = 0, maxC = 0;

  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      const v = matrix[r][c];
      sum += v;
      count++;
      if (v < minVal) minVal = v;
      if (v > maxVal) { maxVal = v; maxR = r; maxC = c; }
    }
  }
  const mean = sum / count;

  let varianceSum = 0;
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      varianceSum += Math.pow(matrix[r][c] - mean, 2);
    }
  }
  const stdDev = Math.sqrt(varianceSum / count);
  const hotspotThreshold = mean + (sensitivityMultiplier * stdDev);

  let minR = matrix.length, maxRow = 0;
  let minC = matrix[0].length, maxCol = 0;
  let hotspotPixelCount = 0;

  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c] >= hotspotThreshold) {
        hotspotPixelCount++;
        if (r < minR) minR = r;
        if (r > maxRow) maxRow = r;
        if (c < minC) minC = c;
        if (c > maxCol) maxCol = c;
      }
    }
  }

  const hasHotspot = hotspotPixelCount > 5;
  return {
    hasHotspot,
    threshold: hotspotThreshold,
    peakTemp: maxVal,
    peakCoord: { x: maxC, y: maxR },
    meanTemp: mean,
    minTemp: minVal,
    stdDev: stdDev,
    bbox: hasHotspot ? { x0: minC, y0: minR, x1: maxCol, y1: maxRow } : null
  };
}

// --- ISOTHERMAL RANGE MASK COMPUTATION ---
function computeIsothermMask(matrix, minTemp, maxTemp) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const totalPixels = rows * cols;

  let maskMatrix = Array.from({ length: rows }, () => new Array(cols).fill(null));
  let matchCount = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = matrix[r][c];
      if (val >= minTemp && val <= maxTemp) {
        maskMatrix[r][c] = val;
        matchCount++;
      }
    }
  }

  const areaPercentage = (matchCount / totalPixels) * 100.0;

  return {
    maskMatrix: maskMatrix,
    matchCount: matchCount,
    areaPercentage: areaPercentage
  };
}
// --- OFFLINE SIMULATION MATRIX GENERATOR ---
function generateMockThermalMatrix(rows = 60, cols = 80) {
  let matrix = Array.from({ length: rows }, () => new Array(cols).fill(22.0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      matrix[r][c] += Math.random() * 1.5;
    }
  }
  const centerR = Math.floor(rows / 2);
  const centerC = Math.floor(cols / 2);
  const tempBoost = 18.0 + Math.random() * 5.0;

  for (let r = centerR - 6; r <= centerR + 6; r++) {
    for (let c = centerC - 8; c <= centerC + 8; c++) {
      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        const dist = Math.sqrt(Math.pow(r - centerR, 2) + Math.pow(c - centerC, 2));
        matrix[r][c] += Math.max(0, tempBoost - dist * 1.5);
      }
    }
  }
  return matrix;
}