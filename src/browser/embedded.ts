import { createWallboardApi, validateCustomerId, type RequestOptions, type WallboardApi } from '../api/client.js';
import { NotAuthenticatedError, type ClientState, type WallboardClient } from './client.js';
import { decodeDisplayIdentity, parseVerifiedUser, type VerifiedUser } from './identity.js';
import { normalizeServerUrl } from './oauth.js';

export const EMBEDDED_UI_PROTOCOL = 'wallboard.custom-ui';
export const EMBEDDED_UI_VERSION = 1;

export interface EmbeddedBootstrap {
  readonly parentOrigin: string;
  readonly nonce: string;
}

export interface EmbeddedWallboardContext {
  readonly appId: number;
  readonly name: string;
  readonly customerId: number;
  readonly serverUrl: string;
}

export interface EmbeddedWallboardClientOptions {
  /** Exact trusted CMS origin. Normally supplied by the CMS bootstrap query parameters. */
  parentOrigin?: string;
  nonce?: string;
  fetch?: typeof globalThis.fetch;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface EmbeddedWallboardClient extends WallboardClient {
  getContext(): EmbeddedWallboardContext | null;
  /** Disconnect this app without logging the CMS user out. A new launch needs a new client. */
  dispose(): void;
}

export class EmbeddedHostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EmbeddedHostError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function parseContext(value: unknown): EmbeddedWallboardContext {
  if (!record(value) || !Number.isSafeInteger(value.appId) || Number(value.appId) <= 0 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512 ||
      typeof value.customerId !== 'number' || !Number.isSafeInteger(value.customerId) || value.customerId <= 0 ||
      typeof value.serverUrl !== 'string') throw new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid app context.');
  validateCustomerId(Number(value.customerId));
  const serverUrl = normalizeServerUrl(value.serverUrl);
  if (serverUrl !== value.serverUrl) throw new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid server origin.');
  return Object.freeze({ appId: Number(value.appId), name: value.name, customerId: value.customerId, serverUrl });
}

function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 120_000) throw new TypeError('Use a positive timeout of at most two minutes.');
  return result;
}

/** Host-managed, in-memory authentication. This client never opens OAuth or reads browser storage. */
export function createEmbeddedWallboardClient(options: EmbeddedWallboardClientOptions = {}): EmbeddedWallboardClient {
  if (!globalThis.location || !globalThis.parent || globalThis.parent === globalThis.self) {
    throw new EmbeddedHostError('NOT_EMBEDDED', 'Open this application from the Wallboard My Apps menu.');
  }
  const bootstrap = options.parentOrigin !== undefined && options.nonce !== undefined
    ? validateBootstrap(options.parentOrigin, options.nonce)
    : readEmbeddedBootstrap(globalThis.location.href);
  if ((options.parentOrigin !== undefined && options.parentOrigin !== bootstrap.parentOrigin) ||
      (options.nonce !== undefined && options.nonce !== bootstrap.nonce)) throw new EmbeddedHostError('INVALID_BOOTSTRAP', 'The embedded UI launch does not match its configured host.');
  const connectionTimeoutMs = timeout(options.connectionTimeoutMs, 15_000);
  // The CMS host allows 30 seconds for launch revalidation and session renewal.
  const requestTimeoutMs = timeout(options.requestTimeoutMs, 35_000);
  const fetcher = options.fetch ?? globalThis.fetch;
  const listeners = new Set<(state: ClientState) => void>();
  const controller = new AbortController();
  let context: EmbeddedWallboardContext | null = null;
  let apiClient: WallboardApi | null = null;
  let user: VerifiedUser | null = null;
  let token: { accessToken: string; expiresAt: number } | null = null;
  let port: MessagePort | null = null;
  let disposed = false;
  let connection: Promise<void> | null = null;
  let resolveConnection: (() => void) | null = null;
  let rejectConnection: ((error: Error) => void) | null = null;
  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let initializing: Promise<ClientState> | null = null;
  let renewing: Promise<string> | null = null;
  let pending: { id: string; resolve: (token: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let state: ClientState = Object.freeze({ status: 'idle', serverUrl: '', clientId: null, user: null, displayIdentity: null, customerId: null, readOnly: false, error: null });

  function emit(status: ClientState['status'], error: Error | null = null): void {
    const displayIdentity = token ? decodeDisplayIdentity(token.accessToken) : null;
    state = Object.freeze({
      status, serverUrl: context?.serverUrl ?? state.serverUrl, clientId: null,
      user: user ? Object.freeze({ ...user }) : null,
      displayIdentity: displayIdentity ? Object.freeze(displayIdentity) : null,
      customerId: context ? Number(context.customerId) : null,
      readOnly: user?.readOnly === true || displayIdentity?.readOnly === true, error,
    });
    for (const listener of listeners) {
      try { listener(state); } catch { /* Subscriber rendering failures do not affect authentication. */ }
    }
  }

  function disconnect(error: Error, status: ClientState['status'] = 'error'): void {
    disposed = true;
    controller.abort(error);
    if (connectionTimer) clearTimeout(connectionTimer);
    connectionTimer = null;
    rejectConnection?.(error);
    rejectConnection = null;
    resolveConnection = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
    port = null;
    token = null;
    user = null;
    context = null;
    apiClient = null;
    emit(status, status === 'anonymous' ? null : error);
  }

  function withCustomer(path: string, request: RequestOptions = {}): RequestOptions {
    if (!context || disposed) throw new NotAuthenticatedError('The embedded session closed. Open the app again.');
    if (path === '/api/v2/user/me' || request.instance || request.customerId !== undefined || request.query?.customerId !== undefined) return request;
    return { ...request, customerId: Number(context!.customerId) };
  }

  function createApi(serverUrl: string): WallboardApi {
    const base = createWallboardApi({ serverUrl, getToken, fetch: fetcher });
    return {
      get: (path, request) => base.get(path, withCustomer(path, request)),
      post: (path, request) => base.post(path, withCustomer(path, request)),
      put: (path, request) => base.put(path, withCustomer(path, request)),
      patch: (path, request) => base.patch(path, withCustomer(path, request)),
      delete: (path, request) => base.delete(path, withCustomer(path, request)),
      raw: (path, method, request) => base.raw(path, method, withCustomer(path, request)),
      forCustomer: base.forCustomer,
    };
  }

  function receive(value: unknown): void {
    if (disposed || !record(value) || value.protocol !== EMBEDDED_UI_PROTOCOL || value.version !== EMBEDDED_UI_VERSION) return;
    if (value.type === 'ready') {
      if (context) { disconnect(new EmbeddedHostError('CONTEXT_CHANGED', 'The Wallboard app context changed. Open the app again.')); return; }
      try {
        context = parseContext(value.context);
        if (context.serverUrl !== bootstrap.parentOrigin) throw new EmbeddedHostError('INVALID_MESSAGE', 'The app server does not match its configured Wallboard host.');
        apiClient = createApi(context.serverUrl);
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
        resolveConnection?.();
        resolveConnection = null;
        rejectConnection = null;
      } catch (cause) { disconnect(cause instanceof Error ? cause : new EmbeddedHostError('INVALID_MESSAGE', 'The app context could not be read.')); }
    } else if (value.type === 'access-token' && pending && value.requestId === pending.id) {
      if (!context || typeof value.accessToken !== 'string' || value.accessToken.length > 65_536 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.accessToken) ||
          !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now()) {
        disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid or expired access token.')); return;
      }
      token = { accessToken: value.accessToken, expiresAt: Number(value.expiresAt) };
      clearTimeout(pending.timer);
      pending.resolve(token.accessToken);
      pending = null;
      emit(user ? 'authenticated' : 'checking');
    } else if (value.type === 'error' && (value.requestId === undefined || value.requestId === pending?.id)) {
      const codes = ['UNAVAILABLE', 'CONTEXT_CHANGED', 'AUTH_REQUIRED', 'INVALID_REQUEST'];
      if (typeof value.code !== 'string' || !codes.includes(value.code) || typeof value.message !== 'string' || value.message.length > 512) {
        disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'Wallboard supplied an invalid host error.')); return;
      }
      disconnect(new EmbeddedHostError(value.code, value.message), value.code === 'AUTH_REQUIRED' ? 'anonymous' : 'error');
    }
  }

  function connect(): Promise<void> {
    if (disposed) return Promise.reject(new NotAuthenticatedError('The embedded session closed. Open the app again.'));
    if (context) return Promise.resolve();
    if (connection) return connection;
    emit('checking');
    connection = new Promise((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = event => receive(event.data);
      port.onmessageerror = () => disconnect(new EmbeddedHostError('INVALID_MESSAGE', 'The Wallboard message channel could not be read.'));
      port.start();
      connectionTimer = setTimeout(() => disconnect(new EmbeddedHostError('CONNECTION_TIMEOUT', 'Wallboard did not connect this app. Open it again from My Apps.')), connectionTimeoutMs);
      try {
        globalThis.parent.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'connect', nonce: bootstrap.nonce }, bootstrap.parentOrigin, [channel.port2]);
      } catch {
        channel.port2.close();
        disconnect(new EmbeddedHostError('CONNECTION_FAILED', 'The Wallboard host could not receive this app connection.'));
      }
    });
    return connection;
  }

  async function getToken(forceRefresh = false): Promise<string> {
    await connect();
    if (disposed || !context || !port) throw new NotAuthenticatedError('The embedded session closed. Open the app again.');
    if (!forceRefresh && token && token.expiresAt - Date.now() > 60_000) return token.accessToken;
    if (renewing) return renewing;
    const requestId = `token-${crypto.randomUUID()}`;
    renewing = new Promise<string>((resolve, reject) => {
      pending = { id: requestId, resolve, reject, timer: setTimeout(() => disconnect(new EmbeddedHostError('TOKEN_TIMEOUT', 'Wallboard did not provide an access token. Open the app again.')), requestTimeoutMs) };
      try {
        port!.postMessage({ protocol: EMBEDDED_UI_PROTOCOL, version: EMBEDDED_UI_VERSION, type: 'get-access-token', requestId });
      } catch { disconnect(new EmbeddedHostError('CONNECTION_FAILED', 'The Wallboard app session disconnected.')); }
    }).finally(() => { renewing = null; });
    return renewing;
  }

  async function initialize(): Promise<ClientState> {
    try {
      await connect();
      await getToken();
      const verified = parseVerifiedUser(await apiClient!.get('/api/v2/user/me', { signal: controller.signal }));
      if (disposed) throw new NotAuthenticatedError('The embedded session closed. Open the app again.');
      user = verified;
      emit('authenticated');
      return state;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Embedded sign-in failed.');
      if (!disposed) emit('error', error);
      throw error;
    }
  }

  return {
    initialize() {
      if (!initializing) initializing = initialize().finally(() => { initializing = null; });
      return initializing;
    },
    async signIn() { throw new EmbeddedHostError('HOST_MANAGED_AUTH', 'Wallboard manages this embedded session. Open the app again from My Apps.'); },
    signOut() { disconnect(new NotAuthenticatedError('The app session closed.'), 'anonymous'); },
    dispose() { disconnect(new NotAuthenticatedError('The app session closed.'), 'anonymous'); },
    getToken,
    getState: () => state,
    getContext: () => context,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    get api() {
      if (!apiClient) throw new NotAuthenticatedError('Initialize the embedded client before using its API.');
      return apiClient;
    },
  };
}
