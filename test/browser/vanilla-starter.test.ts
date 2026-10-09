import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformWithEsbuild } from 'vite';
import { expect, it, vi } from 'vitest';
import { createWallboardApi } from '../../src/api/client.js';
import { WB } from '../../src/api/entities.js';
import { readCompleteList } from '../../src/api/pagination.js';

class Element extends EventTarget {
  value = '';
  hidden = true;
  textContent = '';
  children: Element[] = [];
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
}

async function start(role: 'ADMIN' | 'OWNER', customerId: number | null) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const content = url.pathname === WB.customer
      ? [{ id: 10, name: 'Synthetic first customer' }, { id: 20, name: 'Synthetic second customer' }]
      : [];
    return new Response(JSON.stringify({ content, number: 0, totalPages: 1, totalElements: content.length, last: true }));
  });
  const api = createWallboardApi({ serverUrl: 'https://wallboard.example.test', getToken: async () => 'synthetic-access', fetch: fetcher });
  const starter = new URL('../../examples/vanilla-device-board/main.ts', import.meta.url);
  const { code } = await transformWithEsbuild(await readFile(starter, 'utf8'), starter.pathname, {
    format: 'cjs', target: 'es2022', define: { 'import.meta.env': '{}' },
  });
  runInNewContext(code, {
    require(id: string) {
      if (id === '@wallboard/custom-ui-kit/theme.css') return {};
      if (id !== '@wallboard/custom-ui-kit') throw new Error(`Unexpected starter import: ${id}`);
      return {
        WB, readCompleteList,
        createWallboardClient: () => ({ api, subscribe() {}, initialize: async () => ({ status: 'authenticated', user: { role, customerId } }) }),
      };
    },
    document: { getElementById: element, createElement: () => new Element() },
    location: new URL('https://application.example.test/?server=https://wallboard.example.test'),
    sessionStorage: { getItem: () => null, setItem() {} },
    URL, URLSearchParams,
  }, { filename: starter.pathname, timeout: 1000 });
  return {
    element,
    requests: () => fetcher.mock.calls.map(([input]) => new URL(String(input))),
    deviceRequests: () => fetcher.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === WB.device),
  };
}

it.each([null, 10])('waits for an ADMIN customer choice when /me customerId is %s', async (customerId) => {
  const app = await start('ADMIN', customerId);
  await vi.waitFor(() => expect(app.element('scope').hidden).toBe(false));
  expect(app.element('customer').value).toBe('');
  expect(app.requests().map((url) => url.pathname)).toEqual([WB.customer]);
  expect(app.deviceRequests()).toEqual([]);

  app.element('customer').value = '20';
  app.element('customer').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(app.deviceRequests()).toHaveLength(1));
  expect(app.deviceRequests()[0].searchParams.get('customerId')).toBe('20');
});

it('loads a regular user own customer without an administrator selector', async () => {
  const app = await start('OWNER', 10);
  await vi.waitFor(() => expect(app.deviceRequests()).toHaveLength(1));
  expect(app.requests().map((url) => url.pathname)).toEqual([WB.device]);
  expect(app.deviceRequests()[0].searchParams.get('customerId')).toBe('10');
  expect(app.element('scope').hidden).toBe(true);
});
