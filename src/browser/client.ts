import { createWallboardApi, type WallboardApi } from '../api/client.js';
import { decodeDisplayIdentity, parseVerifiedUser, type DisplayIdentity, type VerifiedUser } from './identity.js';
import { discoverClient, normalizeServerUrl, OAuthError, requestTokens, type OAuthEndpoints, type TokenResponse } from './oauth.js';
import { createCodeChallenge, createCodeVerifier, createState } from './pkce.js';
import { readStored, removeStored, StorageUnavailableError, writeStored, type StorageLike } from './storage.js';

export interface ClientState {
  readonly status: 'idle' | 'checking' | 'anonymous' | 'authenticated' | 'error';
  readonly serverUrl: string;
  readonly clientId: string | null;
  readonly user: VerifiedUser | null;
  readonly displayIdentity: DisplayIdentity | null;
  /** Effective customer selector from the OAuth response, then verified user identity. */
  readonly customerId: number | null;
  readonly readOnly: boolean;
  readonly error: Error | null;
}

export interface WallboardClientOptions {
  serverUrl: string;
  clientId?: string;
  /** Exact registered callback URL. Defaults to the current browser origin, without a slash. */
  redirectUri?: string;
  /** Tab-local sessionStorage by default. Shared persistent storage needs cross-tab refresh coordination. */
  storage?: StorageLike;
  fetch?: typeof globalThis.fetch;
  clientName?: string;
}

export interface SignInOptions {
  /** Same-origin path to restore after sign-in. Defaults to the current path. */
  returnTo?: string;
  /** Default false: request a one-hour refresh token rather than a 30-day token. */
  keepSignedIn?: boolean;
}

export interface WallboardClient {
  initialize(): Promise<ClientState>;
  signIn(options?: SignInOptions): Promise<void>;
  /** Clears this app's stored session; does not log out of the Wallboard server. */
  signOut(): void;
  getToken(forceRefresh?: boolean): Promise<string>;
  getState(): ClientState;
  subscribe(listener: (state: ClientState) => void): () => void;
  readonly api: WallboardApi;
}

interface Session {
  serverUrl: string;
  clientId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number;
  customerId: number | null;
  readOnly: boolean;
  keepSignedIn: boolean;
}

interface Transaction {
  state: string;
  verifier: string;
  serverUrl: string;
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
  returnTo: string;
  keepSignedIn: boolean;
  createdAt: number;
}

interface CachedClient { clientId: string; endpoints: OAuthEndpoints }

interface RefreshTask {
  refreshToken: string;
  promise: Promise<TokenResponse>;
}
// Multiple components may create clients in one tab. They still share one rotating token.
const refreshTasks = new WeakMap<StorageLike, Map<string, RefreshTask>>();

export class NotAuthenticatedError extends Error {
  constructor(message = 'Sign in to Wallboard first.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

export class OAuthStateError extends Error {
  constructor() {
    super('The sign-in callback is missing, expired, already used, or does not match this app. Start sign-in again.');
    this.name = 'OAuthStateError';
  }
}

export function sanitizeReturnTo(candidate: string, origin: string): string {
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) throw new TypeError('returnTo must be a same-origin path.');
  const url = new URL(candidate, origin);
  if (url.origin !== origin) throw new TypeError('returnTo must stay on this app origin.');
  for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

function validSession(value: Session | null, serverUrl: string, clientId: string): value is Session {
  return Boolean(value && value.serverUrl === serverUrl && value.clientId === clientId && typeof value.accessToken === 'string' && value.accessToken && Number.isFinite(value.accessExpiresAt) && Number.isFinite(value.refreshExpiresAt) && (value.refreshToken === null || typeof value.refreshToken === 'string') && typeof value.keepSignedIn === 'boolean' && typeof value.readOnly === 'boolean' && (value.customerId === null || (Number.isSafeInteger(value.customerId) && value.customerId > 0)));
}

export function createWallboardClient(options: WallboardClientOptions): WallboardClient {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  if (!globalThis.location || !globalThis.history) throw new Error('The browser client needs a browser location and history. Use the protocol/API layer on a backend.');
  const appOrigin = globalThis.location.origin;
  const redirectUri = options.redirectUri ?? appOrigin;
  const callback = new URL(redirectUri);
  if (callback.origin !== appOrigin || callback.username || callback.password || callback.search || callback.hash || (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)))) {
    throw new TypeError('The callback must be an HTTPS URL on this app origin, or HTTP localhost. Register it exactly.');
  }
  if (options.clientId !== undefined && !options.clientId.trim()) throw new TypeError('clientId cannot be blank.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const prefix = `wallboard.ui:${encodeURIComponent(serverUrl)}:${encodeURIComponent(redirectUri)}`;
  const clientKey = `${prefix}:client`;
  const transactionKey = `${prefix}:transaction`;
  let clientId: string | null = options.clientId ?? null;
  let endpoints: OAuthEndpoints = { authorize: `${serverUrl}/oauth/authorize`, token: `${serverUrl}/oauth/token` };
  let session: Session | null = null;
  let identity: VerifiedUser | null = null;
  let epoch = 0;
  let initializing: Promise<ClientState> | null = null;
  let refreshing: Promise<string> | null = null;
  const listeners = new Set<(state: ClientState) => void>();
  let state: ClientState = Object.freeze({ status: 'idle', serverUrl, clientId, user: null, displayIdentity: null, customerId: null, readOnly: false, error: null });

  function storage(): StorageLike {
    try {
      const area = options.storage ?? globalThis.sessionStorage;
      if (!area) throw new StorageUnavailableError();
      return area;
    } catch { throw new StorageUnavailableError(); }
  }
  const sessionKey = () => `${prefix}:session:${encodeURIComponent(clientId ?? '')}`;

  function emit(status: ClientState['status'], error: Error | null = null): void {
    state = Object.freeze({
      status, serverUrl, clientId,
      user: identity ? Object.freeze({ ...identity }) : null,
      displayIdentity: session ? decodeDisplayIdentity(session.accessToken) : null,
      customerId: session?.customerId ?? identity?.customerId ?? null,
      readOnly: session?.readOnly === true || identity?.readOnly === true,
      error,
    });
    for (const listener of listeners) {
      // Subscriber mistakes cannot interrupt token persistence or invalidate OAuth state.
      try { listener(state); } catch { /* The subscriber owns its rendering failure. */ }
    }
  }

  function restoreClient(): void {
    if (options.clientId) return;
    const cached = readStored<CachedClient>(storage(), clientKey);
    if (!cached || typeof cached.clientId !== 'string' || !cached.clientId || !cached.endpoints) return;
    for (const url of [cached.endpoints.authorize, cached.endpoints.token]) {
      if (typeof url !== 'string' || new URL(url).origin !== serverUrl) throw new OAuthStateError();
    }
    clientId = cached.clientId;
    endpoints = cached.endpoints;
  }

  function persist(tokens: TokenResponse, keepSignedIn: boolean, expectedEpoch: number): void {
    if (expectedEpoch !== epoch) throw new NotAuthenticatedError('Sign-in was cancelled.');
    const now = Date.now();
    const next: Session = {
      serverUrl, clientId: clientId!, accessToken: tokens.access_token,
      accessExpiresAt: now + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token ?? null,
      refreshExpiresAt: now + (tokens.refresh_total_validity_seconds ?? (keepSignedIn ? 2592000 : 3600)) * 1000,
      customerId: tokens.customerId ?? null,
      readOnly: tokens.readOnly === true,
      keepSignedIn,
    };
    writeStored(storage(), sessionKey(), next);
    session = next;
    emit(identity ? 'authenticated' : 'checking');
  }

  async function getToken(forceRefresh = false): Promise<string> {
    if (!session) throw new NotAuthenticatedError();
    const area = storage();
    const key = sessionKey();
    const stored = readStored<Session>(area, key);
    if (!validSession(stored, serverUrl, clientId!)) {
      session = null;
      identity = null;
      emit('anonymous');
      throw new NotAuthenticatedError();
    }
    if (stored.accessToken !== session.accessToken) session = stored;
    if (!forceRefresh && session.accessExpiresAt - 60_000 > Date.now()) return session.accessToken;
    if (refreshing) return refreshing;
    if (!session.refreshToken || session.refreshExpiresAt <= Date.now()) {
      signOut();
      throw new NotAuthenticatedError('The session expired. Sign in again.');
    }
    const current = session;
    const expectedEpoch = epoch;
    refreshing = (async () => {
      try {
        let tasks = refreshTasks.get(area);
        if (!tasks) { tasks = new Map(); refreshTasks.set(area, tasks); }
        let task = tasks.get(key);
        if (!task || task.refreshToken !== current.refreshToken) {
          const ownerTasks = tasks;
          const nextTask: RefreshTask = {
            refreshToken: current.refreshToken!,
            promise: requestTokens(endpoints.token, {
              grant_type: 'refresh_token', refresh_token: current.refreshToken!, client_id: current.clientId,
              kmsi: String(current.keepSignedIn),
            }, fetcher).then(tokens => {
              // A newer sign-in or sign-out must not be overwritten by an older refresh.
              const stillCurrent = readStored<Session>(area, key);
              if (!stillCurrent || stillCurrent.refreshToken !== current.refreshToken) throw new NotAuthenticatedError('Sign-in was cancelled.');
              persist(tokens, current.keepSignedIn, expectedEpoch);
              return tokens;
            }).finally(() => { if (ownerTasks.get(key) === nextTask) ownerTasks.delete(key); }),
          };
          tasks.set(key, nextTask);
          task = nextTask;
        }
        const tokens = await task.promise;
        const refreshed = readStored<Session>(area, key);
        if (expectedEpoch !== epoch || !validSession(refreshed, serverUrl, clientId!) || refreshed.accessToken !== tokens.access_token) throw new NotAuthenticatedError('Sign-in was cancelled.');
        session = refreshed;
        emit(identity ? 'authenticated' : 'checking');
        return tokens.access_token;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('The session could not be refreshed.');
        if (expectedEpoch !== epoch) throw error;
        const temporary = cause instanceof OAuthError && (cause.status === 0 || cause.status === 408 || cause.status === 425 || cause.status === 429 || cause.status >= 500);
        if (!temporary) {
          session = null;
          identity = null;
          // Do not clear a newer login which replaced the session we were refreshing.
          const storedAfterFailure = readStored<Session>(area, key);
          if (storedAfterFailure?.refreshToken === current.refreshToken) removeStored(area, key);
        }
        emit(temporary && identity ? 'authenticated' : 'error', error);
        throw error;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  const api = createWallboardApi({ serverUrl, getToken, fetch: fetcher });

  async function initializeOnce(): Promise<ClientState> {
    const expectedEpoch = epoch;
    emit('checking');
    try {
      const url = new URL(globalThis.location.href);
      const isCallback = url.searchParams.has('code') || url.searchParams.has('error');
      const code = url.searchParams.get('code');
      const callbackState = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      // Remove one-use codes before storage, discovery or network work can fail.
      if (isCallback) {
        for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key);
        globalThis.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
      restoreClient();
      if (isCallback) {
        const transaction = readStored<Transaction>(storage(), transactionKey);
        removeStored(storage(), transactionKey);
        if (!transaction || !callbackState || url.pathname !== callback.pathname || transaction.state !== callbackState || transaction.serverUrl !== serverUrl || transaction.clientId !== clientId || transaction.redirectUri !== redirectUri || !Number.isFinite(transaction.createdAt) || transaction.createdAt > Date.now() || Date.now() - transaction.createdAt > 600_000 || typeof transaction.keepSignedIn !== 'boolean' || typeof transaction.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.verifier) || new URL(transaction.tokenEndpoint).origin !== serverUrl) throw new OAuthStateError();
        if (!code || oauthError) throw new OAuthError(400, oauthError || 'Sign-in was cancelled.');
        const tokens = await requestTokens(transaction.tokenEndpoint, {
          grant_type: 'authorization_code', code, code_verifier: transaction.verifier,
          client_id: transaction.clientId, redirect_uri: transaction.redirectUri, kmsi: String(transaction.keepSignedIn),
        }, fetcher);
        persist(tokens, transaction.keepSignedIn, expectedEpoch);
        globalThis.history.replaceState(null, '', sanitizeReturnTo(transaction.returnTo, appOrigin));
      } else if (clientId) {
        const saved = readStored<Session>(storage(), sessionKey());
        if (validSession(saved, serverUrl, clientId)) session = saved;
        else if (saved) removeStored(storage(), sessionKey());
      }
      if (!session) {
        emit('anonymous');
        return state;
      }
      await getToken();
      const user = parseVerifiedUser(await api.get('/api/v2/user/me'));
      if (expectedEpoch !== epoch) throw new NotAuthenticatedError('Sign-in was cancelled.');
      identity = user;
      emit('authenticated');
      return state;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Wallboard sign-in failed.');
      if (expectedEpoch === epoch) emit('error', error);
      throw error;
    }
  }

  async function signIn(signInOptions: SignInOptions = {}): Promise<void> {
    if (globalThis.self !== globalThis.top) throw new Error('Start Wallboard sign-in from a top-level app tab. Embedded popup authentication is not implemented.');
    const expectedEpoch = epoch;
    try {
      restoreClient();
      if (!clientId) {
        const discovered = await discoverClient(serverUrl, redirectUri, fetcher, options.clientName);
        writeStored(storage(), clientKey, discovered);
        clientId = discovered.clientId;
        endpoints = discovered.endpoints;
      }
      const verifier = createCodeVerifier();
      const challenge = await createCodeChallenge(verifier);
      const oauthState = createState();
      const here = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
      const transaction: Transaction = {
        state: oauthState, verifier, serverUrl, clientId, redirectUri, tokenEndpoint: endpoints.token,
        returnTo: sanitizeReturnTo(signInOptions.returnTo ?? here, appOrigin),
        keepSignedIn: signInOptions.keepSignedIn ?? false, createdAt: Date.now(),
      };
      if (expectedEpoch !== epoch) throw new NotAuthenticatedError('Sign-in was cancelled.');
      writeStored(storage(), transactionKey, transaction);
      const authorize = new URL(endpoints.authorize);
      authorize.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'FULL_ACCESS',
        state: oauthState, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      emit('checking');
      globalThis.location.assign(authorize.toString());
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Sign-in could not start.');
      if (expectedEpoch === epoch) emit('error', error);
      throw error;
    }
  }

  function signOut(): void {
    epoch++;
    session = null;
    identity = null;
    emit('anonymous');
    removeStored(storage(), sessionKey());
    removeStored(storage(), transactionKey);
  }

  return {
    initialize() {
      if (!initializing) initializing = Promise.resolve().then(initializeOnce).finally(() => { initializing = null; });
      return initializing;
    },
    signIn, signOut, getToken, api,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
  };
}
