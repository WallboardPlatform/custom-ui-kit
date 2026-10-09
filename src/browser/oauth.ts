export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string | null;
  refresh_total_validity_seconds?: number | null;
  customerId?: number | null;
  readOnly?: boolean;
}

export class OAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** A server URL is an origin, never a path or a URL carrying credentials. */
export function normalizeServerUrl(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Use a Wallboard HTTPS server origin, or HTTP localhost for development.');
  }
  return url.origin;
}

export interface OAuthEndpoints {
  authorize: string;
  token: string;
  registration?: string;
}

function sameServerEndpoint(value: unknown, serverUrl: string, fallback?: string): string {
  if (value === undefined && fallback) return `${serverUrl}${fallback}`;
  if (typeof value !== 'string') throw new OAuthError(0, 'The server did not advertise compatible OAuth endpoints.');
  const url = new URL(value);
  if (url.origin !== serverUrl || url.username || url.password || url.hash || url.search) {
    throw new OAuthError(0, 'OAuth discovery points outside the configured Wallboard server.');
  }
  return url.toString();
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch { /* The response may be an HTML error page. */ }
  if (!response.ok) {
    const description = data.error_description ?? data.message ?? data.error;
    throw new OAuthError(response.status, typeof description === 'string' ? description : `OAuth request failed (${response.status}).`);
  }
  return data;
}

export async function discoverClient(
  serverUrl: string,
  redirectUri: string,
  fetcher: typeof fetch,
  clientName = 'Wallboard Custom UI',
): Promise<{ clientId: string; endpoints: OAuthEndpoints }> {
  const response = await fetcher(`${serverUrl}/.well-known/oauth-authorization-server`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
    credentials: 'omit',
    redirect: 'error',
  });
  const metadata = await jsonResponse(response);
  if (typeof metadata.issuer === 'string' && normalizeServerUrl(metadata.issuer) !== serverUrl) {
    throw new OAuthError(0, 'OAuth discovery returned a different issuer.');
  }
  const endpoints: OAuthEndpoints = {
    authorize: sameServerEndpoint(metadata.authorization_endpoint, serverUrl, '/oauth/authorize'),
    token: sameServerEndpoint(metadata.token_endpoint, serverUrl, '/oauth/token'),
    registration: sameServerEndpoint(metadata.registration_endpoint, serverUrl),
  };
  const registration = await fetcher(endpoints.registration!, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'FULL_ACCESS',
    }),
    signal: AbortSignal.timeout(8000),
    credentials: 'omit',
    redirect: 'error',
  });
  const client = await jsonResponse(registration);
  if (typeof client.client_id !== 'string' || !client.client_id) throw new OAuthError(0, 'Dynamic registration returned no client id.');
  return { clientId: client.client_id, endpoints };
}

export async function requestTokens(
  endpoint: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters).toString(),
      signal: AbortSignal.timeout(15_000),
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new OAuthError(0, 'The Wallboard OAuth server could not be reached.');
  }
  const payload = await jsonResponse(response);
  if (typeof payload.access_token !== 'string' || !payload.access_token || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new OAuthError(response.status, 'Wallboard returned an invalid token response.');
  }
  if (payload.refresh_token !== undefined && payload.refresh_token !== null && typeof payload.refresh_token !== 'string') throw new OAuthError(response.status, 'Wallboard returned an invalid refresh token.');
  if (payload.customerId !== undefined && payload.customerId !== null && (typeof payload.customerId !== 'number' || !Number.isSafeInteger(payload.customerId) || payload.customerId <= 0)) throw new OAuthError(response.status, 'Wallboard returned an invalid customer selector.');
  if (payload.refresh_total_validity_seconds !== undefined && payload.refresh_total_validity_seconds !== null && (typeof payload.refresh_total_validity_seconds !== 'number' || !Number.isFinite(payload.refresh_total_validity_seconds) || payload.refresh_total_validity_seconds < 0)) throw new OAuthError(response.status, 'Wallboard returned an invalid token lifetime.');
  return payload as unknown as TokenResponse;
}
