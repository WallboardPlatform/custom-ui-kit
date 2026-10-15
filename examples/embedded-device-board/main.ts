import { createEmbeddedWallboardClient, WB, type EmbeddedAppManifest, type WbDevice, type WbPage } from '@wallboard/custom-ui-kit';
import './style.css';
import manifest from './wallboard-ui.json';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function start() {
  let devices: WbDevice[] = [];
  let page = 0;
  let pages = 0;
  let loading = false;
  const client = createEmbeddedWallboardClient({ manifest: manifest as EmbeddedAppManifest });

  function render() {
    const query = element<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
    const status = element<HTMLSelectElement>('status').value;
    const visible = devices.filter(device => (!query || (device.name ?? '').toLocaleLowerCase().includes(query)) && (!status || device.deviceStatus === status));
    const cards = element('devices');
    cards.replaceChildren();
    for (const device of visible) {
      const card = document.createElement('article');
      card.className = 'device-card';
      const label = document.createElement('span');
      label.className = device.deviceStatus === 'ONLINE' ? 'status online' : 'status offline';
      label.textContent = device.deviceStatus === 'ONLINE' ? 'Online' : 'Not online';
      const title = document.createElement('h2');
      title.textContent = device.name || 'Unnamed screen';
      const platform = document.createElement('p');
      platform.className = 'muted';
      platform.textContent = typeof device.platform === 'string' ? device.platform : 'Platform unavailable';
      const id = document.createElement('p');
      id.className = 'device-id';
      id.textContent = `Screen ${device.id}`;
      card.append(label, title, platform, id);
      cards.append(card);
    }
    element('empty').hidden = loading || visible.length > 0;
    element('empty').textContent = devices.length ? 'No screens match these filters on this page.' : 'There are no screens to show.';
    element('page-count').textContent = pages ? `Page ${page + 1} of ${pages}` : 'No pages';
    element<HTMLButtonElement>('previous').disabled = loading || page === 0;
    element<HTMLButtonElement>('next').disabled = loading || page + 1 >= pages;
    element('loaded').textContent = String(devices.length);
    element('online').textContent = String(devices.filter(device => device.deviceStatus === 'ONLINE').length);
    element('offline').textContent = String(devices.filter(device => device.deviceStatus !== 'ONLINE').length);
  }

  async function load(nextPage = page) {
    if (loading) return;
    loading = true;
    element<HTMLButtonElement>('refresh').disabled = true;
    element('message').textContent = 'Loading screens…';
    render();
    try {
      const result = await client.api.get<WbPage<WbDevice>>(WB.device, {
        query: { page: nextPage, size: 24, sort: 'name,asc', select: 'id,name,deviceStatus,platform' },
      });
      if (!result || !Array.isArray(result.content) || !Number.isSafeInteger(result.totalPages) || result.totalPages < 0) throw new Error('Wallboard returned an unsupported screen list.');
      devices = result.content;
      page = nextPage;
      pages = result.totalPages;
      element('message').textContent = '';
      element('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (cause) {
      element('message').textContent = cause instanceof Error ? cause.message : 'Screens could not be loaded.';
    } finally {
      loading = false;
      element<HTMLButtonElement>('refresh').disabled = false;
      render();
    }
  }

  element('search').addEventListener('input', render);
  element('status').addEventListener('change', render);
  element('refresh').addEventListener('click', () => { void load(); });
  element('previous').addEventListener('click', () => { void load(page - 1); });
  element('next').addEventListener('click', () => { void load(page + 1); });
  window.addEventListener('pagehide', () => client.dispose(), { once: true });
  client.subscribe(state => {
    if (state.status === 'error' || state.status === 'anonymous') {
      element('message').textContent = state.error?.message || 'This app session closed. Open it again from My Apps.';
      element('dashboard').hidden = true;
    }
  });

  const state = await client.initialize();
  const context = client.getContext()!;
  element('app-name').textContent = context.name;
  element('identity').textContent = `${state.user?.name || state.user?.email} · Customer ${context.customerId}`;
  element('dashboard').hidden = false;
  await load(0);
}

void start().catch(cause => {
  element('message').textContent = cause instanceof Error ? cause.message : 'Open this application from the Wallboard My Apps menu.';
});
