import { createApiTransport, requestUrl, type Query, type RequestOptions, type WallboardApi } from '../api/client.js';
import { NotAuthenticatedError, type ClientState, type WallboardClient } from './client.js';
import { parseVerifiedUser, type VerifiedUser } from './identity.js';
import { normalizeServerUrl } from './oauth.js';

export const EMBEDDED_UI_PROTOCOL = 'wallboard.custom-ui';
export const EMBEDDED_UI_VERSION = 2;
export type EmbeddedApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface EmbeddedApiPermission {
  readonly method: EmbeddedApiMethod;
  readonly path: string;
  readonly description?: string;
}
export interface EmbeddedAppManifest {
  readonly readOnly: boolean;
  readonly operations: readonly EmbeddedApiPermission[];
}
export interface EmbeddedBootstrap { readonly parentOrigin: string; readonly nonce: string }
export interface EmbeddedWallboardContext {
  readonly appId: number;
  readonly name: string;
  readonly customerId: number;
  readonly serverUrl: string;
  readonly readOnly: boolean;
  readonly manifest: EmbeddedAppManifest;
  readonly user: VerifiedUser;
}
export interface EmbeddedWallboardClientOptions {
  /** The app's complete API requirements. Snapshotted before connecting; host approval is required. */
  manifest: EmbeddedAppManifest;
  /** Exact trusted CMS origin. Normally supplied by the CMS bootstrap query parameters. */
  parentOrigin?: string;
  nonce?: string;
  /** Time to await human permission approval, default five minutes (maximum ten minutes). */
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
}
export interface EmbeddedWallboardClient extends WallboardClient {
  getContext(): EmbeddedWallboardContext | null;
  /** Disconnect this app without logging the CMS user out. A new launch needs a new client. */
  dispose(): void;
}
export class EmbeddedHostError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'EmbeddedHostError';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const methods = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const reservedQuery = /^(authorization|accesstoken|jwtaccesstoken|refreshtoken|clientsecret|password|totp|totpsession|x-totp|x-totp-session|captcha|captchaversion|wbembednonce|wbparentorigin|wbembedversion|__proto__|constructor|prototype)$/i;
function validatePath(path: string, template = false): void {
  const segments = path.split('/').slice(2);
  if (!path.startsWith('/api/') || path.length > 2048 || !segments.length || !/^[A-Za-z0-9_-]+$/.test(segments[0]!) ||
      segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment) && (!template || !/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment)))) {
    throw new TypeError('Use a canonical /api/ path; pass query parameters separately.');
  }
}
export function readEmbeddedBootstrap(url: string): EmbeddedBootstrap {
  const parameters = new URL(url).searchParams;
  for (const key of ['wbEmbedVersion', 'wbParentOrigin', 'wbEmbedNonce']) {
    if (parameters.getAll(key).length !== 1) throw new EmbeddedHostError('INVALID_BOOTSTRAP', 'Open this application from the Wallboard My Apps menu.');
  }
  if (parameters.get('wbEmbedVersion') !== String(EMBEDDED_UI_VERSION)) {
    throw new EmbeddedHostError('UNSUPPORTED_VERSION', 'This application needs a compatible Wallboard embedded UI host.');
  }
  return validateBootstrap(parameters.get('wbParentOrigin')!, parameters.get('wbEmbedNonce')!);
}
function validateBootstrap(parentOrigin: string, nonce: string): EmbeddedBootstrap {
  const normalized = normalizeServerUrl(parentOrigin);
  if (normalized !== parentOrigin || !/^[a-f0-9]{64}$/.test(nonce)) {
    throw new EmbeddedHostError('INVALID_BOOTSTRAP', 'Wallboard supplied an invalid embedded UI launch.');
  }
  return Object.freeze({ parentOrigin, nonce });
}
function parseManifest(value: unknown): EmbeddedAppManifest {
  if (!record(value) || Object.keys(value).some(key => !['readOnly', 'operations'].includes(key)) ||
      typeof value.readOnly !== 'boolean' || !Array.isArray(value.operations) || value.operations.length > 128) {
    throw new EmbeddedHostError('INVALID_MANIFEST', 'Use an app manifest object with readOnly and operations.');
  }
  const declarations = new Set<string>();
  const operations = value.operations.map(permission => {
    if (!record(permission) || Object.keys(permission).some(key => !['method', 'path', 'description'].includes(key)) ||
        typeof permission.method !== 'string' || !methods.has(permission.method) ||
        typeof permission.path !== 'string' || (permission.description !== undefined && (typeof permission.description !== 'string' || permission.description.length > 500))) {
      throw new EmbeddedHostError('INVALID_MANIFEST', 'The app supplied invalid API operations.');
    }
    validatePath(permission.path, true);
    const key = `${permission.method} ${permission.path}`;
    if (declarations.has(key)) throw new EmbeddedHostError('INVALID_MANIFEST', 'The app supplied duplicate API operations.');
    declarations.add(key);
    return Object.freeze({ method: permission.method as EmbeddedApiMethod, path: permission.path,
      ...(permission.description === undefined ? {} : { description: permission.description }) });
  });
  return Object.freeze({ readOnly: value.readOnly, operations: Object.freeze(operations) });
}
function parseContext(value: unknown, declaredManifest: EmbeddedAppManifest): EmbeddedWallboardContext {
  if (!record(value) || !Number.isSafeInteger(value.appId) || Number(value.appId) <= 0 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512 ||
      typeof value.customerId !== 'number' || !Number.isSafeInteger(value.customerId) || value.customerId <= 0 ||
      typeof value.serverUrl !== 'string' || typeof value.readOnly !== 'boolean') {
    throw new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid app context.');
  }
  const serverUrl = normalizeServerUrl(value.serverUrl);
  if (serverUrl !== value.serverUrl) throw new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid server origin.');
  const manifest = parseManifest(value.manifest);
  if (JSON.stringify(manifest) !== JSON.stringify(declaredManifest)) {
    throw new EmbeddedHostError('MANIFEST_MISMATCH', 'Wallboard approved a different app manifest. Open the app again.');
  }
  if (manifest.readOnly && !value.readOnly) {
    throw new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard cannot enable writes for a read-only app.');
  }
  const user = Object.freeze(parseVerifiedUser(value.user));
  return Object.freeze({ appId: Number(value.appId), name: value.name, customerId: value.customerId,
    serverUrl, readOnly: value.readOnly || user.readOnly, manifest, user });
}
function timeout(value: number | undefined, fallback: number, maximum = 120_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new TypeError(`Use a positive timeout of at most ${maximum} milliseconds.`);
  return result;
}
function allowedRead(method: string, path: string): boolean {
  if (method === 'GET') return !['/api/user/microsoft/connect', '/api/user/microsoft/disconnect', '/api/user/totpSecret'].includes(path);
  return method === 'POST' && (/^\/api\/deviceStat\/[^/]+\/graphs$/.test(path) || path === '/api/v2/device/requestLog');
}
interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

/** Tokenless host-managed API transport. Never opens OAuth, reads storage or fetches Wallboard directly. */
export function createEmbeddedWallboardClient(options: EmbeddedWallboardClientOptions): EmbeddedWallboardClient {
  const manifest = parseManifest(structuredClone(options?.manifest));
  if (!globalThis.location || !globalThis.parent || globalThis.parent === globalThis.self) {
    throw new EmbeddedHostError('NOT_EMBEDDED', 'Open this application from the Wallboard My Apps menu.');
  }
  const bootstrap = options.parentOrigin !== undefined && options.nonce !== undefined
    ? validateBootstrap(options.parentOrigin, options.nonce) : readEmbeddedBootstrap(globalThis.location.href);
  if ((options.parentOrigin !== undefined && options.parentOrigin !== bootstrap.parentOrigin) ||
      (options.nonce !== undefined && options.nonce !== bootstrap.nonce)) throw new EmbeddedHostError('INVALID_BOOTSTRAP', 'The embedded UI launch does not match its configured host.');
  const connectionTimeoutMs = timeout(options.connectionTimeoutMs, 300_000, 600_000);
  const requestTimeoutMs = timeout(options.requestTimeoutMs, 35_000);
  const listeners = new Set<(state: ClientState) => void>();
  const pending = new Map<string, PendingRequest>();
  let context: EmbeddedWallboardContext | null = null;
  let apiClient: WallboardApi | null = null;
  let port: MessagePort | null = null;
  let disposed = false;
  let connection: Promise<void> | null = null;
  let resolveConnection: (() => void) | null = null;
  let rejectConnection: ((error: Error) => void) | null = null;
  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let state: ClientState = Object.freeze({ status: 'idle', serverUrl: '', clientId: null, user: null, displayIdentity: null, customerId: null, readOnly: false, error: null });
  function emit(status: ClientState['status'], error: Error | null = null): void {
    state = Object.freeze({ status, serverUrl: context?.serverUrl ?? state.serverUrl, clientId: null,
      user: context?.user ?? null, displayIdentity: null, customerId: context?.customerId ?? null,
      readOnly: context?.readOnly ?? false, error });
    for (const listener of listeners) { try { listener(state); } catch { /* Rendering failures must not change transport state. */ } }
  }
  function finish(requestId: string): PendingRequest | undefined {
    const request = pending.get(requestId);
    if (request) { pending.delete(requestId); clearTimeout(request.timer); request.cleanup(); }
    return request;
  }
  function disconnect(error: Error, status: ClientState['status'] = 'error'): void {
    disposed = true;
    if (connectionTimer) clearTimeout(connectionTimer);
    connectionTimer = null;
    rejectConnection?.(error); rejectConnection = null; resolveConnection = null;
    for (const id of pending.keys()) {
      try { port?.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'api-cancel', requestId: id }); } catch { /* The host may already be closed. */ }
      finish(id)?.reject(error);
    }
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
    port = null; context = null; apiClient = null;
    emit(status, status === 'anonymous' ? null : error);
  }
  function receive(value: unknown): void {
    if (disposed || !record(value) || value.protocol !== EMBEDDED_UI_PROTOCOL || value.version !== EMBEDDED_UI_VERSION) return;
    if (value.type === 'context') {
      if (context) { disconnect(new EmbeddedHostError('CONTEXT_CHANGED', 'The Wallboard app context changed. Open the app again.')); return; }
      try {
        context = parseContext(value.context, manifest);
        if (context.serverUrl !== bootstrap.parentOrigin) throw new EmbeddedHostError('INVALID_MESSAGE', 'The app server does not match its configured Wallboard host.');
        apiClient = createApiTransport(send, (path, request) => requestUrl(context!.serverUrl, path, withCustomer(path, request)));
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
        emit('authenticated'); resolveConnection?.(); resolveConnection = null; rejectConnection = null;
      } catch (cause) { disconnect(cause instanceof Error ? cause : new EmbeddedHostError('INVALID_MESSAGE', 'The app context could not be read.')); }
    } else if (value.type === 'api-response' && typeof value.requestId === 'string' && pending.has(value.requestId)) {
      if (!Number.isSafeInteger(value.status) || Number(value.status) < 200 || Number(value.status) > 599 ||
          (value.contentType !== undefined && (typeof value.contentType !== 'string' || /[\r\n]/.test(value.contentType)))) {
        disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid API response.')); return;
      }
      try {
        const status = Number(value.status);
        const contentType = typeof value.contentType === 'string' ? value.contentType : 'application/json';
        const isJson = contentType.includes('/json') || contentType.includes('+json');
        const body = [204, 205, 304].includes(status) || value.body === undefined ? null :
          isJson ? JSON.stringify(value.body) : value.body === null ? null : typeof value.body === 'string' ? value.body : JSON.stringify(value.body);
        const response = new Response(body, { status, headers: { 'Content-Type': contentType } });
        finish(value.requestId)?.resolve(response);
      } catch { disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an unreadable API response.')); }
    } else if (value.type === 'error') {
      if (typeof value.code !== 'string' || value.code.length > 80 || typeof value.message !== 'string' || value.message.length > 512 ||
          (value.status !== undefined && (!Number.isSafeInteger(value.status) || Number(value.status) < 400 || Number(value.status) > 599))) {
        disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid host error.')); return;
      }
      const error = new EmbeddedHostError(value.code, value.message, value.status as number | undefined);
      if (['CONTEXT_CHANGED', 'AUTH_REQUIRED', 'UNAVAILABLE'].includes(value.code) || value.requestId === undefined) {
        disconnect(error, value.code === 'AUTH_REQUIRED' ? 'anonymous' : 'error');
      } else if (typeof value.requestId === 'string') finish(value.requestId)?.reject(error);
    }
  }
  function connect(): Promise<void> {
    if (disposed) return Promise.reject(new NotAuthenticatedError('The embedded session closed. Open the app again.'));
    if (context) return Promise.resolve();
    if (connection) return connection;
    emit('checking');
    connection = new Promise((resolve, reject) => {
      resolveConnection = resolve; rejectConnection = reject;
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = event => receive(event.data);
      port.onmessageerror = () => disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'The Wallboard message channel could not be read.'));
      port.start();
      connectionTimer = setTimeout(() => disconnect(new EmbeddedHostError('CONNECTION_TIMEOUT', 'Wallboard did not approve this app in time. Open it again from My Apps.')), connectionTimeoutMs);
      try { globalThis.parent.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'connect', nonce: bootstrap.nonce, manifest }, bootstrap.parentOrigin, [channel.port2]); }
      catch { channel.port2.close(); disconnect(new EmbeddedHostError('CONNECTION_FAILED', 'The Wallboard host could not receive this app connection.')); }
    });
    return connection;
  }
  function withCustomer(path: string, request: RequestOptions = {}): RequestOptions {
    if (!context || disposed) throw new NotAuthenticatedError('The embedded session closed. Open the app again.');
    if (path === '/api/v2/user/me' || request.instance || request.customerId !== undefined || request.query?.customerId !== undefined) return request;
    return { ...request, customerId: context.customerId };
  }
  async function send(path: string, method: string, request: RequestOptions = {}): Promise<Response> {
    await connect();
    request.signal?.throwIfAborted();
    validatePath(path);
    if (!methods.has(method)) throw new EmbeddedHostError('INVALID_REQUEST', 'The embedded proxy supports GET, POST, PUT, PATCH and DELETE only.');
    if (request.headers && [...new Headers(request.headers).keys()].length) throw new EmbeddedHostError('INVALID_REQUEST', 'The Wallboard host owns all API request headers.');
    if (method === 'GET' && request.body !== undefined) throw new EmbeddedHostError('INVALID_REQUEST', 'GET requests cannot contain a body.');
    if (context!.readOnly && !allowedRead(method, path)) throw new EmbeddedHostError('READ_ONLY', 'This app is running read-only.', 403);
    const scoped = withCustomer(path, request);
    const url = new URL(requestUrl(context!.serverUrl, path, scoped));
    const params: Query = {};
    for (const key of new Set(url.searchParams.keys())) {
      if (reservedQuery.test(key) || /[\u0000-\u001f\u007f]/.test(key)) throw new EmbeddedHostError('INVALID_REQUEST', 'Authentication and host parameters cannot be supplied by an app.');
      const values = url.searchParams.getAll(key); params[key] = values.length === 1 ? values[0] : values;
    }
    // Requests are JSON-only; binary streams and request headers belong to a separate integration.
    const body = request.body === undefined ? undefined : JSON.parse(JSON.stringify(request.body)) as unknown;
    const requestId = `api-${crypto.randomUUID()}`;
    return new Promise<Response>((resolve, reject) => {
      const cancel = (error: unknown) => {
        const active = finish(requestId);
        if (!active) return;
        try { port?.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'api-cancel', requestId }); } catch { /* Settle locally even when the host has closed. */ }
        active.reject(error);
      };
      const abort = () => cancel(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      pending.set(requestId, { resolve, reject,
        timer: setTimeout(() => cancel(new EmbeddedHostError('REQUEST_TIMEOUT', 'Wallboard did not complete this API request.')), requestTimeoutMs),
        cleanup: () => request.signal?.removeEventListener('abort', abort) });
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) { abort(); return; }
      try { port!.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'api-request', requestId, method, path,
        ...(Object.keys(params).length ? { params } : {}), ...(body === undefined ? {} : { body }) }); }
      catch { finish(requestId)?.reject(new EmbeddedHostError('INVALID_REQUEST', 'The API request could not be sent to Wallboard.')); }
    });
  }
  return {
    async initialize() { await connect(); return state; },
    async signIn() { throw new EmbeddedHostError('HOST_MANAGED_AUTH', 'Wallboard manages this embedded session. Open the app again from My Apps.'); },
    async getToken() { throw new EmbeddedHostError('API_PROXY_ONLY', 'Embedded apps use the Wallboard API proxy and cannot obtain a Wallboard token.'); },
    signOut() { disconnect(new NotAuthenticatedError('The app session closed.'), 'anonymous'); },
    dispose() { disconnect(new NotAuthenticatedError('The app session closed.'), 'anonymous'); },
    getState: () => state, getContext: () => context,
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    get api() { if (!apiClient) throw new NotAuthenticatedError('Initialize the embedded client before using its API.'); return apiClient; },
  };
}
