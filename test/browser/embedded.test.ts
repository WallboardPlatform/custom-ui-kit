import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbeddedWallboardClient, EMBEDDED_UI_PROTOCOL, EmbeddedHostError, readEmbeddedBootstrap, type EmbeddedWallboardClient } from '../../src/browser/embedded.js';

const parentOrigin = 'https://wallboard.example.test';
const nonce = 'a'.repeat(64);
const context = { appId: 17, name: 'Fleet overview', customerId: 42, serverUrl: parentOrigin };
const profile = { email: 'person@example.test', name: 'Verified user', role: 'ADMIN', customerId: 34, readOnly: false };
const jwt = (readOnly = false, label = 'original') => `header.${btoa(JSON.stringify({ sub: 'person@example.test', scope: 'VIEWER', customerId: 99, readOnly, label })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.signature`;
const envelope = (message: object) => ({ protocol: EMBEDDED_UI_PROTOCOL, version: 1, ...message });
const clients: EmbeddedWallboardClient[] = [];
const hostPorts: MessagePort[] = [];
let connectMessage: { data: Record<string, unknown>; origin: string; ports: Transferable[] } | null;

beforeEach(() => {
  connectMessage = null;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('parent', { postMessage(data: Record<string, unknown>, origin: string, ports: Transferable[]) {
    connectMessage = { data, origin, ports };
    hostPorts.push(ports[0] as MessagePort);
  } });
  vi.stubGlobal('location', new URL(`https://custom.example.test/index.html?wbEmbedVersion=1&wbParentOrigin=${encodeURIComponent(parentOrigin)}&wbEmbedNonce=${nonce}`));
  const deniedStorage = new Proxy({}, { get() { throw new DOMException('Storage is blocked in an opaque frame', 'SecurityError'); } });
  vi.stubGlobal('sessionStorage', deniedStorage);
  vi.stubGlobal('localStorage', deniedStorage);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const port of hostPorts.splice(0)) port.close();
  vi.unstubAllGlobals();
});

function makeClient(options: Parameters<typeof createEmbeddedWallboardClient>[0] = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } }));
  const client = createEmbeddedWallboardClient({ fetch: fetcher, ...options });
  clients.push(client);
  return { client, fetcher };
}

async function host(client: EmbeddedWallboardClient, autoToken = true) {
  const initialization = client.initialize();
  expect(connectMessage?.origin).toBe(parentOrigin);
  expect(connectMessage?.data).toEqual(envelope({ type: 'connect', nonce }));
  expect(connectMessage?.ports).toHaveLength(1);
  const port = connectMessage!.ports[0] as MessagePort;
  const requests: Record<string, unknown>[] = [];
  port.onmessage = event => {
    requests.push(event.data);
    if (autoToken) port.postMessage(envelope({ type: 'access-token', requestId: event.data.requestId, accessToken: jwt(), expiresAt: Date.now() + 1_800_000 }));
  };
  port.start();
  port.postMessage(envelope({ type: 'ready', context }));
  return { port, requests, initialization };
}

describe('embedded bootstrap and identity', () => {
  it('transfers one child-created port to the exact parent and authenticates without storage or OAuth', async () => {
    const { client, fetcher } = makeClient();
    const hosted = await host(client);
    const state = await hosted.initialization;
    expect(state.status).toBe('authenticated');
    expect(state.user?.role).toBe('ADMIN');
    expect(state.displayIdentity?.role).toBe('VIEWER');
    expect(state.customerId).toBe(42);
    expect(state).not.toHaveProperty('accessToken');
    expect(state).not.toHaveProperty('refreshToken');
    expect(client.getContext()).toEqual(context);
    expect(Object.isFrozen(client.getContext())).toBe(true);
    expect(hosted.requests).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${parentOrigin}/api/v2/user/me`);
    const request = fetcher.mock.calls[0][1]!;
    expect(request.credentials).toBe('omit');
    expect(request.redirect).toBe('error');
    expect(new Headers(request.headers).get('Authorization')).toBe(`Bearer ${jwt()}`);
    await expect(client.signIn()).rejects.toMatchObject({ code: 'HOST_MANAGED_AUTH' });
  });

  it.each([
    'wbEmbedVersion=2',
    `wbEmbedVersion=1&wbParentOrigin=${parentOrigin}&wbEmbedNonce=short`,
    `wbEmbedVersion=1&wbParentOrigin=${parentOrigin}&wbEmbedNonce=${nonce}&wbEmbedNonce=${nonce}`,
    `wbEmbedVersion=1&wbParentOrigin=https://user:password@wallboard.example.test&wbEmbedNonce=${nonce}`,
  ])('rejects incompatible or ambiguous bootstrap before communicating: %s', parameters => {
    expect(() => readEmbeddedBootstrap(`https://custom.example.test/?${parameters}`)).toThrow();
    expect(connectMessage).toBeNull();
  });

  it('rejects top-level use and mismatched explicit host configuration', () => {
    expect(() => makeClient({ parentOrigin: 'https://different.example.test' })).toThrow();
    vi.stubGlobal('parent', globalThis);
    expect(() => makeClient()).toThrow(EmbeddedHostError);
  });

  it('rejects a malformed ready context before handing a token to fetch', async () => {
    const { client, fetcher } = makeClient();
    const initialization = client.initialize();
    const rejected = expect(initialization).rejects.toThrow('invalid app context');
    (connectMessage!.ports[0] as MessagePort).postMessage(envelope({ type: 'ready', context: { ...context, customerId: '-1' } }));
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('defaults API queries to the host customer while preserving explicit authorized instance calls', async () => {
    const { client, fetcher } = makeClient();
    await (await host(client)).initialization;
    await client.api.get('/api/v2/device', { query: { page: 0 } });
    await client.api.get('/api/customUi/available', { instance: true });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('customerId')).toBe('42');
    expect(new URL(String(fetcher.mock.calls[2][0])).searchParams.has('customerId')).toBe(false);
  });

  it('combines the verified account and restrictive current-token read-only flags', async () => {
    const { client } = makeClient();
    const hosted = await host(client, false);
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[0].requestId, accessToken: jwt(true), expiresAt: Date.now() + 1_800_000 }));
    expect((await hosted.initialization).readOnly).toBe(true);
  });
});

describe('embedded token renewal and cancellation', () => {
  it('uses host tokens against a real noncredentialed HTTP fixture, including renewal after a 401', async () => {
    const requests: { path: string; origin?: string; authorization?: string }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url!, origin: request.headers.origin, authorization: request.headers.authorization });
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/api/v2/device') && requests.filter(item => item.path.startsWith('/api/v2/device')).length === 1) {
        response.writeHead(401); response.end('{}'); return;
      }
      response.end(JSON.stringify(request.url === '/api/v2/user/me' ? profile : { content: [{ id: 'screen-a', name: 'Synthetic lobby' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal('location', new URL(`https://custom.example.test/?wbEmbedVersion=1&wbParentOrigin=${encodeURIComponent(serverUrl)}&wbEmbedNonce=${nonce}`));
    try {
      const { client } = makeClient({ fetch: (input, options) => {
        expect(options?.credentials).toBe('omit');
        const headers = new Headers(options?.headers);
        headers.set('Origin', 'null');
        return fetch(input, { ...options, headers });
      } });
      const initialization = client.initialize();
      expect(connectMessage?.origin).toBe(serverUrl);
      const port = connectMessage!.ports[0] as MessagePort;
      let count = 0;
      port.onmessage = event => port.postMessage(envelope({ type: 'access-token', requestId: event.data.requestId, accessToken: jwt(false, `grant-${++count}`), expiresAt: Date.now() + 1_800_000 }));
      port.start();
      port.postMessage(envelope({ type: 'ready', context: { ...context, serverUrl } }));
      await initialization;
      await expect(client.api.get('/api/v2/device')).resolves.toEqual({ content: [{ id: 'screen-a', name: 'Synthetic lobby' }] });
      expect(requests.every(item => item.origin === 'null')).toBe(true);
      expect(requests[1].path).toBe('/api/v2/device?customerId=42');
      expect(requests[1].authorization).not.toBe(requests[2].authorization);
      expect(count).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('caches a live token and coalesces concurrent renewal into one host request', async () => {
    const { client } = makeClient();
    const hosted = await host(client);
    await hosted.initialization;
    await client.getToken();
    expect(hosted.requests).toHaveLength(1);
    hosted.port.onmessage = event => hosted.requests.push(event.data);
    const requests = [client.getToken(true), client.getToken(true), client.getToken(true)];
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(2));
    const renewed = jwt(false, 'renewed');
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[1].requestId, accessToken: renewed, expiresAt: Date.now() + 1_800_000 }));
    expect(await Promise.all(requests)).toEqual([renewed, renewed, renewed]);
    expect(hosted.requests[1]).toEqual(envelope({ type: 'get-access-token', requestId: expect.any(String) }));
  });

  it('renews a token close to expiry without a refresh credential', async () => {
    const { client } = makeClient();
    const hosted = await host(client, false);
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[0].requestId, accessToken: jwt(), expiresAt: Date.now() + 30_000 }));
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(2));
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[1].requestId, accessToken: jwt(false, 'longer'), expiresAt: Date.now() + 1_800_000 }));
    await hosted.initialization;
    expect(hosted.requests.every(request => request.type === 'get-access-token')).toBe(true);
  });

  it('ignores wrong protocol and unsolicited token replies until the matching response arrives', async () => {
    const { client } = makeClient();
    const hosted = await host(client, false);
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage({ protocol: 'unrelated', version: 1, type: 'error', code: 'AUTH_REQUIRED', message: 'Ignore' });
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: 'unrelated', accessToken: jwt(), expiresAt: Date.now() + 1_800_000 }));
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[0].requestId, accessToken: jwt(), expiresAt: Date.now() + 1_800_000 }));
    expect((await hosted.initialization).status).toBe('authenticated');
  });

  it('requests a new host token once after an API authentication failure', async () => {
    const { client, fetcher } = makeClient();
    const hosted = await host(client);
    await hosted.initialization;
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{"content":[]}'));
    await expect(client.api.get('/api/v2/device')).resolves.toEqual({ content: [] });
    expect(hosted.requests).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['UNAVAILABLE', 'CONTEXT_CHANGED', 'AUTH_REQUIRED'])('clears the session when the host reports %s', async code => {
    const { client } = makeClient();
    const hosted = await host(client);
    await hosted.initialization;
    hosted.port.postMessage(envelope({ type: 'error', code, message: 'Open this app again.' }));
    await vi.waitFor(() => expect(client.getContext()).toBeNull());
    await expect(client.getToken()).rejects.toThrow('closed');
    expect(client.getState().user).toBeNull();
    expect(client.getState().displayIdentity).toBeNull();
  });

  it('rejects connection and token timeouts instead of leaving initialization pending', async () => {
    const first = makeClient({ connectionTimeoutMs: 10 }).client;
    await expect(first.initialize()).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    const second = makeClient({ requestTimeoutMs: 10 }).client;
    const hosted = await host(second, false);
    await expect(hosted.initialization).rejects.toMatchObject({ code: 'TOKEN_TIMEOUT' });
  });

  it('rejects expired host tokens without calling the API', async () => {
    const { client, fetcher } = makeClient();
    const hosted = await host(client, false);
    const rejected = expect(hosted.initialization).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[0].requestId, accessToken: jwt(), expiresAt: Date.now() - 1 }));
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not resurrect a disposed session when a late token response arrives', async () => {
    const { client, fetcher } = makeClient();
    const hosted = await host(client, false);
    const rejected = expect(hosted.initialization).rejects.toThrow('closed');
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    client.dispose();
    hosted.port.postMessage(envelope({ type: 'access-token', requestId: hosted.requests[0].requestId, accessToken: jwt(), expiresAt: Date.now() + 1_800_000 }));
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.getState().status).toBe('anonymous');
  });

  it('does not log the CMS user out when this app signs out', async () => {
    const { client, fetcher } = makeClient();
    await (await host(client)).initialization;
    client.signOut();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.getState().status).toBe('anonymous');
    await expect(client.initialize()).rejects.toThrow('closed');
  });
});
