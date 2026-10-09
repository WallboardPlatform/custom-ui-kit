import { createWallboardClient, WB, readCompleteList, type WbDevice, type WbPage, type WallboardClient } from '@wallboard/custom-ui-kit';
import '@wallboard/custom-ui-kit/theme.css';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let client: WallboardClient | undefined; let scope: number | null = null; let generation = 0;
const origin = new URLSearchParams(location.search).get('server') || import.meta.env.VITE_WB_SERVER_URL || sessionStorage.getItem('wb:example:server');
const serverInput = $<HTMLInputElement>('server'); if (origin) serverInput.value = origin;

async function load() {
  const request = ++generation;
  $('devices').replaceChildren();
  if (!client || !scope) { $('data-message').textContent = 'Choose a customer to load its devices.'; return; }
  $('data-message').textContent = 'Loading…';
  try {
    const page = await client.api.forCustomer(scope).get<WbPage<WbDevice>>(WB.device, { query: { page: 0, size: 100, select: 'id,name,deviceStatus,platform', sort: 'name,asc' } });
    if (request !== generation) return;
    const devices = Array.isArray(page) ? page : page.content;
    $('data-message').textContent = devices.length ? '' : 'No devices to show.';
    for (const device of devices) {
      const card = document.createElement('article'); card.className = 'wb-card wb-device';
      const icon = document.createElement('div'); icon.className = 'wb-device-icon'; icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h3'); title.textContent = device.name || 'Unnamed device';
      const platform = document.createElement('p'); platform.textContent = device.platform || 'Platform unavailable';
      const status = document.createElement('span'); status.className = 'wb-status' + (device.deviceStatus === 'ONLINE' ? '' : ' wb-status-offline'); status.textContent = device.deviceStatus === 'ONLINE' ? 'Online' : 'Not online';
      card.append(icon, title, platform, status); $('devices').append(card);
    }
  } catch (error) { if (request === generation) $('data-message').textContent = error instanceof Error ? error.message : 'Request failed.'; }
}

async function connect(serverUrl: string, startLogin = false) {
  sessionStorage.setItem('wb:example:server', serverUrl);
  client = createWallboardClient({ serverUrl, clientId: import.meta.env.VITE_WB_CLIENT_ID || undefined });
  client.subscribe((state) => { $('message').textContent = state.error?.message || (state.status === 'checking' ? 'Connecting…' : ''); });
  const state = await client.initialize();
  if (state.status !== 'authenticated') { if (startLogin) await client.signIn(); return; }
  $('connection').hidden = true; $('dashboard').hidden = false; $('sign-out').hidden = false;
  scope = state.user?.role === 'ADMIN' ? null : state.user?.customerId ?? null;
  if (state.user?.role === 'ADMIN') {
    const list = await readCompleteList<{id:number;name:string}>(client.api, WB.customer, { instance: true, select: 'id,name', size: 100, sort: 'name,asc' });
    for (const customer of list) { const option = document.createElement('option'); option.value = String(customer.id); option.textContent = customer.name; $('customer').append(option); }
    $('scope').hidden = false;
  }
  await load();
}
$('server-form').addEventListener('submit', (event) => { event.preventDefault(); const server = serverInput.value; const url = new URL(location.href); url.searchParams.set('server', server); history.replaceState(null, '', url); void connect(server, true).catch((error) => { $('message').textContent = error instanceof Error ? error.message : 'Connection failed.'; }); });
$('customer').addEventListener('change', () => { const value = $<HTMLSelectElement>('customer').value; scope = value ? Number(value) : null; void load(); });
$('refresh').addEventListener('click', () => { void load(); });
$('sign-out').addEventListener('click', () => { generation++; client?.signOut(); location.reload(); });
if (origin) void connect(origin).catch((error) => { $('message').textContent = error instanceof Error ? error.message : 'Connection failed.'; });
