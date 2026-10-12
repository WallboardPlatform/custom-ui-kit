import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 8747);
const bundle = await readFile(new URL('../../dist/examples/embedded/index.html', import.meta.url));
const activeTokens = new Map();
let tokenNumber = 0;
const devices = Array.from({ length: 37 }, (_, index) => ({
  id: `synthetic-screen-${index + 1}`,
  name: `${['Lobby', 'Meeting room', 'Reception', 'Cafeteria'][index % 4]} ${String(index + 1).padStart(2, '0')}`,
  deviceStatus: index % 3 ? 'ONLINE' : 'OFFLINE',
  platform: ['ANDROID', 'WINDOWS', 'SAMSUNG', 'LG'][index % 4],
}));
const identity = { email: 'synthetic@example.test', name: 'Synthetic customer owner', role: 'OWNER', customerId: 42, readOnly: true };
const hostHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded UI protocol fixture</title>
<style>body{margin:0;font:14px system-ui;background:#e5edf4;color:#23384b}header{padding:16px 22px;background:white;display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:17px;margin:0}p{margin:0}button{padding:8px 12px;border:1px solid #bed0df;border-radius:6px;background:white;cursor:pointer}#status{padding:12px 22px}#runtime{height:calc(100vh - 150px);min-height:480px}iframe{width:100%;height:100%;border:0}</style>
<header><div><h1>Local embedded UI protocol fixture</h1><p>Synthetic identity/data only. This is not the production CMS.</p></div><button id="launch">Open app</button><button id="expire">Expire fixture token</button><button id="reload">Reload iframe</button><button id="disable">Disable app</button><button id="logout">Log out fixture</button><span id="count">Token handoffs: 0</span></header><p id="status"></p><div id="runtime"></div>
<script>
const protocol = 'wallboard.custom-ui';
let frame, channel, nonce, generation = 0, enabled = true, signedIn = true, loaded = false, handoffs = 0;
const message = value => ({ protocol, version: 1, ...value });
const status = text => document.getElementById('status').textContent = text;
function close(reason) {
  generation++;
  if (channel) { channel.close(); channel = null; }
  if (frame) { frame.remove(); frame = null; }
  status(reason);
}
function ready() {
  if (loaded && channel) channel.postMessage(message({ type: 'ready', context: { appId: 17, name: 'Fleet overview', customerId: 42, serverUrl: location.origin } }));
}
function launch() {
  close('Connecting a fresh app instance…'); enabled = true; signedIn = true; loaded = false;
  nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const url = new URL('/app/index.html', location.origin);
  url.search = new URLSearchParams({ wbEmbedVersion: '1', wbParentOrigin: location.origin, wbEmbedNonce: nonce }).toString();
  frame = document.createElement('iframe'); frame.title = 'Synthetic Fleet overview'; frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'; frame.src = url;
  frame.addEventListener('load', () => { if (loaded) { close('Iframe navigated or reloaded. Open the app again.'); return; } loaded = true; ready(); });
  document.getElementById('runtime').append(frame);
}
window.addEventListener('message', event => {
  const data = event.data;
  if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || !data || typeof data !== 'object' || Object.keys(data).length !== 4 || data.protocol !== protocol || data.version !== 1 || data.type !== 'connect' || data.nonce !== nonce || event.ports.length !== 1 || channel) { for (const port of event.ports) port.close(); return; }
  channel = event.ports[0]; const connectedPort = channel; const currentGeneration = generation;
  channel.onmessage = async event => {
    const request = event.data;
    if (!request || request.protocol !== protocol || request.version !== 1 || request.type !== 'get-access-token' || typeof request.requestId !== 'string' || request.requestId.length > 80) return;
    if (!enabled || !signedIn || currentGeneration !== generation) { close('The fixture app is no longer available.'); return; }
    const response = await fetch('/fixture/token', { method: 'POST' }); const token = await response.json();
    if (currentGeneration !== generation || channel !== connectedPort) return;
    connectedPort.postMessage(message({ type: 'access-token', requestId: request.requestId, accessToken: token.accessToken, expiresAt: token.expiresAt }));
    document.getElementById('count').textContent = 'Token handoffs: ' + (++handoffs); status('Opaque frame connected. Customer 42; ordinary synthetic user token.');
  };
  channel.start(); ready();
});
document.getElementById('launch').onclick = launch;
document.getElementById('expire').onclick = async () => { await fetch('/fixture/expire', { method: 'POST' }); status('Fixture token expired. Refresh screens to exercise host renewal after a 401.'); };
document.getElementById('reload').onclick = () => { if (frame) frame.src = frame.src; };
document.getElementById('disable').onclick = () => { enabled = false; close('Fixture app disabled. New handoffs stopped; previously copied tokens retain normal validity.'); };
document.getElementById('logout').onclick = () => { signedIn = false; close('Fixture logged out. App frame destroyed.'); };
launch();
</script></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(hostHtml); return; }
  if (url.pathname === '/app/index.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'" }); response.end(bundle); return; }
  if (url.pathname === '/fixture/token' && request.method === 'POST') {
    const expiresAt = Date.now() + 1_800_000;
    const claims = { sub: identity.email, name: identity.name, scope: identity.role, customerId: 42, readOnly: true, fixtureTokenNumber: ++tokenNumber };
    // Deliberately not a valid Wallboard signature. This bearer exists only in this local fixture.
    const accessToken = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
    activeTokens.set(accessToken, expiresAt);
    json({ accessToken, expiresAt }); return;
  }
  if (url.pathname === '/fixture/expire' && request.method === 'POST') { activeTokens.clear(); json({ expired: true }); return; }
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  if (!token || (activeTokens.get(token) ?? 0) <= Date.now()) { json({ message: 'Synthetic fixture token expired.' }, 401); return; }
  if (url.pathname === '/api/v2/user/me') { json(identity); return; }
  if (url.pathname === '/api/v2/device') {
    if (url.searchParams.get('customerId') !== '42') { json({ message: 'This synthetic fixture serves customer 42 only.' }, 403); return; }
    const page = Number(url.searchParams.get('page') ?? 0);
    const size = Math.min(100, Number(url.searchParams.get('size') ?? 24));
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1) { json({ message: 'Invalid synthetic pagination.' }, 400); return; }
    json({ content: devices.slice(page * size, (page + 1) * size), number: page, size, totalElements: devices.length, totalPages: Math.ceil(devices.length / size), last: (page + 1) * size >= devices.length }); return;
  }
  json({ message: 'Synthetic fixture route not found.' }, 404);
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic embedded UI fixture: http://127.0.0.1:${port}`));
