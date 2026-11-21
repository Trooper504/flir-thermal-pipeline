// Live view controller. "mjpeg" proxies the collector's bound video device; "radiometric"
// polls the Planck-calibrated matrix at 9 Hz and paints it to a canvas. What the host
// actually exposes is probed (probeStreamCapabilities), not assumed.

const LIVE_TARGET_FPS = 9;
const LIVE_POLL_INTERVAL_MS = Math.round(1000 / LIVE_TARGET_FPS);   // ~111 ms
const LIVE_PALETTE = [
  [0.00, 0, 0, 0], [0.50, 128, 128, 128], [1.00, 255, 255, 255]
];

let liveActive = false;
let liveMode = 'mjpeg';
let liveFrames = 0;
let liveFrameTimes = [];
let livePollTimer = null;
let liveLastMtime = 0;
let liveConsecutiveErrors = 0;
let liveOffscreen = null;
let liveLastProbeCached = false;   // drives the "fresh" flag on the next capability probe

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
  const colors = { info: 'text-neutral-600', warn: 'text-neutral-700', error: 'text-neutral-700', ok: 'text-neutral-700' };
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

// --- Grayscale ramp and canvas painting (radiometric mode) ---
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
  return [255, 255, 255];
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

// --- Stream control ---
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

// Pre-flight: one-frame request so we know whether a device is actually bound.
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

// --- Radiometric polling ---
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

// --- Snapshot trigger and hand-off ---
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
          <div class="text-neutral-700 font-bold">CAPTURE RECEIVED</div>
          <div>File: <span class="text-neutral-900">${payload.filename}</span></div>
          <div>Size: <span class="text-neutral-900">${payload.width} x ${payload.height}</span></div>
          <div>Range: <span class="text-neutral-900">${payload.min_temp} .. ${payload.max_temp} \u00B0C</span></div>
          <div>Trigger: <span class="text-neutral-900">${payload.trigger}</span>${payload.externalCommandError
            ? ` <span class="text-neutral-700">(${payload.externalCommandError})</span>` : ''}</div>
          <div class="pt-1 flex flex-wrap gap-2">
            <a href="index.html" class="px-2 py-1 border border-neutral-400 bg-neutral-100 hover:bg-neutral-200 text-neutral-900">Ingest in workbench</a>
            <a href="micro_inspector.html" class="px-2 py-1 border border-neutral-400 bg-neutral-100 hover:bg-neutral-200 text-neutral-700">Inspect micro-patch</a>
          </div>
        </div>`;
    }
  } catch (err) {
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
    logLive(`Snapshot failed: ${err.message}`, 'error');
    if (panel) panel.innerHTML = `<span class="text-neutral-700">Snapshot failed: ${err.message}</span>`;
  }
}

// --- Device probe ---
async function probeStreamDevices() {
  setLiveState('probing capture devices');
  try {
    const res = await fetch(`${liveBaseApi()}/api/v1/stream/devices?capabilities=true`);
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

// --- UVC capability probe: negotiated fourcc, interface class, formats, controls ---
const LIVE_PIXEL_CLASS_LABEL = {
  'radiometric-16-bit': { text: 'RADIOMETRIC 16-bit', cls: 'text-neutral-700' },
  '8-bit-viewfinder': { text: '8-bit viewfinder', cls: 'text-neutral-700' },
  'metadata-only': { text: 'metadata node', cls: 'text-neutral-600' },
  unknown: { text: 'format unknown', cls: 'text-neutral-500' }
};

const LIVE_VERDICT_LABEL = {
  'scenario-b-radiometric-y16': { title: 'SCENARIO B - 16-BIT RADIOMETRIC FORMATS', cls: 'text-neutral-700', level: 'ok' },
  'scenario-a-8-bit-viewfinder': { title: 'SCENARIO A - 8-BIT VIEWFINDER ONLY', cls: 'text-neutral-700', level: 'warn' },
  'metadata-nodes-only': { title: 'METADATA NODES ONLY - NO IMAGE STREAM', cls: 'text-neutral-700', level: 'warn' },
  'no-capture-device': { title: 'NO VIDEO CAPTURE DEVICE ON THIS HOST', cls: 'text-neutral-800', level: 'warn' },
  'capture-device-unclassified': { title: 'CAPTURE DEVICE - FORMAT NOT REPORTED', cls: 'text-neutral-800', level: 'info' }
};

// Device names and control names come from USB descriptors and kernel drivers, so they are
// escaped before they reach innerHTML.
function escapeLiveValue(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Pixel-class badge; unrecognised formats stay "unknown" instead of being guessed at.
function livePixelClassMarkup(pixelClass) {
  const known = LIVE_PIXEL_CLASS_LABEL[pixelClass] || LIVE_PIXEL_CLASS_LABEL.unknown;
  return `<span class="${known.cls}">${known.text}</span>`;
}

// Renders a capability-probe payload. Pure (no DOM access), so it can be verified directly.
function buildLiveCapabilitiesHtml(payload) {
  const caps = payload && payload.capabilities;
  if (!caps) {
    return `<div class="text-neutral-700">This collector answered without a capability block - restart it with the ` +
      `updated <span class="text-neutral-800">live_stream_driver.py</span>.</div>`;
  }

  const summary = caps.summary || {};
  const verdict = LIVE_VERDICT_LABEL[summary.verdict] ||
    { title: String(summary.verdict || 'unknown verdict'), cls: 'text-neutral-800' };
  const devices = caps.devices || [];

  const rows = devices.map(device => {
    const sysfs = device.sysfs || {};
    const v4l2 = device.v4l2 || {};
    const frameTest = device.frameTest || {};

    const usb = sysfs.idVendor
      ? `${escapeLiveValue(sysfs.idVendor)}:${escapeLiveValue(sysfs.idProduct)} ${escapeLiveValue(sysfs.manufacturer || sysfs.product || '')}`
      : 'no sysfs entry';
    const interfaceClass = sysfs.bInterfaceClass
      ? `${escapeLiveValue(sysfs.bInterfaceClass)} ${escapeLiveValue(sysfs.bInterfaceClassName)} / sub ` +
        `${escapeLiveValue(sysfs.bInterfaceSubClass)} ${escapeLiveValue(sysfs.bInterfaceSubClassName)}`
      : 'unknown';

    const formats = (v4l2.formats || []).map(format =>
      `<div class="pl-2">${escapeLiveValue(format.fourcc || '?')} &mdash; ${escapeLiveValue(format.description || 'no description')} ` +
      `[${livePixelClassMarkup(format.pixelClass)}]${format.sizes && format.sizes.length ? ' ' + escapeLiveValue(format.sizes.join(', ')) : ''}` +
      `${format.frameRates && format.frameRates.length ? ' @ ' + escapeLiveValue(format.frameRates.join(', ')) + ' fps' : ''}</div>`
    ).join('') || `<div class="pl-2 text-neutral-500">${escapeLiveValue(v4l2.reason || (v4l2.errors && v4l2.errors[0]) || 'no formats reported')}</div>`;

    const xu = (((v4l2.controls || {}).xuCandidates) || []).map(control =>
      `<div class="pl-2 text-neutral-700">${escapeLiveValue(control.name)} ` +
      `<span class="text-neutral-500">${escapeLiveValue(control.id)} ${escapeLiveValue(control.detail)}</span></div>`
    ).join('');

    const frameLine = frameTest.tested
      ? (frameTest.ok === true
        ? `<span class="text-neutral-700">frame received</span> ${escapeLiveValue((frameTest.shape || []).join('x'))} ${escapeLiveValue(frameTest.dtype)}`
        : (frameTest.ok === false
          ? `<span class="text-neutral-700">no frame</span> ${escapeLiveValue(frameTest.reason)}`
          : `<span class="text-neutral-700">no verdict</span> ${escapeLiveValue(frameTest.reason)}`))
      : `<span class="text-neutral-500">not tested</span> ${escapeLiveValue(frameTest.reason)}`;

    return `
      <div class="pt-2 border-t border-neutral-300">
        <div class="text-neutral-900">index ${escapeLiveValue(device.index)} via ${escapeLiveValue(device.backend)}${device.node ? ' &mdash; ' + escapeLiveValue(device.node) : ''}${device.opened === false ? ' <span class="text-neutral-700">did not open</span>' : ''}</div>
        <div>Format: ${device.fourcc ? escapeLiveValue(device.fourcc) : '<span class="text-neutral-500">not reported</span>'} ${livePixelClassMarkup(device.pixelClass)}${device.width ? ' &middot; ' + escapeLiveValue(device.width + ' x ' + device.height) : ''}${device.fps ? ' @ ' + escapeLiveValue(device.fps) + ' fps' : ''}</div>
        <div>Frame test: ${frameLine}</div>
        <div>USB: ${usb}</div>
        <div>Interface class: ${interfaceClass}</div>
        <div>Advertised formats:${formats}</div>
        ${v4l2.captureType ? `<div>Capture type: ${escapeLiveValue(v4l2.captureType)}${v4l2.isMetadataNode ? ' <span class="text-neutral-700">(metadata node: opens, never streams)</span>' : ''}</div>` : ''}
        ${xu ? `<div>XU / vendor control candidates:${xu}</div>` : ''}
        ${frameTest.rawDepthHint ? `<div class="text-neutral-700">${escapeLiveValue(frameTest.rawDepthHint)}</div>` : ''}
      </div>`;
  }).join('');

  const notes = (summary.notes || [])
    .map(note => `<div class="pl-2 text-neutral-500">- ${escapeLiveValue(note)}</div>`)
    .join('');

  // Distinguishes a denied camera policy from a wedged device.
  const access = caps.hostCameraAccess || {};
  const accessLine = access.checked
    ? (access.blocked
      ? `<span class="text-neutral-700">host camera access: denied</span> ` +
        `<span class="text-neutral-500">(desktop apps ${escapeLiveValue(access.desktopApps || 'unknown')} &middot; user ${escapeLiveValue(access.userConsent || 'unset')} &middot; machine ${escapeLiveValue(access.machineConsent || 'unset')} &mdash; grant access in Windows privacy settings before blaming the device)</span>`
      : `<span class="text-neutral-700">host camera access: allowed</span> ` +
        `<span class="text-neutral-500">(desktop apps ${escapeLiveValue(access.desktopApps || 'unset')})</span>`)
    : `<span class="text-neutral-500">host camera access: not checked${access.note ? ' &mdash; ' + escapeLiveValue(access.note) : ''}</span>`;

  return `
    <div class="${verdict.cls} font-bold">${escapeLiveValue(verdict.title)}</div>
    <div class="text-neutral-800 pt-1">${escapeLiveValue(summary.meaning || '')}</div>
    <div class="pt-1 text-neutral-500">UVC interface present: ${summary.uvcInterfacePresent ? 'yes' : 'no'} &middot; capture devices: ${escapeLiveValue(summary.captureDeviceCount)} &middot; metadata nodes: ${escapeLiveValue(summary.metadataNodeCount)}</div>
    ${caps.hostCameraAccess ? `<div>${accessLine}</div>` : ''}
    <div class="text-neutral-500">platform ${escapeLiveValue(caps.platform)} &middot; v4l2-ctl: ${caps.v4l2Tool ? escapeLiveValue(caps.v4l2Tool) : 'not available'} &middot; read test: ${caps.readTest ? 'on' : 'off'} &middot; scanned ${escapeLiveValue(caps.probeLimit)} index(es) in ${escapeLiveValue(caps.scanSeconds)}s${caps.scanTruncated ? ' <span class="text-neutral-700">(scan stopped at the time budget)</span>' : ''}${caps.cached ? ' <span class="text-neutral-600">(cached, ' + escapeLiveValue(caps.cacheAgeSeconds) + 's old - press again for a fresh sweep)</span>' : ''}</div>
    ${rows || '<div class="pt-2 text-neutral-500">No capture index opened on the collector host.</div>'}
    ${notes ? `<div class="pt-2 border-t border-neutral-300">${notes}</div>` : ''}`;
}

async function probeStreamCapabilities() {
  const panel = document.getElementById('liveCapabilities');
  const readTestEl = document.getElementById('liveReadTest');
  const readTest = !!(readTestEl && readTestEl.checked);
  // Explicit re-probe: probing is the one action that can disturb the device stack.
  const fresh = liveLastProbeCached ? 'true' : 'false';

  setLiveState('probing capabilities');
  if (panel) panel.innerText = 'Probing capture interfaces\u2026';

  try {
    const url = `${liveBaseApi()}/api/v1/stream/devices?capabilities=true` +
      `&read_test=${readTest}&fresh=${fresh}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    if (panel) panel.innerHTML = buildLiveCapabilitiesHtml(payload);

    if (!payload.capabilities) {
      logLive('Collector answered without a capability block - restart it with the updated ' +
        'edge_collector/live_stream_driver.py.', 'warn');
      setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
      return;
    }

    const caps = payload.capabilities;
    const summary = caps.summary || {};
    const devices = caps.devices || [];
    const verdict = LIVE_VERDICT_LABEL[summary.verdict];
    liveLastProbeCached = !!caps.cached;

    logLive(`Capability probe: ${verdict ? verdict.title : summary.verdict} ` +
      `(${devices.length} index(es) open in ${caps.scanSeconds}s, read test ${readTest ? 'on' : 'off'}` +
      `${caps.cached ? `, served from the ${escapeLiveValue(caps.cacheAgeSeconds)}s-old result` : ''})`,
      verdict ? verdict.level : 'info');
    if (caps.scanTruncated) {
      logLive('The scan stopped at its time budget before every index was inspected; use the ' +
        'Video Index field or ?max_index=N to look at one explicitly.', 'warn');
    }

    devices.forEach(device => {
      const frame = device.frameTest && device.frameTest.tested
        ? (device.frameTest.ok ? ' - frame received' : ' - no frame')
        : '';
      logLive(`index ${device.index} via ${device.backend}: ${device.fourcc || 'no fourcc'} / ` +
        `${device.pixelClass}${device.node ? ' on ' + device.node : ''}${frame}`);
    });
    (summary.notes || []).forEach(note => logLive(note, 'info'));

    if (summary.uvcInterfacePresent === false && devices.length) {
      logLive('No USB Video Class interface (bInterfaceClass 0x0e) behind the open nodes, so ' +
        'the collector\'s "not UVC" note holds for this host.', 'ok');
    } else if (summary.uvcInterfacePresent) {
      logLive('A USB Video Class interface is present - the "not UVC" note in the collector and ' +
        'README needs revisiting for this hardware.', 'warn');
    }
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
  } catch (err) {
    setLiveState(liveActive ? `streaming (${liveMode})` : 'idle');
    if (panel) panel.innerHTML = `<span class="text-neutral-700">Capability probe failed: ` +
      `${escapeLiveValue(err.message)}</span>`;
    logLive(`Capability probe failed: ${err.message}`, 'error');
  }
}

// Boot: point the collector field at the Pi (remembered value, else page-derived host)
window.onload = function () {
  if (typeof prefillCollectorEndpoint === 'function') prefillCollectorEndpoint('liveApiUrl');
};
