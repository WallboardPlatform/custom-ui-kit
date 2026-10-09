/** Identity returned by Wallboard's authenticated /api/v2/user/me endpoint. */
export const wallboardRoles = [
  'ADMIN', 'OWNER', 'TECHNICIAN', 'APPROVER', 'EDITOR', 'MESSENGER', 'VIEWER', 'DEVICE_USER',
] as const;

export type WallboardRole = typeof wallboardRoles[number];

export interface VerifiedIdentity {
  /** The fixed Wallboard origin configured on this application backend. */
  readonly serverUrl: string;
  /** Wallboard identifies users by email, not by a numeric user ID. */
  readonly email: string;
  readonly name: string | null;
  readonly role: WallboardRole;
  readonly customerId: number | null;
  /** Account read-only state OR a read-only grant on the validated access token. */
  readonly readOnly: boolean;
}

export type ValidationErrorCode =
  | 'invalid_token' | 'forbidden' | 'upstream_unavailable' | 'invalid_response' | 'invalid_configuration';

/** Deliberately contains neither the access token nor an upstream response body. */
export class WallboardValidationError extends Error {
  constructor(
    public readonly code: ValidationErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'WallboardValidationError';
  }
}

export interface WallboardValidatorOptions {
  /** Trusted, fixed origin supplied by application configuration, never by a request. */
  serverUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface WallboardValidator {
  readonly serverUrl: string;
  validate(accessToken: string, options?: { signal?: AbortSignal }): Promise<VerifiedIdentity>;
}

function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WallboardValidationError('invalid_configuration', 500, 'Configure a valid Wallboard server origin.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new WallboardValidationError('invalid_configuration', 500, 'Use an HTTPS Wallboard origin; HTTP is allowed only on loopback for development.');
  }
  return url.origin;
}

function requireAccessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 65_536 ||
      !/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
    throw new WallboardValidationError('invalid_token', 401, 'A valid bearer access token is required.');
  }
  return value;
}

/** Parse exactly one Authorization header. Do not accept a token in URLs or cookies. */
export function parseBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i);
  if (!match) {
    throw new WallboardValidationError('invalid_token', 401, 'A bearer access token is required.');
  }
  return requireAccessToken(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * This is an additional restriction, never an identity/authentication source.
 * Call only after Wallboard accepted this exact access token.
 */
function tokenIsReadOnly(accessToken: string): boolean {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return false;
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(payload) || (payload.readOnly !== undefined && typeof payload.readOnly !== 'boolean')) {
      throw new Error('Invalid readOnly claim');
    }
    return payload.readOnly === true;
  } catch {
    throw new WallboardValidationError('invalid_token', 401, 'The accepted token has an invalid access-grant representation.');
  }
}

function identityFromResponse(value: unknown, serverUrl: string, accessToken: string): VerifiedIdentity {
  if (!isRecord(value) || typeof value.email !== 'string' || !value.email.trim() ||
      !wallboardRoles.includes(value.role as WallboardRole) || typeof value.readOnly !== 'boolean' ||
      (value.name !== null && value.name !== undefined && typeof value.name !== 'string')) {
    throw new WallboardValidationError('invalid_response', 502, 'Wallboard returned an unsupported identity response.');
  }
  const customerId = value.customerId ?? null;
  const validCustomerId = typeof customerId === 'number' && Number.isSafeInteger(customerId) && customerId > 0;
  if ((!validCustomerId && customerId !== null) || (value.role !== 'ADMIN' && !validCustomerId)) {
    throw new WallboardValidationError('invalid_response', 502, 'Wallboard returned an unsupported customer identity.');
  }
  return Object.freeze({
    serverUrl,
    email: value.email,
    name: typeof value.name === 'string' ? value.name : null,
    role: value.role as WallboardRole,
    customerId: customerId as number | null,
    readOnly: value.readOnly || tokenIsReadOnly(accessToken),
  });
}

/**
 * Online validation: each call checks the current user through Wallboard.
 * It does not cache identities, retry requests, or follow redirects with credentials.
 */
export function createWallboardValidator(options: WallboardValidatorOptions): WallboardValidator {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (typeof fetchImplementation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new WallboardValidationError('invalid_configuration', 500, 'Configure fetch and a positive validation timeout.');
  }
  return Object.freeze({
    serverUrl,
    async validate(accessToken: string, requestOptions: { signal?: AbortSignal } = {}): Promise<VerifiedIdentity> {
      const token = requireAccessToken(accessToken);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = requestOptions.signal ? AbortSignal.any([requestOptions.signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await fetchImplementation(`${serverUrl}/api/v2/user/me`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          signal,
        });
      } catch {
        throw new WallboardValidationError('upstream_unavailable', 503, 'Wallboard identity validation is unavailable.');
      }
      if (response.status === 401) {
        throw new WallboardValidationError('invalid_token', 401, 'Wallboard rejected the access token.', 401);
      }
      if (response.status === 403) {
        throw new WallboardValidationError('forbidden', 403, 'Wallboard denied access to the current user.', 403);
      }
      if (response.status !== 200 || response.redirected) {
        throw new WallboardValidationError('upstream_unavailable', 503, 'Wallboard identity validation is unavailable.', response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new WallboardValidationError('invalid_response', 502, 'Wallboard returned an invalid identity response.');
      }
      return identityFromResponse(body, serverUrl, token);
    },
  });
}
