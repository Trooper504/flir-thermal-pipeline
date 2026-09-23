// --- webapp/js/apiConfig.js ---
// Shared collector-endpoint resolution for a browser-only client.
//
// Deployment model: the Raspberry Pi owns the thermal camera and serves the REST API;
// the workstation only runs these HTML pages. That makes "localhost" the *wrong* default
// on the laptop, so the endpoint is resolved in this order:
//   1. an explicit value typed into the endpoint field (remembered per browser),
//   2. the last endpoint remembered in localStorage,
//   3. the page's own host at port 8081 (correct when the pages are served from the Pi),
//   4. http://localhost:8081 (single-machine development).
const API_DEFAULT_PORT = 8081;
const API_STORAGE_KEY = 'flir.collectorBase';

/** Same host as the page, API port, when the page is served over http(s). */
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

/** "192.168.1.42:8081/api/v1/thermal-frame/" -> "http://192.168.1.42:8081" */
function normalizeCollectorBase(value) {
  let url = String(value === undefined || value === null ? '' : value).trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '').replace(/\/api\/v1\/.*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** Collector base URL for this session (no trailing slash, no /api path). */
function resolveCollectorBase(inputValue) {
  return normalizeCollectorBase(inputValue) || rememberedCollectorBase() || derivePageHostBase();
}

/** Full endpoint URL, e.g. collectorEndpoint('/api/v1/stream/live-mjpeg', field.value). */
function collectorEndpoint(suffix, inputValue) {
  return resolveCollectorBase(inputValue) + (suffix || '');
}

/** Endpoint input onchange: normalise, append the frame path and remember it. */
function persistCollectorEndpoint(input) {
  const el = input || document.getElementById('cfgApiUrl');
  if (!el) return;
  const clean = normalizeCollectorBase(el.value);
  if (!clean) return;
  el.value = `${clean}/api/v1/thermal-frame`;
  rememberCollectorBase(clean);
}

/** Boot-time prefill for an endpoint input: remembered value, else page-derived. */
function prefillCollectorEndpoint(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = `${rememberedCollectorBase() || derivePageHostBase()}/api/v1/thermal-frame`;
}
