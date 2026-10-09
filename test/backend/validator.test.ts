import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertWritableIdentity,
  createWallboardValidator,
  parseBearerToken,
  resolveCustomerScope,
  type VerifiedIdentity,
} from '../../src/backend/index.js';

const user = { email: 'owner@example.test', name: 'Example User', role: 'OWNER', customerId: 42, readOnly: false };
const token = (claims: Record<string, unknown> = {}) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

function mockValidator(body: unknown = user, status = 200) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
  return { validator: createWallboardValidator({ serverUrl: 'https://wallboard.example.test', fetch: fetchMock }), fetchMock };
}

describe('online Wallboard identity validation', () => {
  it('sends the token only to the configured /me endpoint, without redirects or caching', async () => {
    const { validator, fetchMock } = mockValidator({ ...user, userMetadata: { privateData: 'excluded' } });
    const accessToken = token({ sub: 'untrusted@example.test', scope: 'ADMIN', customerId: 999, readOnly: false });
    expect(await validator.validate(accessToken)).toEqual({ serverUrl: validator.serverUrl, ...user });
    expect(fetchMock).toHaveBeenCalledWith('https://wallboard.example.test/api/v2/user/me', expect.objectContaining({
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    }));
    await validator.validate(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses native fetch against /me and never forwards the token across an upstream redirect', async () => {
    let redirectedRequests = 0;
    const target = createServer((_request, response) => {
      redirectedRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(user));
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    let redirect = false;
    let authorization: string | undefined;
    let path: string | undefined;
    const upstream = createServer((request, response) => {
      authorization = request.headers.authorization;
      path = request.url;
      if (redirect) {
        response.writeHead(302, { Location: targetUrl });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(user));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const serverUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const validator = createWallboardValidator({ serverUrl });
      expect((await validator.validate(token())).email).toBe(user.email);
      expect(path).toBe('/api/v2/user/me');
      expect(authorization).toBe(`Bearer ${token()}`);
      redirect = true;
      await expect(validator.validate(token())).rejects.toMatchObject({ statusCode: 503 });
      expect(redirectedRequests).toBe(0);
    } finally {
      upstream.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => upstream.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  });

  it.each([401, 403])('fails closed on upstream status %s without exposing its response', async (status) => {
    const { validator } = mockValidator({ token: 'must-never-be-returned' }, status);
    await expect(validator.validate(token())).rejects.toMatchObject({ statusCode: status, upstreamStatus: status });
    await expect(validator.validate(token())).rejects.not.toHaveProperty('token');
  });

  it.each([302, 404, 429, 500])('treats upstream %s as unavailable, not authenticated', async (status) => {
    const { validator } = mockValidator({}, status);
    await expect(validator.validate(token())).rejects.toMatchObject({ code: 'upstream_unavailable', statusCode: 503 });
  });

  it('does not expose transport errors or silently authenticate while Wallboard is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret token echoed by transport'));
    const validator = createWallboardValidator({ serverUrl: 'https://wallboard.example.test', fetch: fetchMock });
    await expect(validator.validate(token())).rejects.toMatchObject({
      code: 'upstream_unavailable', message: 'Wallboard identity validation is unavailable.',
    });
  });

  it('bounds validation with a timeout', async () => {
    const fetchMock: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const validator = createWallboardValidator({ serverUrl: 'https://wallboard.example.test', fetch: fetchMock, timeoutMs: 10 });
    await expect(validator.validate(token())).rejects.toMatchObject({ statusCode: 503 });
  });

  it('fails closed on redirected responses even when an injected fetch ignores redirect policy', async () => {
    const response = Response.json(user);
    Object.defineProperty(response, 'redirected', { value: true });
    const validator = createWallboardValidator({ serverUrl: 'https://wallboard.example.test', fetch: async () => response });
    await expect(validator.validate(token())).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each([
    {}, { ...user, role: 'UNKNOWN' }, { ...user, customerId: null }, { ...user, customerId: 0 },
    { ...user, customerId: '42' }, { ...user, readOnly: undefined }, { ...user, email: '' },
  ])('rejects malformed security-relevant identity fields: %j', async (body) => {
    const { validator } = mockValidator(body);
    await expect(validator.validate(token())).rejects.toMatchObject({ code: 'invalid_response', statusCode: 502 });
  });

  it('keeps a null display name and permits a global ADMIN identity without a customer', async () => {
    const { validator } = mockValidator({ ...user, name: null, role: 'ADMIN', customerId: null });
    expect(await validator.validate(token())).toMatchObject({ name: null, role: 'ADMIN', customerId: null });
  });

  it.each([
    [false, false, false], [false, true, true], [true, false, true], [true, true, true],
  ])('combines account=%s and token=%s read-only restrictions', async (accountReadOnly, tokenReadOnly, expected) => {
    const { validator } = mockValidator({ ...user, readOnly: accountReadOnly });
    expect((await validator.validate(token({ readOnly: tokenReadOnly }))).readOnly).toBe(expected);
  });

  it('rejects invalid restrictive claims after /me succeeds', async () => {
    const { validator } = mockValidator();
    await expect(validator.validate(token({ readOnly: 'false' }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each(['', 'Bearer abc', 'a b', 'abc\r\nInjected: x'])('does not send an invalid token to upstream: %j', async (value) => {
    const { validator, fetchMock } = mockValidator();
    await expect(validator.validate(value)).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://remote.example.test', 'https://user:password@wallboard.example.test',
    'https://wallboard.example.test/path', 'https://wallboard.example.test?server=other',
    'https://wallboard.example.test#fragment',
  ])('rejects unsafe configured origins: %s', (serverUrl) => {
    expect(() => createWallboardValidator({ serverUrl })).toThrow();
  });

  it('permits loopback HTTP only for development', () => {
    expect(createWallboardValidator({ serverUrl: 'http://127.0.0.1:3000/' }).serverUrl).toBe('http://127.0.0.1:3000');
  });
});

describe('application authorization helpers', () => {
  const identity: VerifiedIdentity = { serverUrl: 'https://wallboard.example.test', ...user, role: 'OWNER' };

  it('parses one bearer header and rejects duplicates, empty tokens, and alternate schemes', () => {
    expect(parseBearerToken('bearer abc.def')).toBe('abc.def');
    for (const header of [undefined, 'Bearer ', 'Basic abc', 'Bearer abc, Bearer def', 'Bearer abc def']) {
      expect(() => parseBearerToken(header)).toThrow();
    }
  });

  it('uses the authoritative own customer and prevents cross-customer selection', () => {
    expect(resolveCustomerScope(identity)).toEqual({ serverUrl: identity.serverUrl, customerId: 42, userEmail: identity.email });
    expect(() => resolveCustomerScope(identity, { customerId: 43 })).toThrow();
  });

  it('requires application-owned customer authorization for ADMIN, even with a customer in /me', () => {
    const admin = { ...identity, role: 'ADMIN' as const };
    expect(() => resolveCustomerScope(admin)).toThrow();
    expect(() => resolveCustomerScope(admin, { customerId: 43, allowedAdminCustomerIds: [42] })).toThrow();
    expect(resolveCustomerScope(admin, { customerId: 43, allowedAdminCustomerIds: [43] }).customerId).toBe(43);
  });

  it.each([undefined, 0, -1, 42.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'requires an explicit positive customer choice for ADMIN: %s', (customerId) => {
      const admin = { ...identity, role: 'ADMIN' as const };
      expect(() => resolveCustomerScope(admin, { customerId, allowedAdminCustomerIds: [42] }))
        .toThrow(expect.objectContaining({ code: 'forbidden', statusCode: 403 }));
    },
  );

  it('does not inherit an ADMIN customer even when that customer is allowlisted', () => {
    const admin = { ...identity, role: 'ADMIN' as const };
    expect(() => resolveCustomerScope(admin, { allowedAdminCustomerIds: [42] }))
      .toThrow(expect.objectContaining({ code: 'forbidden', statusCode: 403 }));
    expect(resolveCustomerScope(admin, { customerId: 42, allowedAdminCustomerIds: [42] }).customerId).toBe(42);
  });

  it('denies read-only identities and viewing/device roles', () => {
    expect(() => assertWritableIdentity(identity)).not.toThrow();
    expect(() => assertWritableIdentity({ ...identity, readOnly: true })).toThrow();
    expect(() => assertWritableIdentity({ ...identity, role: 'VIEWER' })).toThrow();
    expect(() => assertWritableIdentity({ ...identity, role: 'DEVICE_USER' })).toThrow();
  });
});
