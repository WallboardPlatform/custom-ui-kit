import { createApp } from 'vue';
import { createWallboardClient } from '@wallboard/custom-ui-kit';
import { createWallboardPlugin } from '@wallboard/custom-ui-kit/vue';
import '@wallboard/custom-ui-kit/theme.css';
import App from './App.vue';

const serverUrl = import.meta.env.VITE_WB_SERVER_URL || new URLSearchParams(location.search).get('server') || sessionStorage.getItem('wb:example:server');
if (!serverUrl && !new URLSearchParams(location.search).has('demo')) {
  const form = document.createElement('form'); form.className = 'wb-card wb-signin';
  const heading = document.createElement('h1'); heading.textContent = 'Connect your Wallboard';
  const label = document.createElement('label'); label.textContent = 'Wallboard server URL'; label.htmlFor = 'server-url';
  const input = document.createElement('input'); input.id = 'server-url'; input.name = 'server'; input.type = 'url'; input.required = true; input.className = 'wb-input'; input.placeholder = 'https://your-wallboard.example'; input.style.cssText = 'display:block;width:100%;margin:12px 0 20px';
  const button = document.createElement('button'); button.className = 'wb-button'; button.textContent = 'Continue';
  const demo = document.createElement('a'); demo.href = '?demo=1'; demo.textContent = 'Explore with sample data'; demo.style.cssText = 'display:block;margin-top:24px';
  form.append(heading, label, input, button, demo); document.querySelector('#app')!.append(form);
} else {
  if (serverUrl) sessionStorage.setItem('wb:example:server', serverUrl);
  const client = createWallboardClient({ serverUrl: serverUrl || 'https://example.invalid', clientId: import.meta.env.VITE_WB_CLIENT_ID || undefined });
  createApp(App).use(createWallboardPlugin(client)).mount('#app');
}
