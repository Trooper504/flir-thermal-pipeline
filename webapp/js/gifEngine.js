// --- DUAL TWO-PASS GIF GENERATION ---
async function generateSelectedGIF() {
  if (selectedIndices.size < 2) return;

  const selectedFrames = Array.from(selectedIndices).sort((a,b) => a - b).map(i => frameBuffer[i]);
  
  // Pass 1: Compute global limits across selected frames
  let globalMinTemp = Infinity, globalMaxTemp = -Infinity;
  let batchGradMin = Infinity, batchGradMax = -Infinity;

  selectedFrames.forEach(f => {
    f.calibratedMatrix.forEach(row => row.forEach(v => {
      if (v < globalMinTemp) globalMinTemp = v;
      if (v > globalMaxTemp) globalMaxTemp = v;
    }));

    const grad = computeGradient2D(f.calibratedMatrix);
    grad.forEach(row => row.forEach(v => {
      if (v < batchGradMin) batchGradMin = v;
      if (v > batchGradMax) batchGradMax = v;
    }));
  });

  const lockedMinTemp = Math.floor(globalMinTemp);
  const lockedMaxTemp = Math.ceil(globalMaxTemp);
  const globalMaxAbs = Math.max(Math.abs(batchGradMin), Math.abs(batchGradMax));

  let workerUrl = '';
  try {
    const workerResp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
    const workerBlob = await workerResp.blob();
    workerUrl = URL.createObjectURL(workerBlob);
  } catch (e) {
    console.warn("Worker fallback triggered", e);
  }

  const baseGifConfig = { quality: 10, width: 600, height: 400 };
  if (workerUrl) {
    baseGifConfig.workerScript = workerUrl;
    baseGifConfig.workers = 2;
  }

  const gifHeatmap = new GIF({ ...baseGifConfig });
  const gifGradient = new GIF({ ...baseGifConfig });

  // Pass 2: Render & capture locked frames
  for (let i = 0; i < selectedFrames.length; i++) {
    const frame = selectedFrames[i];
    const matrix = frame.calibratedMatrix;
    const grad = computeGradient2D(matrix);

    Plotly.newPlot('thermalPlot', [{
      z: matrix,
      type: 'heatmap',
      colorscale: 'YlOrRd',
      zmin: lockedMinTemp,
      zmax: lockedMaxTemp
    }], { margin: { t: 5, b: 5, l: 25, r: 5 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent' });

    const heatmapUrl = await Plotly.toImage('thermalPlot', { format: 'png', width: 600, height: 400 });
    const imgH = new Image();
    imgH.src = heatmapUrl;
    await new Promise(resolve => imgH.onload = resolve);
    gifHeatmap.addFrame(imgH, { delay: 500 });

    Plotly.newPlot('gradientPlot', [{
      z: grad,
      type: 'heatmap',
      colorscale: 'RdBu',
      reversescale: true,
      zmin: -globalMaxAbs,
      zmax: globalMaxAbs
    }], { margin: { t: 5, b: 5, l: 25, r: 5 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent' });

    const gradUrl = await Plotly.toImage('gradientPlot', { format: 'png', width: 600, height: 400 });
    const imgG = new Image();
    imgG.src = gradUrl;
    await new Promise(resolve => imgG.onload = resolve);
    gifGradient.addFrame(imgG, { delay: 500 });
  }

  const ts = Date.now();

  gifHeatmap.on('finished', function(blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `thermal_heatmap_animation_${ts}.gif`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  gifGradient.on('finished', function(blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `spatial_gradient_animation_${ts}.gif`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  gifHeatmap.render();
  gifGradient.render();
}