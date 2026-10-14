import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedWallboardClient, EMBEDDED_UI_PROTOCOL, EMBEDDED_UI_VERSION, EmbeddedHostError, readEmbeddedBootstrap, type EmbeddedWallboardClient } from '../../src/browser/embedded.js';

const parentOrigin = 'https://wallboard.example.test';
const nonce = 'a'.repeat(64);
const profile = { email: 'person@example.test', name: 'Verified user', role: 'OWNER', customerId: 42, readOnly: false };
const context = { appId: 17, name: 'Fleet overview', customerId: 42, serverUrl: parentOrigin, readOnly: false,
  apiPermissions: [{ method: 'GET', path: '/api/v2/device', description: 'Read devices' }], user: profile };
const envelope = (message: object) => ({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, ...message });
const clients: EmbeddedWallboardClient[] = [];
const hostPorts: MessagePort[] = [];
let connectMessage: { data: Record<string, unknown>; origin: string; ports: Transferable[] } | null;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  connectMessage = null;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('parent', { postMessage(data: Record<string, unknown>, origin: string, ports: Transferable[]) {
    connectMessage = { data, origin, ports }; hostPorts.push(ports[0] as MessagePort);
  } });
  vi.stubGlobal('location', new URL(`https://custom.example.test/index.html?wbEmbedVersion=2&wbParentOrigin=${encodeURIComponent(parentOrigin)}&wbEmbedNonce=${nonce}`));
  const deniedStorage = new Proxy({}, { get() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
  vi.stubGlobal('sessionStorage', deniedStorage); vi.stubGlobal('localStorage', deniedStorage);
  fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Embedded SDK must never fetch'); });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const port of hostPorts.splice(0)) port.close();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function makeClient(options: Parameters<typeof createEmbeddedWallboardClient>[0] = {}) {
  const client = createEmbeddedWallboardClient(options); clients.push(client); return client;
}
async function host(client: EmbeddedWallboardClient, suppliedContext: object = context, respond = true) {
  const initialization = client.initialize();
  expect(connectMessage?.origin).toBe(parentOrigin);
  expect(connectMessage?.data).toEqual(envelope({ type: 'connect', nonce }));
  expect(connectMessage?.ports).toHaveLength(1);
  const port = connectMessage!.ports[0] as MessagePort;
  const requests: Record<string, unknown>[] = [];
  port.onmessage = event => {
    requests.push(event.data);
    if (respond && event.data.type === 'api-request') port.postMessage(envelope({ type: 'api-response', requestId: event.data.requestId, status: 200, body: { content: [] }, contentType: 'application/json' }));
  };
  port.start(); port.postMessage(envelope({ type: 'context', context: suppliedContext }));
  return { port, requests, initialization };
}

describe('tokenless embedded bootstrap and identity', () => {
  it('uses trusted host identity without API fetch, tokens, OAuth or storage', async () => {
    const client = makeClient(); const hosted = await host(client); const state = await hosted.initialization;
    expect(state.status).toBe('authenticated'); expect(state.user).toEqual(profile);
    expect(state.displayIdentity).toBeNull(); expect(state.customerId).toBe(42);
    expect(state).not.toHaveProperty('accessToken'); expect(state).not.toHaveProperty('refreshToken');
    expect(client.getContext()).toEqual(context); expect(Object.isFrozen(client.getContext())).toBe(true);
    expect(Object.isFrozen(client.getContext()?.apiPermissions)).toBe(true);
    expect(hosted.requests).toHaveLength(0); expect(fetcher).not.toHaveBeenCalled();
    await expect(client.signIn()).rejects.toMatchObject({ code: 'HOST_MANAGED_AUTH' });
    await expect(client.getToken()).rejects.toMatchObject({ code: 'API_PROXY_ONLY' });
    await expect(client.getToken(true)).rejects.toMatchObject({ code: 'API_PROXY_ONLY' });
    expect(hosted.requests).toHaveLength(0);
  });
  it.each([
    'wbEmbedVersion=1',
    `wbEmbedVersion=2&wbParentOrigin=${parentOrigin}&wbEmbedNonce=short`,
    `wbEmbedVersion=2&wbParentOrigin=${parentOrigin}&wbEmbedNonce=${nonce}&wbEmbedNonce=${nonce}`,
    `wbEmbedVersion=2&wbParentOrigin=https://user:password@wallboard.example.test&wbEmbedNonce=${nonce}`,
  ])('rejects incompatible/ambiguous bootstrap: %s', parameters => {
    expect(() => readEmbeddedBootstrap(`https://custom.example.test/?${parameters}`)).toThrow(); expect(connectMessage).toBeNull();
  });
  it('rejects top-level use and mismatched host configuration', () => {
    expect(() => makeClient({ parentOrigin: 'https://different.example.test' })).toThrow();
    vi.stubGlobal('parent', globalThis); expect(() => makeClient()).toThrow(EmbeddedHostError);
  });
  it.each([
    { ...context, customerId: '-1' }, { ...context, user: { email: 'no-role' } },
    { ...context, apiPermissions: [{ method: 'GET', path: '/api/{anything}' }] },
    { ...context, apiPermissions: [{ method: 'GET', path: '/api/v2/device?select=secret' }] },
    { ...context, apiPermissions: [{ method: 'GET', path: '/api/v2/device' }, { method: 'GET', path: '/api/v2/device' }] },
  ])('rejects malformed context without fetching', async suppliedContext => {
    const client = makeClient(); const hosted = await host(client, suppliedContext);
    await expect(hosted.initialization).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires version2 context and ignores unsolicited tokens without retaining them', async () => {
    const client = makeClient(); const initialization = client.initialize(); const port = connectMessage!.ports[0] as MessagePort;
    port.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: 1, type: 'ready', context });
    port.postMessage(envelope({ type: 'access-token', accessToken: 'malicious.jwt.token', expiresAt: Date.now() + 10000 }));
    port.postMessage(envelope({ type: 'context', context }));
    expect((await initialization).status).toBe('authenticated'); expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(client.getContext())).not.toContain('malicious.jwt.token');
    await expect(client.getToken()).rejects.toMatchObject({ code: 'API_PROXY_ONLY' });
  });
  it('combines host mode and account read-only flags, preserving original identity', async () => {
    const client = makeClient(); const hosted = await host(client, { ...context, customerId: 43, user: { ...profile, readOnly: true } });
    const state = await hosted.initialization; expect(state.readOnly).toBe(true); expect(state.customerId).toBe(43); expect(state.user?.customerId).toBe(42);
    await expect(client.api.put('/api/v2/device/device-a', { body: {} })).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(hosted.requests).toHaveLength(0);
  });
});

describe('embedded proxy transport and cancellation', () => {
  it('keeps API response semantics and sends method/path/params only over the port', async () => {
    const client = makeClient(); const hosted = await host(client); await hosted.initialization;
    await expect(client.api.get('/api/v2/device', { query: { page: 0, select: ['id', 'name'] } })).resolves.toEqual({ content: [] });
    await client.api.get('/api/customUi/available', { instance: true });
    expect(hosted.requests[0]).toEqual(envelope({ type: 'api-request', requestId: expect.any(String), method: 'GET', path: '/api/v2/device', params: { page: '0', select: ['id', 'name'], customerId: '42' } }));
    expect(hosted.requests[1]).not.toHaveProperty('params'); expect(fetcher).not.toHaveBeenCalled();
    await client.api.forCustomer(43).get('/api/v2/device'); expect(hosted.requests[2].params).toEqual({ customerId: '43' });
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('preserves %s body and reconstructed raw Response', async method => {
    const client = makeClient(); const hosted = await host(client); await hosted.initialization;
    const response = await client.api.raw('/api/content/item-1', method, { body: { name: 'test' } });
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ content: [] }); expect(hosted.requests[0].body).toEqual({ name: 'test' });
  });
  it('isolates parallel responses and request-specific errors without closing the client', async () => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    const first = client.api.get('/api/content/item-a'); const second = client.api.get('/api/content/item-b'); const third = client.api.get('/api/content/item-c');
    const failed = expect(third).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(3));
    const ids = hosted.requests.map(request => request.requestId);
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: ids[1], status: 200, body: { id: 'item-b' } }));
    hosted.port.postMessage(envelope({ type: 'error', requestId: ids[2], code: 'PERMISSION_DENIED', message: 'Endpoint not approved', status: 403 }));
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: ids[0], status: 200, body: { id: 'item-a' } }));
    expect(await first).toEqual({ id: 'item-a' }); expect(await second).toEqual({ id: 'item-b' }); await failed;
    expect(client.getState().status).toBe('authenticated');
  });
  it('preserves backend API status/body errors without retrying uncertain writes', async () => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    const request = client.api.post('/api/content', { body: {} }); const rejected = expect(request).rejects.toMatchObject({ status: 403, body: { message: 'Not allowed' } });
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: hosted.requests[0].requestId, status: 403, body: { message: 'Not allowed' } }));
    await rejected; expect(hosted.requests).toHaveLength(1);
  });
  it.each([
    { status: 200, body: '123', contentType: 'application/json', text: '"123"' },
    { status: 200, body: null, contentType: 'application/problem+json', text: 'null' },
    { status: 200, body: 'hello', contentType: 'text/plain', text: 'hello' },
    { status: 204, body: null, contentType: 'application/json', text: '' },
  ])('preserves raw response $status $contentType body $body', async response => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    const request = client.api.raw('/api/v2/device');
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(1));
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: hosted.requests[0].requestId, ...response }));
    expect(await (await request).text()).toBe(response.text);
  });
  it.each(['/api/../login', '/api/v2/%64evice', '/api/v2/device?x=1', '/api/v2/device/', '/api/v2/device;foo', 'https://evil.test/api/v2/device'])('rejects invalid API path %s', async path => {
    const client = makeClient(); const hosted = await host(client); await hosted.initialization;
    await expect(client.api.get(path)).rejects.toThrow(); expect(hosted.requests).toHaveLength(0);
  });
  it('rejects request header injection, reserved query params, GET body and unsupported method', async () => {
    const client = makeClient(); const hosted = await host(client); await hosted.initialization;
    await expect(client.api.get('/api/v2/device', { headers: { Authorization: 'Bearer malicious' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.api.get('/api/v2/device', { query: { JWTAccessToken: 'malicious' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.api.get('/api/v2/device', { body: {} })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.api.raw('/api/v2/device', 'HEAD')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(hosted.requests).toHaveLength(0);
  });
  it('allows exact read-only POST exceptions and rejects writes and mutating GETs', async () => {
    const client = makeClient(); const hosted = await host(client, { ...context, readOnly: true }); await hosted.initialization;
    await client.api.post('/api/deviceStat/device-a/graphs', { body: {} }); await client.api.post('/api/v2/device/requestLog', { body: {} });
    await expect(client.api.post('/api/deviceStat/device-a/graphs/change', { body: {} })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(client.api.get('/api/user/microsoft/disconnect')).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(client.api.delete('/api/content/item-1')).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(hosted.requests).toHaveLength(2);
  });
  it('cancels one aborted request without affecting a parallel operation or accepting late replies', async () => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization; const controller = new AbortController();
    const request = client.api.get('/api/content/item-a', { signal: controller.signal }); const aborted = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const other = client.api.get('/api/content/item-b'); await vi.waitFor(() => expect(hosted.requests).toHaveLength(2));
    controller.abort(); await aborted; await vi.waitFor(() => expect(hosted.requests).toHaveLength(3));
    expect(hosted.requests[2]).toEqual(envelope({ type: 'api-cancel', requestId: hosted.requests[0].requestId }));
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: hosted.requests[0].requestId, status: 200, body: { stale: true } }));
    hosted.port.postMessage(envelope({ type: 'api-response', requestId: hosted.requests[1].requestId, status: 200, body: { id: 'item-b' } }));
    expect(await other).toEqual({ id: 'item-b' }); expect(client.getState().status).toBe('authenticated');
  });
  it('times out and cancels an unanswered request without automatic replay or closing the session', async () => {
    const client = makeClient({ requestTimeoutMs: 20 }); const hosted = await host(client, context, false); await hosted.initialization;
    await expect(client.api.post('/api/content', { body: {} })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(2)); expect(hosted.requests[1].type).toBe('api-cancel'); expect(client.getState().status).toBe('authenticated');
  });
  it('rejects connection timeout and all pending requests on close', async () => {
    await expect(makeClient({ connectionTimeoutMs: 10 }).initialize()).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    const requests = [client.api.get('/api/content/item-a'), client.api.get('/api/content/item-b')];
    const rejected = requests.map(request => expect(request).rejects.toThrow('closed'));
    await vi.waitFor(() => expect(hosted.requests).toHaveLength(2)); client.dispose(); await Promise.all(rejected);
    expect(client.getState().status).toBe('anonymous'); expect(client.getContext()).toBeNull();
    await expect(client.initialize()).rejects.toThrow('closed'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['UNAVAILABLE', 'CONTEXT_CHANGED', 'AUTH_REQUIRED'])('clears session on fatal host %s', async code => {
    const client = makeClient(); const hosted = await host(client); await hosted.initialization;
    hosted.port.postMessage(envelope({ type: 'error', code, message: 'Open this app again.' }));
    await vi.waitFor(() => expect(client.getContext()).toBeNull()); expect(client.getState().user).toBeNull();
  });
  it('does not log the CMS out when this app signs out', async () => {
    const client = makeClient(); await (await host(client)).initialization; client.signOut();
    expect(client.getState().status).toBe('anonymous'); expect(fetcher).not.toHaveBeenCalled();
  });
});
