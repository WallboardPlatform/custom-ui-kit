import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as nativeDelay } from 'node:timers/promises';
import { createEmbeddedWallboardClient, EMBEDDED_UI_PROTOCOL, EMBEDDED_UI_VERSION, EmbeddedHostError, readEmbeddedBootstrap, type EmbeddedAppManifest, type EmbeddedWallboardClient } from '../../src/browser/embedded.js';

const parentOrigin = 'https://wallboard.example.test';
const nonce = 'a'.repeat(64);
const profile = { email: 'person@example.test', name: 'Verified user', role: 'OWNER', customerId: 42, readOnly: false };
const manifest: EmbeddedAppManifest = { readOnly: false, operations: [{ method: 'GET', path: '/api/v2/device', description: 'Read devices' }] };
const context = { appId: 17, name: 'Fleet overview', customerId: 42, serverUrl: parentOrigin, readOnly: false, manifest, user: profile };
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
function makeClient(options: Partial<Parameters<typeof createEmbeddedWallboardClient>[0]> = {}) {
  const client = createEmbeddedWallboardClient({ manifest, ...options }); clients.push(client); return client;
}
async function host(client: EmbeddedWallboardClient, suppliedContext: object = context, respond = true) {
  const initialization = client.initialize();
  expect(connectMessage?.origin).toBe(parentOrigin);
  expect(connectMessage?.data).toEqual(envelope({ type: 'connect', nonce, manifest: expect.any(Object) }));
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
  it('declares a frozen snapshot and waits for approval without identity or API access', async () => {
    const supplied: { readOnly: boolean; operations: { method: 'GET'; path: string; description: string }[] } = {
      readOnly: false, operations: [{ method: 'GET', path: '/api/v2/device', description: 'Read devices' }],
    };
    const client = makeClient({ manifest: supplied });
    supplied.readOnly = true; supplied.operations[0]!.path = '/api/user';
    let approved = false;
    const initialization = client.initialize().then(state => { approved = true; return state; });
    expect(connectMessage?.data).toEqual(envelope({ type: 'connect', nonce, manifest }));
    expect(client.getState().status).toBe('checking'); expect(client.getState().user).toBeNull();
    expect(client.getContext()).toBeNull(); expect(() => client.api).toThrow('Initialize');
    await new Promise(resolve => setTimeout(resolve, 25)); expect(approved).toBe(false);
    const port = connectMessage!.ports[0] as MessagePort;
    port.postMessage(envelope({ type: 'context', context }));
    expect((await initialization).status).toBe('authenticated');
    expect(client.getContext()?.manifest).toEqual(manifest); expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows five minutes for approval separately from API request timeouts', async () => {
    vi.useFakeTimers(); const client = makeClient({ requestTimeoutMs: 10 });
    const initialization = client.initialize(); const rejected = expect(initialization).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(299_999); expect(client.getState().status).toBe('checking');
    expect(client.getContext()).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
  });
  it.each([
    undefined, [], { readOnly: false, operations: [], unknown: true }, { readOnly: 'false', operations: [] },
    { readOnly: false, operations: [{ method: 'get', path: '/api/device' }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/{resource}' }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/device/{id}/' }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/device', headers: {} }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/device', description: null }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/device', description: 'x'.repeat(501) }] },
    { readOnly: false, operations: [{ method: 'GET', path: '/api/device' }, { method: 'GET', path: '/api/device' }] },
    { readOnly: false, operations: Array.from({ length: 129 }, (_, index) => ({ method: 'GET', path: `/api/device/id-${index}` })) },
  ])('rejects an invalid manifest before connecting: %j', invalid => {
    expect(() => makeClient({ manifest: invalid as EmbeddedAppManifest })).toThrow(); expect(connectMessage).toBeNull();
  });
  it('accepts an empty object-wrapped operations list for apps without Wallboard API access', async () => {
    const empty = { readOnly: true, operations: [] }; const client = makeClient({ manifest: empty });
    const hosted = await host(client, { ...context, manifest: empty, readOnly: true });
    expect((await hosted.initialization).readOnly).toBe(true); expect(client.getContext()?.manifest).toEqual(empty);
  });
  it.each([
    { ...manifest, readOnly: true },
    { ...manifest, operations: [{ method: 'GET', path: '/api/content' }] },
    { ...manifest, operations: [{ method: 'GET', path: '/api/v2/device', description: 'A different description' }] },
  ])('rejects host approval for a different manifest: %j', approvedManifest => {
    const client = makeClient(); return host(client, { ...context, manifest: approvedManifest })
      .then(hosted => expect(hosted.initialization).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' }));
  });
  it('refuses host write mode for a declared read-only app', async () => {
    const readOnlyManifest = { ...manifest, readOnly: true }; const client = makeClient({ manifest: readOnlyManifest });
    const hosted = await host(client, { ...context, manifest: readOnlyManifest, readOnly: false });
    await expect(hosted.initialization).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
  });
  it('clears a refused or closed pending approval without exposing profile or fetching', async () => {
    const client = makeClient(); const initialization = client.initialize();
    const port = connectMessage!.ports[0] as MessagePort;
    port.postMessage(envelope({ type: 'error', code: 'CONSENT_DENIED', message: 'The user declined this app.' }));
    await expect(initialization).rejects.toMatchObject({ code: 'CONSENT_DENIED' });
    expect(client.getContext()).toBeNull(); expect(client.getState().user).toBeNull();
    const waiting = makeClient(); const pendingApproval = waiting.initialize(); const rejected = expect(pendingApproval).rejects.toThrow('closed');
    waiting.dispose(); await rejected; expect(waiting.getContext()).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses trusted host identity without API fetch, tokens, OAuth or storage', async () => {
    const client = makeClient(); const hosted = await host(client); const state = await hosted.initialization;
    expect(state.status).toBe('authenticated'); expect(state.user).toEqual(profile);
    expect(state.displayIdentity).toBeNull(); expect(state.customerId).toBe(42);
    expect(state).not.toHaveProperty('accessToken'); expect(state).not.toHaveProperty('refreshToken');
    expect(client.getContext()).toEqual(context); expect(Object.isFrozen(client.getContext())).toBe(true);
    expect(Object.isFrozen(client.getContext()?.manifest)).toBe(true);
    expect(Object.isFrozen(client.getContext()?.manifest.operations)).toBe(true);
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
    { ...context, manifest: { readOnly: false, operations: [{ method: 'GET', path: '/api/{anything}' }] } },
    { ...context, manifest: { readOnly: false, operations: [{ method: 'GET', path: '/api/v2/device?select=secret' }] } },
    { ...context, manifest: { readOnly: false, operations: [{ method: 'GET', path: '/api/v2/device' }, { method: 'GET', path: '/api/v2/device' }] } },
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
  it.each(['GET', 'PUT'] as const)('keeps an ordinary %s request alive past the parent deadline and cancels at 35 seconds', async method => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    vi.useFakeTimers(); let settled = false;
    const request = client.api.raw('/api/content/item-1', method, method === 'PUT' ? { body: { name: 'Synthetic change' } } : {}).finally(() => { settled = true; });
    const rejected = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(settled).toBe(true); expect(client.getState().status).toBe('authenticated');
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

describe('request-scoped destructive confirmation', () => {
  async function begin(method: 'DELETE' | 'GET' | 'POST' = 'DELETE', requestTimeoutMs?: number) {
    const client = makeClient({ requestTimeoutMs }); const hosted = await host(client, context, false); await hosted.initialization;
    vi.useFakeTimers(); let settled = false;
    const request = client.api.raw('/api/content/item-1', method).finally(() => { settled = true; });
    // Attach a handler before advancing fake time; real MessageChannel delivery still uses the native event loop.
    void request.catch(() => undefined);
    await nativeDelay(5); expect(hosted.requests).toHaveLength(1);
    return { client, hosted, request, requestId: hosted.requests[0].requestId as string, settled: () => settled };
  }
  async function progress(port: MessagePort, requestId: string, type: 'api-awaiting-confirmation' | 'api-executing', extra: object = {}) {
    port.postMessage(envelope({ type, requestId, ...extra })); await nativeDelay(5);
  }
  it('waits beyond the API timeout, but cancels an unanswered human confirmation after 305 seconds', async () => {
    const active = await begin(); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(35_000); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(269_999); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(active.request).rejects.toMatchObject({ code: 'CONFIRMATION_TIMEOUT', status: 403 });
    await nativeDelay(5);
    expect(active.hosted.requests[1]).toEqual(envelope({ type: 'api-cancel', requestId: active.requestId }));
    expect(active.client.getState().status).toBe('authenticated');
  });
  it.each([undefined, 1_000])('restarts the original API timeout after confirmation (override %s)', async override => {
    const active = await begin('DELETE', override); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(40_000); expect(active.settled()).toBe(false);
    await progress(active.hosted.port, active.requestId, 'api-executing');
    await vi.advanceTimersByTimeAsync((override ?? 35_000) - 1); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(active.request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(active.client.getState().status).toBe('authenticated');
  });
  it('does not extend a human deadline on duplicate awaiting-confirmation messages', async () => {
    const active = await begin(); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(300_000); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(4_999); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(active.request).rejects.toMatchObject({ code: 'CONFIRMATION_TIMEOUT' });
  });
  it('does not extend an ordinary deadline on an out-of-order executing message', async () => {
    const active = await begin('GET'); await vi.advanceTimersByTimeAsync(30_000);
    await progress(active.hosted.port, active.requestId, 'api-executing');
    await vi.advanceTimersByTimeAsync(4_999); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(active.request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });
  it('allows only one confirmation phase and never extends executing on duplicate statuses', async () => {
    const active = await begin(); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(40_000); await progress(active.hosted.port, active.requestId, 'api-executing');
    await vi.advanceTimersByTimeAsync(34_000);
    await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await progress(active.hosted.port, active.requestId, 'api-executing');
    await vi.advanceTimersByTimeAsync(999); expect(active.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(active.request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });
  it.each(['GET', 'POST'] as const)('supports host confirmation for a legacy destructive %s without duplicating the endpoint registry', async method => {
    const active = await begin(method); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await vi.advanceTimersByTimeAsync(40_000); expect(active.settled()).toBe(false);
    await progress(active.hosted.port, active.requestId, 'api-executing');
    active.hosted.port.postMessage(envelope({ type: 'api-response', requestId: active.requestId, status: 204 }));
    expect((await active.request).status).toBe(204); expect(active.client.getState().status).toBe('authenticated');
  });
  it('rejects a declined deletion without affecting a parallel ordinary request or session', async () => {
    const active = await begin(); const other = active.client.api.get('/api/v2/device'); await nativeDelay(5);
    const otherId = active.hosted.requests[1].requestId;
    await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    active.hosted.port.postMessage(envelope({ type: 'error', requestId: active.requestId, code: 'CONFIRMATION_DENIED', message: 'The user declined this deletion.', status: 403 }));
    active.hosted.port.postMessage(envelope({ type: 'api-response', requestId: otherId, status: 200, body: { content: [] } }));
    await expect(active.request).rejects.toMatchObject({ code: 'CONFIRMATION_DENIED', status: 403 });
    expect(await other).toEqual({ content: [] }); expect(active.client.getState().status).toBe('authenticated');
  });
  it.each(['abort', 'dispose'] as const)('cancels a pending confirmation on %s and ignores late execution/replies', async action => {
    const client = makeClient(); const hosted = await host(client, context, false); await hosted.initialization;
    vi.useFakeTimers(); const controller = new AbortController();
    const request = client.api.delete('/api/content/item-1', { signal: controller.signal }); void request.catch(() => undefined);
    await nativeDelay(5); const requestId = hosted.requests[0].requestId as string;
    await progress(hosted.port, requestId, 'api-awaiting-confirmation'); await vi.advanceTimersByTimeAsync(40_000);
    if (action === 'abort') controller.abort(); else client.dispose();
    if (action === 'abort') await expect(request).rejects.toMatchObject({ name: 'AbortError' }); else await expect(request).rejects.toThrow('closed');
    await nativeDelay(5);
    expect(hosted.requests[1]).toEqual(envelope({ type: 'api-cancel', requestId }));
    await progress(hosted.port, requestId, 'api-executing');
    hosted.port.postMessage(envelope({ type: 'api-response', requestId, status: 200, body: { late: true } })); await nativeDelay(5);
    expect(client.getState().status).toBe(action === 'abort' ? 'authenticated' : 'anonymous'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['api-awaiting-confirmation', 'api-executing'] as const)('fails closed on malformed %s for a pending request', async type => {
    const active = await begin(); await progress(active.hosted.port, active.requestId, type, { body: { credential: 'must-not-be-sent' } });
    await expect(active.request).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(active.client.getState().status).toBe('error'); expect(active.client.getContext()).toBeNull();
  });
  it('ignores unknown and completed request progress without affecting a live operation', async () => {
    const active = await begin('GET');
    await progress(active.hosted.port, 'unknown-request', 'api-awaiting-confirmation', { extra: 'ignored unknown ID' });
    await progress(active.hosted.port, 'unknown-request', 'api-executing');
    active.hosted.port.postMessage(envelope({ type: 'api-response', requestId: active.requestId, status: 200, body: { okay: true } }));
    expect(await (await active.request).json()).toEqual({ okay: true });
    await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    await progress(active.hosted.port, active.requestId, 'api-executing');
    expect(active.client.getState().status).toBe('authenticated'); expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed if an API result arrives before confirmation is marked executing', async () => {
    const active = await begin(); await progress(active.hosted.port, active.requestId, 'api-awaiting-confirmation');
    active.hosted.port.postMessage(envelope({ type: 'api-response', requestId: active.requestId, status: 204 }));
    await expect(active.request).rejects.toMatchObject({ code: 'INVALID_MESSAGE' }); expect(active.client.getContext()).toBeNull();
  });
});
