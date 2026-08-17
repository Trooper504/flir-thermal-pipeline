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
// --- ASTM E1862/E1897 MULTI-PARAMETER RADIOMETRIC CALIBRATION ---
function computeAtmosphericTransmission(distanceMeters, relativeHumidity, atmTempC) {
  // Empirical water vapor partial pressure (Magnus-Tetens formulation)
  const p_sat = 6.1078 * Math.pow(10, (7.5 * atmTempC) / (237.3 + atmTempC));
  const p_h2o = (relativeHumidity / 100.0) * p_sat; // hPa

  // Empirical extinction coefficient for long-wave IR (8-14 um microbolometers)
  const alpha = 0.0065;
  const beta = 0.012;
  const sqrt_H2O = Math.sqrt(Math.max(0.01, p_h2o));
  const tau_atm = Math.exp(-Math.sqrt(Math.max(0.1, distanceMeters)) * (alpha + beta * sqrt_H2O));

  return Math.min(1.0, Math.max(0.05, tau_atm));
}

function applyAstmCalibration(matrix, params) {
  const {
    emissivity = 0.95,
    distanceMeters = 1.0,
    relativeHumidity = 50.0,
    atmTempC = 20.0,
    reflTempC = 20.0,
    winTrans = 1.0,
    winTempC = 20.0,
    baseEmissivity = 0.95
  } = params;

  const eps = Math.max(0.05, Math.min(1.0, parseFloat(emissivity)));
  const eps_base = Math.max(0.05, Math.min(1.0, parseFloat(baseEmissivity)));
  const tau_win = Math.max(0.05, Math.min(1.0, parseFloat(winTrans)));
  const tau_atm = computeAtmosphericTransmission(distanceMeters, relativeHumidity, atmTempC);

  const T_atm_K4 = Math.pow(parseFloat(atmTempC) + 273.15, 4);
  const T_refl_K4 = Math.pow(parseFloat(reflTempC) + 273.15, 4);
  const T_win_K4 = Math.pow(parseFloat(winTempC) + 273.15, 4);

  const calibratedMatrix = matrix.map(row => row.map(tempC => {
    const T_obj_raw_K4 = Math.pow(tempC + 273.15, 4);
    
    // Total raw radiant energy assumed by base camera calibration
    const W_tot = eps_base * T_obj_raw_K4 + (1.0 - eps_base) * T_refl_K4;

    // Isolate true target radiation by removing window, atmospheric, and reflection components
    const W_obj_num = W_tot - (1.0 - eps) * tau_atm * tau_win * T_refl_K4
                            - (1.0 - tau_atm) * tau_win * T_atm_K4
                            - (1.0 - tau_win) * T_win_K4;

    const W_obj_den = eps * tau_atm * tau_win;
    const W_emitted = Math.max(0, W_obj_num / W_obj_den);
    
    const T_corrected_K = Math.pow(W_emitted, 0.25);
    return parseFloat((T_corrected_K - 273.15).toFixed(2));
  }));

  return {
    tau_atm: tau_atm,
    total_opt_gain: tau_atm * tau_win,
    calibratedMatrix: calibratedMatrix
  };
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
// --- EDGE-PRESERVING 2D BILATERAL FILTER ---
function applyBilateralFilter2D(matrix, radius = 2, sigmaSpace = 2.5, sigmaColor = 1.2) {
  if (!matrix || matrix.length === 0) return matrix;
  const rows = matrix.length;
  const cols = matrix[0].length;
  let filtered = Array.from({ length: rows }, () => new Array(cols).fill(0));

  const twoSigmaSpaceSq = 2.0 * sigmaSpace * sigmaSpace;
  const twoSigmaColorSq = 2.0 * sigmaColor * sigmaColor;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const centerVal = matrix[r][c];
      let weightSum = 0.0;
      let pixelSum = 0.0;

      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r + dr;
          const nc = c + dc;

          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            const neighborVal = matrix[nr][nc];
            
            // Spatial distance squared
            const spatialDistSq = dr * dr + dc * dc;
            // Radiometric intensity distance squared
            const intensityDistSq = Math.pow(centerVal - neighborVal, 2);

            // Bilateral weight product: w = exp(-d_s^2 / 2*s_s^2) * exp(-d_r^2 / 2*s_r^2)
            const spatialWeight = Math.exp(-spatialDistSq / twoSigmaSpaceSq);
            const colorWeight = Math.exp(-intensityDistSq / twoSigmaColorSq);
            const weight = spatialWeight * colorWeight;

            pixelSum += neighborVal * weight;
            weightSum += weight;
          }
        }
      }
      filtered[r][c] = parseFloat((pixelSum / (weightSum || 1.0)).toFixed(2));
    }
  }
  return filtered;
}

// --- ADAPTIVE EMISSIVITY MATRIX GENERATOR ---
function generateEmissivityMatrix(rawMatrix, zones = [], defaultEmissivity = 0.95) {
  const rows = rawMatrix.length;
  const cols = rawMatrix[0].length;
  const defaultEps = Math.max(0.05, Math.min(1.0, parseFloat(defaultEmissivity) || 0.95));

  let epsMatrix = Array.from({ length: rows }, () => new Array(cols).fill(defaultEps));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const temp = rawMatrix[r][c];
      // Check if pixel falls inside any defined material zone
      for (const zone of zones) {
        if (temp >= zone.minTemp && temp <= zone.maxTemp) {
          epsMatrix[r][c] = zone.emissivity;
          break; // First matching zone takes precedence
        }
      }
    }
  }
  return epsMatrix;
}

// --- RADIOMETRIC INVERSION WITH SPATIALLY-VARYING EMISSIVITY ---
function applyZonedRadiometricCorrection(matrix, epsMatrix, reflTempC = 20.0, baseEmissivity = 0.95) {
  const eps_base = Math.max(0.05, Math.min(1.0, parseFloat(baseEmissivity) || 0.95));
  const T_refl_K4 = Math.pow((parseFloat(reflTempC) || 20.0) + 273.15, 4);

  return matrix.map((row, r) => row.map((tempC, c) => {
    const eps_local = epsMatrix[r] ? epsMatrix[r][c] : 0.95;
    const T_app_K4 = Math.pow(tempC + 273.15, 4);

    // Stefan-Boltzmann energy balance: W_tot = eps_base * T_raw^4 + (1 - eps_base) * T_refl^4
    const W_tot = eps_base * T_app_K4 + (1.0 - eps_base) * T_refl_K4;
    const W_obj = (W_tot - (1.0 - eps_local) * T_refl_K4) / Math.max(0.01, eps_local);

    const T_corrected_K = Math.pow(Math.max(0, W_obj), 0.25);
    return parseFloat((T_corrected_K - 273.15).toFixed(2));
  }));
}
// --- 2D CONDUCTIVE HEAT FLUX VECTOR FIELD ENGINE (FOURIER'S LAW) ---
function computeHeatFluxField(matrix, kConductivity = 400.0, pixelPitchMeters = 0.001, downsampleStep = 5) {
  if (!matrix || matrix.length < 3 || matrix[0].length < 3) return null;

  const rows = matrix.length;
  const cols = matrix[0].length;
  const dx = Math.max(1e-5, parseFloat(pixelPitchMeters) || 0.001);
  const k = Math.max(1e-4, parseFloat(kConductivity) || 400.0);

  let qxMatrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let qyMatrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let qMagMatrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  let maxFlux = 0.0;
  let maxCoord = { x: 0, y: 0 };
  let sumFlux = 0.0;
  let validPixels = 0;

  // 1. Calculate continuous gradient and flux components
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const dtdx = (matrix[r][c + 1] - matrix[r][c - 1]) / (2.0 * dx);
      const dtdy = (matrix[r + 1][c] - matrix[r - 1][c]) / (2.0 * dx);

      // Fourier's Law: q = -k * grad(T)
      const qx = -k * dtdx;
      const qy = -k * dtdy;
      const mag = Math.sqrt(qx * qx + qy * qy) / 1000.0; // Convert W/m^2 to kW/m^2

      qxMatrix[r][c] = qx;
      qyMatrix[r][c] = qy;
      qMagMatrix[r][c] = mag;

      sumFlux += mag;
      validPixels++;

      if (mag > maxFlux) {
        maxFlux = mag;
        maxCoord = { x: c, y: r };
      }
    }
  }

  // 2. Generate vector quiver lines for Plotly
  const step = Math.max(2, parseInt(downsampleStep) || 5);
  let quiverAnnotations = [];

  for (let r = step; r < rows - step; r += step) {
    for (let c = step; c < cols - step; c += step) {
      const qx = qxMatrix[r][c];
      const qy = qyMatrix[r][c];
      const mag = qMagMatrix[r][c];

      if (mag > 0.05 * maxFlux && maxFlux > 0) {
        const normFactor = (step * 0.8) / (maxFlux || 1.0);
        const arrowDx = (qx / 1000.0) * normFactor;
        const arrowDy = (qy / 1000.0) * normFactor;

        quiverAnnotations.push({
          x: c + arrowDx,
          y: r + arrowDy,
          ax: c,
          ay: r,
          xref: 'x',
          yref: 'y',
          axref: 'x',
          ayref: 'y',
          showarrow: true,
          arrowhead: 2,
          arrowsize: 1,
          arrowwidth: 1.2,
          arrowcolor: '#38bdf8'
        });
      }
    }
  }

  return {
    k: k,
    dx: dx,
    maxFluxKw: maxFlux,
    meanFluxKw: validPixels > 0 ? sumFlux / validPixels : 0.0,
    maxFluxCoord: maxCoord,
    qMagMatrix: qMagMatrix,
    quiverAnnotations: quiverAnnotations
  };
}

// --- TRANSIENT THERMAL TIME CONSTANT (TAU) EXPONENTIAL FIT ENGINE ---
function fitTransientTimeConstant(timeArray, tempArray, asymptoticTemp = 20.0, appliedPowerWatts = 5.0) {
  if (!timeArray || !tempArray || timeArray.length < 3 || timeArray.length !== tempArray.length) {
    return null;
  }

  const N = timeArray.length;
  const T_inf = parseFloat(asymptoticTemp);
  const T_0 = tempArray[0];
  const deltaT_0 = T_0 - T_inf;

  if (Math.abs(deltaT_0) < 0.1) {
    return null; // Insufficient delta T for regression
  }

  let t_shifted = [];
  let log_theta = [];
  let validPoints = 0;

  for (let i = 0; i < N; i++) {
    const t = timeArray[i] - timeArray[0];
    const theta = (tempArray[i] - T_inf) / deltaT_0;

    // Strict positive bounds for natural log
    if (theta > 0.001) {
      t_shifted.push(t);
      log_theta.push(Math.log(theta));
      validPoints++;
    }
  }

  if (validPoints < 3) return null;

  // Linear regression through origin: ln(theta) = -beta * t
  let sum_t_sq = 0.0;
  let sum_t_logtheta = 0.0;

  for (let i = 0; i < validPoints; i++) {
    sum_t_sq += t_shifted[i] * t_shifted[i];
    sum_t_logtheta += t_shifted[i] * log_theta[i];
  }

  const beta = -sum_t_logtheta / (sum_t_sq || 1.0);
  const tau = beta > 1e-6 ? 1.0 / beta : Infinity;

  // Compute fitted values and R^2 metric
  let temp_fit = [];
  let ss_tot = 0.0;
  let ss_res = 0.0;
  const mean_measured = tempArray.reduce((acc, v) => acc + v, 0) / N;

  for (let i = 0; i < N; i++) {
    const t = timeArray[i] - timeArray[0];
    const T_fitted = T_inf + deltaT_0 * Math.exp(-beta * t);
    temp_fit.push(parseFloat(T_fitted.toFixed(3)));

    ss_res += Math.pow(tempArray[i] - T_fitted, 2);
    ss_tot += Math.pow(tempArray[i] - mean_measured, 2);
  }

  const r2 = ss_tot > 0 ? Math.max(0, 1.0 - (ss_res / ss_tot)) : 1.0;
  const P = Math.max(1e-3, parseFloat(appliedPowerWatts) || 1.0);
  const R_th = Math.abs(deltaT_0) / P;
  const C_th = tau < Infinity ? tau / R_th : 0.0;

  return {
    tau: tau,
    beta: beta,
    r2: r2,
    T_0: T_0,
    T_inf: T_inf,
    R_th: R_th,
    C_th: C_th,
    timeArray: timeArray,
    tempArray: tempArray,
    fitCurve: temp_fit
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