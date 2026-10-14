import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 8747);
const bundle = await readFile(new URL('../../dist/examples/embedded/index.html', import.meta.url));
const activeTokens = new Map();
let tokenNumber = 0;
const devices = Array.from({ length: 37 }, (_, index) => ({
  id: `synthetic-screen-${index + 1}`,
  name: `${['Lobby', 'Meeting room', 'Reception', 'Cafeteria'][index % 4]} ${String(index + 1).padStart(2, '0')}`,
  deviceStatus: index % 3 ? 'ONLINE' : 'OFFLINE', platform: ['ANDROID', 'WINDOWS', 'SAMSUNG', 'LG'][index % 4],
}));
const identity = { email: 'synthetic@example.test', name: 'Synthetic customer owner', role: 'OWNER', customerId: 42, readOnly: true };
const hostHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded UI protocol fixture</title>
<style>body{margin:0;font:14px system-ui;background:#e5edf4;color:#23384b}header{padding:16px 22px;background:white;display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:17px;margin:0}p{margin:0}button{padding:8px 12px;border:1px solid #bed0df;border-radius:6px;background:white;cursor:pointer}#status,#consent{padding:12px 22px}#runtime{height:calc(100vh - 210px);min-height:480px}iframe{width:100%;height:100%;border:0}</style>
<header><div><h1>Local embedded UI protocol fixture</h1><p>Synthetic identity/data only. This is not the production CMS.</p></div><button id="initialize">Open app</button><button id="expire">Expire parent fixture credential</button><button id="reload">Reload iframe</button><button id="disable">Disable app</button><button id="logout">Log out fixture</button><span id="count">Proxy calls: 0</span></header>
<div id="consent" hidden><p><strong id="mode"></strong></p><ul id="operations"></ul><button id="approve">Approve app permissions</button><button id="deny">Decline</button></div><p id="status">Open the isolated app to receive its declaration. No identity or API access is supplied before approval.</p><div id="runtime"></div>
<script>
const protocol = 'wallboard.custom-ui', identity = ${JSON.stringify(identity)};
let frame, channel, nonce, manifest, approved = false, generation = 0, enabled = true, signedIn = true, loaded = false, calls = 0, credential;
const inflight = new Map();
const message = value => ({ protocol, version: 2, ...value });
const status = text => document.getElementById('status').textContent = text;
function close(reason) {
  generation++; for (const controller of inflight.values()) controller.abort(); inflight.clear();
  if (channel) { channel.close(); channel = null; }
  if (frame) { frame.remove(); frame = null; }
  approved = false; manifest = null; document.getElementById('consent').hidden = true; status(reason);
}
function ready() {
  if (approved && loaded && channel) channel.postMessage(message({ type: 'context', context: { appId: 17, name: 'Fleet overview', customerId: 42, serverUrl: location.origin, readOnly: identity.readOnly || manifest.readOnly, manifest, user: identity } }));
}
function readManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['readOnly', 'operations'].includes(key)) || typeof value.readOnly !== 'boolean' || !Array.isArray(value.operations) || value.operations.length > 128) throw new Error('Invalid app manifest.');
  const seen = new Set();
  const operations = value.operations.map(operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) || Object.keys(operation).some(key => !['method', 'path', 'description'].includes(key)) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method) || typeof operation.path !== 'string' || operation.path.length > 2048 || !operation.path.startsWith('/api/') || (operation.description !== undefined && (typeof operation.description !== 'string' || operation.description.length > 500))) throw new Error('Invalid app operation.');
    const segments = operation.path.split('/').slice(2);
    const literal = /^[A-Za-z0-9_-]+$/, placeholder = /^\\{[A-Za-z][A-Za-z0-9_]*\\}$/;
    if (!segments.length || !literal.test(segments[0]) || segments.some(segment => !literal.test(segment) && !placeholder.test(segment))) throw new Error('Invalid app path.');
    const key = operation.method + ' ' + operation.path; if (seen.has(key)) throw new Error('Duplicate app operation.'); seen.add(key);
    return Object.freeze({ method: operation.method, path: operation.path, ...(operation.description === undefined ? {} : { description: operation.description }) });
  });
  return Object.freeze({ readOnly: value.readOnly, operations: Object.freeze(operations) });
}
async function getCredential() {
  if (!credential || credential.expiresAt <= Date.now()) credential = await (await fetch('/fixture/token', { method: 'POST' })).json();
  return credential.accessToken;
}
function launch() {
  close('Initializing isolated app with zero API access…'); enabled = true; signedIn = true; loaded = false;
  nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const url = new URL('/app/index.html', location.origin);
  url.search = new URLSearchParams({ wbEmbedVersion: '2', wbParentOrigin: location.origin, wbEmbedNonce: nonce }).toString();
  frame = document.createElement('iframe'); frame.title = 'Synthetic Fleet overview'; frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'; frame.src = url;
  frame.addEventListener('load', () => { if (loaded) { close('Iframe navigated or reloaded. Approve a fresh launch.'); return; } loaded = true; ready(); });
  document.getElementById('runtime').append(frame);
}
window.addEventListener('message', event => {
  const data = event.data;
  if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || !data || typeof data !== 'object' || Object.keys(data).length !== 5 || data.protocol !== protocol || data.version !== 2 || data.type !== 'connect' || data.nonce !== nonce || event.ports.length !== 1) { for (const port of event.ports) port.close(); return; }
  if (channel) { for (const port of event.ports) port.close(); close('App attempted to reconnect. Open a fresh app instance.'); return; }
  try { manifest = readManifest(data.manifest); } catch (error) { for (const port of event.ports) port.close(); close(error.message); return; }
  channel = event.ports[0]; const connectedPort = channel; const currentGeneration = generation;
  const reply = value => { if (currentGeneration === generation && channel === connectedPort) connectedPort.postMessage(message(value)); };
  channel.onmessage = async event => {
    const request = event.data;
    if (!request || request.protocol !== protocol || request.version !== 2 || typeof request.requestId !== 'string' || request.requestId.length > 80) return;
    if (request.type === 'api-cancel') { inflight.get(request.requestId)?.abort(); return; }
    if (request.type !== 'api-request') return;
    if (!approved) { reply({ type: 'error', requestId: request.requestId, code: 'CONSENT_REQUIRED', message: 'Approve this app before requesting Wallboard data.', status: 403 }); return; }
    if (!enabled || !signedIn || currentGeneration !== generation) { close('The fixture app is no longer available.'); return; }
    if (request.method !== 'GET' || request.path !== '/api/v2/device' || !manifest.operations.some(operation => operation.method === request.method && operation.path === request.path) || request.body !== undefined || request.headers !== undefined) {
      reply({ type: 'error', requestId: request.requestId, code: 'PERMISSION_DENIED', message: 'Only the approved device-read operation is allowed.', status: 403 }); return;
    }
    const controller = new AbortController(); inflight.set(request.requestId, controller);
    try {
      const url = new URL(request.path, location.origin);
      for (const [key, value] of Object.entries(request.params ?? {})) {
        if (!['page', 'size', 'sort', 'select', 'customerId'].includes(key)) throw new Error('Unapproved query parameter.');
        for (const item of Array.isArray(value) ? value : [value]) { if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Invalid query value.'); url.searchParams.append(key, String(item)); }
      }
      const send = async () => fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + await getCredential() }, signal: controller.signal, redirect: 'error' });
      let response = await send(); if (response.status === 401) { credential = null; response = await send(); }
      const body = await response.json();
      reply({ type: 'api-response', requestId: request.requestId, status: response.status, body, contentType: 'application/json' });
      document.getElementById('count').textContent = 'Proxy calls: ' + (++calls); status('Opaque frame connected. Parent performs approved API calls; no token leaves the parent.');
    } catch (error) { if (!controller.signal.aborted) reply({ type: 'error', requestId: request.requestId, code: 'REQUEST_FAILED', message: error.message }); }
    finally { inflight.delete(request.requestId); }
  };
  channel.start();
  document.getElementById('mode').textContent = 'Read-only synthetic account; app declares ' + (manifest.readOnly ? 'read-only' : 'write-capable') + ' mode.';
  const list = document.getElementById('operations'); list.replaceChildren();
  for (const operation of manifest.operations) { const item = document.createElement('li'); item.textContent = operation.method + ' ' + operation.path + (operation.description ? ' — ' + operation.description : ''); list.append(item); }
  document.getElementById('consent').hidden = false; status('Declaration received. Identity and API proxy remain unavailable until approval.');
});
document.getElementById('initialize').onclick = launch;
document.getElementById('approve').onclick = () => { if (!manifest || !channel || !enabled || !signedIn) return; approved = true; document.getElementById('consent').hidden = true; ready(); };
document.getElementById('deny').onclick = () => { channel?.postMessage(message({ type: 'error', code: 'CONSENT_DENIED', message: 'The user declined this app.' })); close('App declined. No identity or API access supplied.'); };
document.getElementById('expire').onclick = async () => { await fetch('/fixture/expire', { method: 'POST' }); status('Parent fixture credential expired. Refresh screens to exercise parent renewal after a 401.'); };
document.getElementById('reload').onclick = () => { if (frame) frame.src = frame.src; };
document.getElementById('disable').onclick = () => { enabled = false; close('Fixture app disabled. Proxy closed; pending calls cancelled.'); };
document.getElementById('logout').onclick = () => { signedIn = false; credential = null; close('Fixture logged out. App frame destroyed.'); };
</script></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(hostHtml); return; }
  if (url.pathname === '/app/index.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'" }); response.end(bundle); return; }
  if (url.pathname === '/fixture/token' && request.method === 'POST') {
    const expiresAt = Date.now() + 1_800_000;
    // Deliberately invalid Wallboard credentials, retained in the synthetic parent only.
    const accessToken = `fixture-${++tokenNumber}-synthetic-only`; activeTokens.set(accessToken, expiresAt); json({ accessToken, expiresAt }); return;
  }
  if (url.pathname === '/fixture/expire' && request.method === 'POST') { activeTokens.clear(); json({ expired: true }); return; }
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  if (!token || (activeTokens.get(token) ?? 0) <= Date.now()) { json({ message: 'Synthetic fixture credential expired.' }, 401); return; }
  if (url.pathname === '/api/v2/device' && request.method === 'GET') {
    if (url.searchParams.get('customerId') !== '42') { json({ message: 'This synthetic fixture serves customer 42 only.' }, 403); return; }
    const page = Number(url.searchParams.get('page') ?? 0), size = Math.min(100, Number(url.searchParams.get('size') ?? 24));
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1) { json({ message: 'Invalid synthetic pagination.' }, 400); return; }
    json({ content: devices.slice(page * size, (page + 1) * size), number: page, size, totalElements: devices.length, totalPages: Math.ceil(devices.length / size), last: (page + 1) * size >= devices.length }); return;
  }
  json({ message: 'Synthetic fixture route not found.' }, 404);
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic embedded UI fixture: http://127.0.0.1:${port}`));
