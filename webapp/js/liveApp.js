// --- webapp/js/liveApp.js ---
// Live Video & Acquisition Studio controller.
//
// Two honest source modes:
//   * "mjpeg"       - real multipart/x-mixed-replace feed from /api/v1/stream/live-mjpeg,
//                     i.e. whatever video device the collector has bound. The FLIR E8-XT
//                     itself is not UVC, so this is only meaningful with a real video source.
//   * "radiometric" - polls /api/v1/thermal-frame at 9 Hz and paints the genuine
//                     Planck-calibrated matrix to a canvas: a hardware-free thermal feed.

const LIVE_TARGET_FPS = 9;
const LIVE_POLL_INTERVAL_MS = Math.round(1000 / LIVE_TARGET_FPS);   // ~111 ms
const LIVE_PALETTE = [
  [0.00, 0, 0, 8], [0.20, 60, 20, 110], [0.40, 140, 30, 90],
  [0.60, 220, 70, 40], [0.80, 250, 160, 20], [1.00, 255, 255, 220]
];

let liveActive = false;
let liveMode = 'mjpeg';
let liveFrames = 0;
let liveFrameTimes = [];
let livePollTimer = null;
let liveLastMtime = 0;
let liveConsecutiveErrors = 0;
let liveOffscreen = null;

function liveBaseApi() {
  const input = document.getElementById('liveApiUrl');
  const value = input ? input.value : '';

  // apiConfig.js resolves the Pi address; degrade gracefully if it was not loaded
  if (typeof resolveCollectorBase === 'function') return resolveCollectorBase(value);
  return (value || 'http://localhost:8081').replace(/\/+$/, '').replace(/\/api\/v1\/.*$/, '');
}

function logLive(message, level = 'info') {
  const log = document.getElementById('liveLog');
  if (!log) return;
  const colors = { info: 'text-slate-400', warn: 'text-amber-400', error: 'text-rose-400', ok: 'text-emerald-400' };
  const line = document.createElement('div');
  line.className = colors[level] || colors.info;
  line.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.insertBefore(line, log.firstChild);
}

function setLiveText(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function setLiveState(state) {
  setLiveText('liveTlmState', state);
}

// --- PALETTE + CANVAS PAINTING (radiometric mode) ---
function livePaletteColor(t) {
  const v = Math.max(0, Math.min(1, t));
  for (let i = 0; i < LIVE_PALETTE.length - 1; i++) {
    const [p0, r0, g0, b0] = LIVE_PALETTE[i];
    const [p1, r1, g1, b1] = LIVE_PALETTE[i + 1];
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0 || 1);
      return [
        Math.round(r0 + k * (r1 - r0)),
        Math.round(g0 + k * (g1 - g0)),
        Math.round(b0 + k * (b1 - b0))
      ];
    }
  }
  return [255, 255, 220];
}

function livePercentile(sortedAsc, pct) {
  const n = sortedAsc.length;
  if (!n) return NaN;
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

function drawMatrixToCanvas(matrix, canvas) {
  if (!matrix || !matrix.length || !canvas || typeof canvas.getContext !== 'function') return null;

  const height = matrix.length;
  const width = matrix[0].length;

  const flat = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) flat.push(matrix[y][x]);
  }
  flat.sort((a, b) => a - b);

  // Robust contrast so a live view does not wash out from a single hot pixel
  const min = livePercentile(flat, 2);
  const max = livePercentile(flat, 98);
  const span = max > min ? max - min : 1;

  if (!liveOffscreen) {
    liveOffscreen = document.createElement('canvas');
    liveOffscreen.width = width;
    liveOffscreen.height = height;
  }
  if (liveOffscreen.width !== width || liveOffscreen.height !== height) {
    liveOffscreen.width = width;
    liveOffscreen.height = height;
  }

  const offCtx = liveOffscreen.getContext('2d');
  if (!offCtx) return null;

  const image = offCtx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = livePaletteColor((matrix[y][x] - min) / span);
      const px = (y * width + x) * 4;
      image.data[px] = r;
      image.data[px + 1] = g;
      image.data[px + 2] = b;
      image.data[px + 3] = 255;
    }
  }
  offCtx.putImageData(image, 0, 0);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;   // keep single-pixel particles crisp
    ctx.drawImage(liveOffscreen, 0, 0, width, height);
  }

  return { min, max, width, height };
}

// --- STREAM CONTROL ---
function registerLiveFrame(width, height) {
  liveFrames++;
  const now = performance.now ? performance.now() : Date.now();
  liveFrameTimes.push(now);
  while (liveFrameTimes.length > 30) liveFrameTimes.shift();

  if (liveFrameTimes.length > 1) {
    const elapsed = (liveFrameTimes[liveFrameTimes.length - 1] - liveFrameTimes[0]) / 1000;
    const fps = elapsed > 0 ? (liveFrameTimes.length - 1) / elapsed : 0;
    setLiveText('liveTlmFps', `${fps.toFixed(1)} fps`);
    setLiveText('liveOsdFps', `${fps.toFixed(1)} fps`);
  }
  setLiveText('liveTlmFrames', String(liveFrames));
  if (width && height) {
    setLiveText('liveTlmResolution', `${width} x ${height}`);
    setLiveText('liveOsdResolution', `${width} x ${height}`);
  }
  setLiveText('liveOsdClock', new Date().toLocaleTimeString());
}

/** Pre-flight: one-frame request so we know whether a device is actually bound. */
async function preflightMjpegStream(index) {
  const query = index >= 0 ? `?frames=1&index=${index}` : '?frames=1';
  try {
    const res = await fetch(`${liveBaseApi()}/api/v1/stream/live-mjpeg${query}`);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      return { ok: true, bytes: buffer.byteLength };
    }
    let detail = null;
    try { detail = (await res.json()).detail; } catch (e) { detail = null; }
    return { ok: false, status: res.status, detail };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err) };
  }
}

async function startLiveFeed() {
  const modeSelect = document.getElementById('liveSourceMode');
  liveMode = modeSelect ? modeSelect.value : 'mjpeg';

  const img = document.getElementById('liveViewport');
  const canvas = document.getElementById('liveRadiometricCanvas');
  const osd = document.getElementById('liveOsd');
  const placeholder = document.getElementById('livePlaceholder');

  liveFrames = 0;
  liveFrameTimes = [];
  liveConsecutiveErrors = 0;
  liveLastMtime = 0;

  if (liveMode === 'mjpeg') {
    const index = parseInt(document.getElementById('liveVideoIndex')?.value, 10);

    setLiveState('pre-flighting video device');
    const probe = await preflightMjpegStream(isNaN(index) ? -1 : index);

    if (!probe.ok) {
      setLiveState('no video device');
      logLive(`MJPEG unavailable (HTTP ${probe.status}). The thermal camera is not UVC - ` +
        `switch Source Mode to "Radiometric polling" for a real thermal feed.`, 'warn');
      return;
    }

    liveActive = true;
    if (canvas) canvas.classList.add('hidden');
    if (placeholder) placeholder.classList.add('hidden');
    if (osd) osd.classList.remove('hidden');
    if (img) {
      img.classList.remove('hidden');
      img.onload = function () {
        registerLiveFrame(img.naturalWidth, img.naturalHeight);
      };
      const query = (isNaN(index) || index < 0) ? '' : `?index=${index}`;
      img.src = `${liveBaseApi()}/api/v1/stream/live-mjpeg${query}`;
    }
    setLiveText('liveOsdMode', 'MJPEG');
    setLiveState('streaming (mjpeg)');
    logLive(`MJPEG stream started (pre-flight frame ${probe.bytes} bytes). ` +
      `Check the resolution readout matches the source you intend to view.`, 'ok');
  } else {
    liveActive = true;
    if (img) {
      img.classList.add('hidden');
      img.removeAttribute('src');
    }
    if (canvas) canvas.classList.remove('hidden');
    if (placeholder) placeholder.classList.add('hidden');
    if (osd) osd.classList.remove('hidden');
    setLiveText('liveOsdMode', 'RADIOMETRIC');
    setLiveState('streaming (radiometric)');
    logLive(`Radiometric polling started at ${LIVE_TARGET_FPS} Hz on ${liveBaseApi()}/api/v1/thermal-frame`, 'ok');

    await pollRadiometricFrame();
    livePollTimer = setInterval(pollRadiometricFrame, LIVE_POLL_INTERVAL_MS);
  }
}

function stopLiveFeed() {
  liveActive = false;

  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }

  const img = document.getElementById('liveViewport');
  if (img) {
    img.onload = null;
    img.removeAttribute('src');     // dropping src closes the MJPEG response
    img.classList.add('hidden');
  }

  const canvas = document.getElementById('liveRadiometricCanvas');
  if (canvas) canvas.classList.add('hidden');

  const osd = document.getElementById('liveOsd');
  if (osd) osd.classList.add('hidden');

  const placeholder = document.getElementById('livePlaceholder');
  if (placeholder) placeholder.classList.remove('hidden');

  setLiveState('idle');
  setLiveText('liveTlmFps', '--');
  logLive('Live feed stopped.');
}

function toggleLiveFeed() {
  const button = document.getElementById('btnLiveStart');
  if (liveActive) {
    stopLiveFeed();
    if (button) button.innerText = 'START LIVE';
  } else {
    if (button) button.innerText = 'STOP LIVE';
    startLiveFeed();
  }
}

// --- RADIOMETRIC POLLING (hardware-free thermal feed) ---
async function pollRadiometricFrame() {
  if (!liveActive || liveMode !== 'radiometric') return;

  const canvas = document.getElementById('liveRadiometricCanvas');
  const endpoint = `${liveBaseApi()}/api/v1/thermal-frame?if_modified_since=${liveLastMtime}`;

  try {
    const res = await fetch(endpoint);
    if (res.status === 204) return;          // no new capture on the card yet
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    liveConsecutiveErrors = 0;
    if (payload.mtime) liveLastMtime = payload.mtime;

    const drawn = drawMatrixToCanvas(payload.data, canvas);
    registerLiveFrame(drawn ? drawn.width : payload.width, drawn ? drawn.height : payload.height);

    setLiveText('liveTlmThermal', payload.filename || '(unsaved)');
    if (drawn) {
      setLiveText('liveTlmTemps', `${drawn.min.toFixed(2)} / ${drawn.max.toFixed(2)} \u00B0C`);
    } else {
      setLiveText('liveTlmTemps', `${payload.min_temp} / ${payload.max_temp} \u00B0C`);
    }
  } catch (err) {
    liveConsecutiveErrors++;
    logLive(`Radiometric poll failed (${liveConsecutiveErrors}/5): ${err.message}`, 'warn');
    if (liveConsecutiveErrors >= 5) {
      logLive('Stopping after 5 consecutive poll failures - check the collector endpoint.', 'error');
      stopLiveFeed();
    }
  }
}

// --- SNAPSHOT TRIGGER + HAND-OFF ---
async function triggerSnapshotAndAnalyze() {
  const panel = document.getElementById('liveCaptureResult');
  const waitSeconds = 4;
  if (panel) panel.innerText = 'Coordinating snapshot\u2026';
  setLiveState('triggering snapshot');

  try {
    const res = await fetch(`${liveBaseApi()}/api/v1/camera/trigger-snapshot?wait_seconds=${waitSeconds}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
    logLive(`Snapshot captured: ${payload.filename} (${payload.width} x ${payload.height}), ` +
      `trigger=${payload.trigger}, new files=${payload.newFilesDetected.length}`, 'ok');

    if (panel) {
      panel.innerHTML = `
        <div class="space-y-1">
          <div class="text-emerald-400 font-bold">CAPTURE RECEIVED</div>
          <div>File: <span class="text-slate-200">${payload.filename}</span></div>
          <div>Size: <span class="text-slate-200">${payload.width} x ${payload.height}</span></div>
          <div>Range: <span class="text-slate-200">${payload.min_temp} .. ${payload.max_temp} \u00B0C</span></div>
          <div>Trigger: <span class="text-slate-200">${payload.trigger}</span>${payload.externalCommandError
            ? ` <span class="text-amber-400">(${payload.externalCommandError})</span>` : ''}</div>
          <div class="pt-1 flex flex-wrap gap-2">
            <a href="index.html" class="px-2 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200">Ingest in workbench</a>
            <a href="micro_inspector.html" class="px-2 py-1 rounded border border-cyan-800 bg-slate-800 hover:bg-cyan-900/40 text-cyan-400">Inspect micro-patch</a>
          </div>
        </div>`;
    }
  } catch (err) {
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
    logLive(`Snapshot failed: ${err.message}`, 'error');
    if (panel) panel.innerHTML = `<span class="text-rose-400">Snapshot failed: ${err.message}</span>`;
  }
}

// --- DEVICE PROBE ---
async function probeStreamDevices() {
  setLiveState('probing capture devices');
  try {
    const res = await fetch(`${liveBaseApi()}/api/v1/stream/devices?probe=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const devices = payload.devices || [];
    const active = payload.driver && payload.driver.device;

    setLiveText('liveTlmDevice', active ? `index ${active.index} / ${active.backend}` : 'none bound');

    if (!devices.length) {
      logLive('Probe found no video capture device on the collector host. ' +
        'Expected for an E8-XT (mass storage only) - use radiometric polling.', 'warn');
    } else {
      devices.forEach(d => logLive(`device index ${d.index} via ${d.backend}: ${d.width} x ${d.height} @ ${d.fps} fps`));
      logLive('Bind a device with FLIR_VIDEO_INDEX, ?index=N or the Video Index field.', 'ok');
    }
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
  } catch (err) {
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
    logLive(`Device probe failed: ${err.message}`, 'error');
  }
}

// Boot: point the collector field at the Pi (remembered value, else page-derived host)
window.onload = function () {
  if (typeof prefillCollectorEndpoint === 'function') prefillCollectorEndpoint('liveApiUrl');
};
