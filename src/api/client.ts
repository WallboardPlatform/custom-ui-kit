export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Explicit tenant scope. This is a request selector, not an authorization grant. */
  customerId?: number;
  /** Explicitly request an instance operation. Backend permissions still apply. */
  instance?: true;
}

export type ScopedRequestOptions = Omit<RequestOptions, 'customerId' | 'instance'>;

export interface WallboardApi {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  raw(path: string, method?: string, options?: RequestOptions): Promise<Response>;
  forCustomer(customerId: number): CustomerApi;
}

export interface CustomerApi {
  get<T = unknown>(path: string, options?: ScopedRequestOptions): Promise<T>;
  post<T = unknown>(path: string, options?: ScopedRequestOptions): Promise<T>;
  put<T = unknown>(path: string, options?: ScopedRequestOptions): Promise<T>;
  patch<T = unknown>(path: string, options?: ScopedRequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: ScopedRequestOptions): Promise<T>;
  raw(path: string, method?: string, options?: ScopedRequestOptions): Promise<Response>;
}

export class WallboardApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'WallboardApiError';
  }
}

export class CustomerScopeRequiredError extends Error {
  constructor() {
    super('Choose an explicit customerId, use api.forCustomer(id), or explicitly request instance: true.');
    this.name = 'CustomerScopeRequiredError';
  }
}

export function validateCustomerId(customerId: number): number {
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    throw new TypeError('customerId must be a positive safe integer.');
  }
  return customerId;
}

function requestUrl(serverUrl: string, path: string, options: RequestOptions): string {
  if (!path.startsWith('/api/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    throw new TypeError('Use an /api/ path without a query or fragment; pass query separately.');
  }
  const url = new URL(path, serverUrl);
  if (url.origin !== new URL(serverUrl).origin || !url.pathname.startsWith('/api/')) {
    throw new TypeError('The API path must stay on the configured Wallboard server.');
  }
  const query = { ...options.query };
  const queryCustomer = query.customerId;
  if (options.customerId !== undefined) {
    validateCustomerId(options.customerId);
    if (options.instance || (queryCustomer !== undefined && queryCustomer !== options.customerId)) {
      throw new TypeError('Conflicting customer scope.');
    }
    query.customerId = options.customerId;
  } else if (queryCustomer !== undefined) {
    if (typeof queryCustomer !== 'number') throw new TypeError('Use a numeric customerId.');
    validateCustomerId(queryCustomer);
    if (options.instance) throw new TypeError('Choose either customer or instance scope.');
  } else if (path !== '/api/v2/user/me' && !options.instance) {
    throw new CustomerScopeRequiredError();
  }
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined && item !== '') url.searchParams.append(key, String(item));
    }
  }
  return url.toString();
}

function errorMessage(body: unknown, response: Response): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
  }
  return typeof body === 'string' && body.trim() ? body.slice(0, 300) : `${response.status} ${response.statusText}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface ApiClientOptions {
  serverUrl: string;
  getToken(forceRefresh?: boolean): Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Retry delay can be reduced by a test transport. Default: 1200ms. */
  retryDelayMs?: number;
}

export function createWallboardApi(options: ApiClientOptions): WallboardApi {
  const fetcher = options.fetch ?? globalThis.fetch;
  const retryDelayMs = options.retryDelayMs ?? 1200;

  async function send(path: string, method: string, request: RequestOptions = {}, attempt = 0): Promise<Response> {
    const url = requestUrl(options.serverUrl, path, request);
    request.signal?.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${await options.getToken()}`);
    if (request.body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (cause) {
      // An unanswered write may have succeeded; repeating it can duplicate data.
      if (request.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError') || attempt >= 1 || !['GET', 'HEAD', 'OPTIONS'].includes(method)) throw cause;
      await delay(retryDelayMs, request.signal);
      return send(path, method, request, attempt + 1);
    }
    if (response.status === 401 && attempt === 0) {
      await options.getToken(true);
      return send(path, method, request, attempt + 1);
    }
    if (response.status === 429 && attempt === 0) {
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : retryDelayMs;
      if (waitMs <= 10_000) {
        await delay(waitMs, request.signal);
        return send(path, method, request, attempt + 1);
      }
    }
    return response;
  }

  async function request<T>(path: string, method: string, requestOptions?: RequestOptions): Promise<T> {
    const response = await send(path, method, requestOptions);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) throw new WallboardApiError(response.status, requestUrl(options.serverUrl, path, requestOptions ?? {}), body, errorMessage(body, response));
    return body as T;
  }

  const api: WallboardApi = {
    get: (path, opts) => request(path, 'GET', opts),
    post: (path, opts) => request(path, 'POST', opts),
    put: (path, opts) => request(path, 'PUT', opts),
    patch: (path, opts) => request(path, 'PATCH', opts),
    delete: (path, opts) => request(path, 'DELETE', opts),
    raw: (path, method = 'GET', opts) => send(path, method.toUpperCase(), opts),
    forCustomer(customerId) {
      validateCustomerId(customerId);
      const scope = (opts: ScopedRequestOptions = {}): RequestOptions => {
        const unsafe = opts as RequestOptions;
        if (unsafe.instance || (unsafe.customerId !== undefined && unsafe.customerId !== customerId)) throw new TypeError('A customer-scoped client cannot change its customer.');
        return { ...opts, customerId };
      };
      return {
        get: (path, opts) => api.get(path, scope(opts)),
        post: (path, opts) => api.post(path, scope(opts)),
        put: (path, opts) => api.put(path, scope(opts)),
        patch: (path, opts) => api.patch(path, scope(opts)),
        delete: (path, opts) => api.delete(path, scope(opts)),
        raw: (path, method, opts) => api.raw(path, method, scope(opts)),
      };
    },
  };
  return api;
}
