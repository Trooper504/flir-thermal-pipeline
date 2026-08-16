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
// --- PULSED PHASE THERMOGRAPHY (PPT) VIA 1D DISCRETE FOURIER TRANSFORM ---
function computePptMaps(frameSequence, targetFreqBin = 1) {
  const numFrames = frameSequence.length;
  if (numFrames < 3) return null;

  const rows = frameSequence[0].calibratedMatrix.length;
  const cols = frameSequence[0].calibratedMatrix[0].length;

  let phaseMatrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let ampMatrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  const n = Math.min(targetFreqBin, Math.floor((numFrames - 1) / 2));
  const twoPiN_over_N = (2.0 * Math.PI * n) / numFrames;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let realPart = 0.0;
      let imagPart = 0.0;

      for (let k = 0; k < numFrames; k++) {
        const val = frameSequence[k].calibratedMatrix[r][c];
        const angle = twoPiN_over_N * k;
        realPart += val * Math.cos(angle);
        imagPart -= val * Math.sin(angle);
      }

      realPart /= numFrames;
      imagPart /= numFrames;

      // Phase: phi = atan2(Im, Re)
      phaseMatrix[r][c] = Math.atan2(imagPart, realPart);
      // Amplitude: A = sqrt(Re^2 + Im^2)
      ampMatrix[r][c] = Math.sqrt(realPart * realPart + imagPart * imagPart);
    }
  }

  return {
    frequencyBin: n,
    totalFrames: numFrames,
    phaseMatrix: phaseMatrix,
    amplitudeMatrix: ampMatrix
  };
}

// --- THERMAL SIGNAL RECONSTRUCTION (TSR) & TIME DERIVATIVES ---
function computeTsrDerivatives(frameSequence, px, py) {
  const numFrames = frameSequence.length;
  if (numFrames < 3) return null;

  let timeSteps = [];
  let tempSeries = [];

  for (let i = 0; i < numFrames; i++) {
    timeSteps.push(i);
    const m = frameSequence[i].calibratedMatrix;
    const r = Math.max(0, Math.min(m.length - 1, py));
    const c = Math.max(0, Math.min(m[0].length - 1, px));
    tempSeries.push(m[r][c]);
  }

  // 1st Derivative: central difference dT/dt
  let d1 = new Array(numFrames).fill(0);
  for (let i = 1; i < numFrames - 1; i++) {
    d1[i] = (tempSeries[i + 1] - tempSeries[i - 1]) / 2.0;
  }
  d1[0] = tempSeries[1] - tempSeries[0];
  d1[numFrames - 1] = tempSeries[numFrames - 1] - tempSeries[numFrames - 2];

  // 2nd Derivative: central difference d2T/dt2
  let d2 = new Array(numFrames).fill(0);
  for (let i = 1; i < numFrames - 1; i++) {
    d2[i] = tempSeries[i + 1] - 2 * tempSeries[i] + tempSeries[i - 1];
  }
  d2[0] = d1[1] - d1[0];
  d2[numFrames - 1] = d1[numFrames - 1] - d1[numFrames - 2];

  return {
    timeSteps: timeSteps,
    tempSeries: tempSeries,
    firstDerivative: d1,
    secondDerivative: d2
  };
}
// --- PRINCIPAL COMPONENT THERMOGRAPHY (PCT) ENGINE ---
function computePctModes(frameSequence, maxComponents = 3) {
  const numFrames = frameSequence.length;
  if (numFrames < 3) return null;

  const rows = frameSequence[0].calibratedMatrix.length;
  const cols = frameSequence[0].calibratedMatrix[0].length;
  const numPixels = rows * cols;
  const kModes = Math.min(maxComponents, numFrames);

  // 1. Flatten frames into Data Matrix A (M pixels x N time)
  let A = Array.from({ length: numPixels }, () => new Array(numFrames).fill(0));
  let temporalMeans = new Array(numPixels).fill(0);

  for (let t = 0; t < numFrames; t++) {
    const mat = frameSequence[t].calibratedMatrix;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pIdx = r * cols + c;
        const val = mat[r][c];
        A[pIdx][t] = val;
        temporalMeans[pIdx] += val;
      }
    }
  }

  // Subtract temporal mean per pixel (Mean-Centering)
  for (let p = 0; p < numPixels; p++) {
    temporalMeans[p] /= numFrames;
    for (let t = 0; t < numFrames; t++) {
      A[p][t] -= temporalMeans[p];
    }
  }

  // 2. Compute Temporal Gram Matrix C = A^T * A (N x N)
  let C = Array.from({ length: numFrames }, () => new Array(numFrames).fill(0));
  for (let i = 0; i < numFrames; i++) {
    for (let j = i; j < numFrames; j++) {
      let sum = 0.0;
      for (let p = 0; p < numPixels; p++) {
        sum += A[p][i] * A[p][j];
      }
      C[i][j] = sum;
      C[j][i] = sum;
    }
  }

  // 3. Power-iteration / Deflation for the top k Eigenvectors of C
  let eigenVectors = [];
  let eigenValues = [];
  let C_def = C.map(r => [...r]);

  for (let m = 0; m < kModes; m++) {
    let v = new Array(numFrames).fill(0).map(() => Math.random() - 0.5);
    // Normalize initial vector
    let norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1.0;
    v = v.map(x => x / norm);

    let lambda = 0.0;
    for (let iter = 0; iter < 40; iter++) {
      let v_next = new Array(numFrames).fill(0);
      for (let i = 0; i < numFrames; i++) {
        for (let j = 0; j < numFrames; j++) {
          v_next[i] += C_def[i][j] * v[j];
        }
      }
      norm = Math.sqrt(v_next.reduce((acc, x) => acc + x * x, 0));
      if (norm < 1e-9) break;
      lambda = norm;
      v = v_next.map(x => x / norm);
    }

    eigenValues.push(lambda);
    eigenVectors.push(v);

    // Deflate matrix: C_def = C_def - lambda * (v * v^T)
    for (let i = 0; i < numFrames; i++) {
      for (let j = 0; j < numFrames; j++) {
        C_def[i][j] -= lambda * v[i] * v[j];
      }
    }
  }

  // Total variance calculation
  let traceC = 0.0;
  for (let i = 0; i < numFrames; i++) traceC += C[i][i];
  const varianceRatios = eigenValues.map(ev => traceC > 0 ? (ev / traceC) * 100.0 : 0.0);

  // 4. Project spatial EOF Maps: U_m = A * v_m / sqrt(lambda_m)
  let eofSpatialMaps = [];
  for (let m = 0; m < kModes; m++) {
    const v = eigenVectors[m];
    const scale = eigenValues[m] > 1e-6 ? 1.0 / Math.sqrt(eigenValues[m]) : 1.0;
    let spatialMap = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pIdx = r * cols + c;
        let proj = 0.0;
        for (let t = 0; t < numFrames; t++) {
          proj += A[pIdx][t] * v[t];
        }
        spatialMap[r][c] = proj * scale;
      }
    }
    eofSpatialMaps.push(spatialMap);
  }

  return {
    kModes: kModes,
    eigenValues: eigenValues,
    varianceRatios: varianceRatios,
    eofSpatialMaps: eofSpatialMaps
  };
}