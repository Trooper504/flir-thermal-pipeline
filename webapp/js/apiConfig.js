// Collector endpoint resolution: typed value -> localStorage -> page host:8081 -> localhost.
// The Pi serves the API and the workstation only runs these pages, so localhost is a poor default.
const API_DEFAULT_PORT = 8081;
const API_STORAGE_KEY = 'flir.collectorBase';

// Same host as the page, API port, when served over http(s).
function derivePageHostBase() {
  try {
    const loc = window.location;
    if (loc && /^https?:$/.test(loc.protocol) && loc.hostname) {
      return `${loc.protocol}//${loc.hostname}:${API_DEFAULT_PORT}`;
    }
  } catch (err) { /* file:// or restricted location: fall through */ }
  return `http://localhost:${API_DEFAULT_PORT}`;
}

function rememberedCollectorBase() {
  try {
    return window.localStorage.getItem(API_STORAGE_KEY) || '';
  } catch (err) {
    return '';                       // private mode / storage disabled
  }
}

function rememberCollectorBase(base) {
  const clean = normalizeCollectorBase(base);
  if (!clean) return;
  try {
    window.localStorage.setItem(API_STORAGE_KEY, clean);
  } catch (err) { /* ignore: remembering is best-effort */ }
}

// "192.168.1.42:8081/api/v1/thermal-frame/" -> "http://192.168.1.42:8081"
function normalizeCollectorBase(value) {
  let url = String(value === undefined || value === null ? '' : value).trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '').replace(/\/api\/v1\/.*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

// Collector base URL for this session (no trailing slash, no /api path).
function resolveCollectorBase(inputValue) {
  return normalizeCollectorBase(inputValue) || rememberedCollectorBase() || derivePageHostBase();
}

// Full endpoint URL, e.g. collectorEndpoint('/api/v1/stream/live-mjpeg', field.value).
function collectorEndpoint(suffix, inputValue) {
  return resolveCollectorBase(inputValue) + (suffix || '');
}

// Endpoint input onchange: normalise, append the frame path and remember it.
function persistCollectorEndpoint(input) {
  const el = input || document.getElementById('cfgApiUrl');
  if (!el) return;
  const clean = normalizeCollectorBase(el.value);
  if (!clean) return;
  el.value = `${clean}/api/v1/thermal-frame`;
  rememberCollectorBase(clean);
}

// Boot-time prefill for an endpoint input: remembered value, else page-derived.
function prefillCollectorEndpoint(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = `${rememberedCollectorBase() || derivePageHostBase()}/api/v1/thermal-frame`;
}
