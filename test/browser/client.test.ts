import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWallboardClient, OAuthStateError } from '../../src/browser/client.js';
import { OAuthError } from '../../src/browser/oauth.js';
import { createCodeChallenge, createCodeVerifier } from '../../src/browser/pkce.js';
import { StorageUnavailableError, type StorageLike } from '../../src/browser/storage.js';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const serverUrl = 'https://wallboard.example';
const appOrigin = 'https://custom.example';
const clientId = 'synthetic-public-client';
const jwt = (role = 'ADMIN') => `header.${btoa(JSON.stringify({ sub: 'person@example.test', name: 'Hint', scope: role, customerId: 999 }))}.signature`;
const tokens = (token = jwt()) => ({ access_token: token, expires_in: 1800, refresh_token: 'synthetic-refresh', refresh_total_validity_seconds: 3600, customerId: 42, readOnly: false });
const user = { email: 'person@example.test', name: 'Verified Person', role: 'OWNER', customerId: 42, readOnly: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let current: URL;
let navigate: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  current = new URL(`${appOrigin}/screen?filter=online`);
  navigate = vi.fn();
  replace = vi.fn((_state, _title, url: string) => { current = new URL(url, appOrigin); });
  vi.stubGlobal('location', {
    get href() { return current.href; }, get origin() { return current.origin; },
    get pathname() { return current.pathname; }, get search() { return current.search; },
    get hash() { return current.hash; }, assign: navigate,
  });
  vi.stubGlobal('history', { replaceState: replace });
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('top', globalThis);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function pending(storage: MemoryStorage): { key: string; value: Record<string, unknown> } {
  const entry = [...storage.values].find(([key]) => key.endsWith(':transaction'))!;
  return { key: entry[0], value: JSON.parse(entry[1]) };
}

async function signedIn(storage = new MemoryStorage(), fetcher = vi.fn<typeof fetch>(async () => json(user))) {
  const first = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
  await first.signIn();
  const tx = pending(storage);
  current = new URL(`${appOrigin}/?code=synthetic-code&state=${tx.value.state}&keep=yes`);
  fetcher.mockImplementationOnce(async () => json(tokens()));
  const client = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
  await client.initialize();
  return { client, storage, fetcher, tx };
}

describe('browser PKCE and callback boundary', () => {
  it('matches the RFC S256 vector and generates a high-entropy verifier', async () => {
    expect(await createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(createCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });

  it('scrubs the callback before exchange, consumes state, and exposes verified identity separately', async () => {
    const storage = new MemoryStorage();
    const fetcher = vi.fn<typeof fetch>(async () => json(user));
    const first = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
    await first.signIn();
    const tx = pending(storage);
    current = new URL(`${appOrigin}/?code=synthetic-code&state=${tx.value.state}&keep=yes`);
    fetcher.mockImplementationOnce(async (_input, init) => {
      expect(current.search).toBe('?keep=yes');
      expect(storage.getItem(tx.key)).toBeNull();
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('code_verifier')).toBe(tx.value.verifier);
      expect(form.get('redirect_uri')).toBe(appOrigin);
      return json(tokens());
    });
    const client = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
    const state = await client.initialize();
    expect(state.user?.role).toBe('OWNER');
    expect(state.displayIdentity?.role).toBe('ADMIN');
    expect(state.status).toBe('authenticated');
    expect(state.customerId).toBe(42);
    expect(state).not.toHaveProperty('accessToken');
    expect(current.pathname + current.search).toBe('/screen?filter=online');
    current = new URL(`${appOrigin}/?code=replay&state=${tx.value.state}`);
    await expect(client.initialize()).rejects.toBeInstanceOf(OAuthStateError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['mismatch', 'expired', 'missingTimestamp', 'wrongPath', 'missingState'])('rejects %s before token redemption', async (reason) => {
    const storage = new MemoryStorage();
    const fetcher = vi.fn();
    const client = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
    await client.signIn();
    const tx = pending(storage);
    if (reason === 'expired') tx.value.createdAt = Date.now() - 600_001;
    if (reason === 'missingTimestamp') delete tx.value.createdAt;
    storage.setItem(tx.key, JSON.stringify(tx.value));
    current = new URL(`${appOrigin}${reason === 'wrongPath' ? '/other' : '/'}?code=synthetic-code${reason === 'missingState' ? '' : `&state=${reason === 'mismatch' ? 'wrong' : tx.value.state}`}`);
    await expect(client.initialize()).rejects.toBeInstanceOf(OAuthStateError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(current.search).toBe('');
    expect(storage.getItem(tx.key)).toBeNull();
  });

  it('fails closed when transaction storage silently discards writes', async () => {
    const storage: StorageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const client = createWallboardClient({ serverUrl, clientId, storage });
    await expect(client.signIn()).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate from an embedded context', async () => {
    vi.stubGlobal('top', {});
    await expect(createWallboardClient({ serverUrl, clientId, storage: new MemoryStorage() }).signIn()).rejects.toThrow('top-level');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('registers the exact current origin only when a client is not provided', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({
      issuer: serverUrl, authorization_endpoint: `${serverUrl}/oauth/authorize`, token_endpoint: `${serverUrl}/oauth/token`, registration_endpoint: `${serverUrl}/oauth/register`,
    })).mockResolvedValueOnce(json({ client_id: clientId }, 201));
    const storage = new MemoryStorage();
    const client = createWallboardClient({ serverUrl, storage, fetch: fetcher });
    await client.signIn();
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body)).redirect_uris).toEqual([appOrigin]);
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get('code_challenge_method')).toBe('S256');
    await client.signIn();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects discovery endpoints pointing to a different server', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ issuer: serverUrl, registration_endpoint: 'https://other.example/register' }));
    await expect(createWallboardClient({ serverUrl, storage: new MemoryStorage(), fetch: fetcher }).signIn()).rejects.toThrow('outside');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('rotating refresh tokens', () => {
  it('shares one in-flight refresh across concurrent callers', async () => {
    const { client, fetcher } = await signedIn();
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const a = client.getToken(true);
    const b = client.getToken(true);
    const c = client.getToken(true);
    complete(json(tokens('rotated-access')));
    expect(await Promise.all([a, b, c])).toEqual(['rotated-access', 'rotated-access', 'rotated-access']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('shares refresh across separate client instances in the same tab', async () => {
    const { client, fetcher, storage } = await signedIn();
    const other = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
    await other.initialize();
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const a = client.getToken(true);
    const b = other.getToken(true);
    complete(json(tokens('shared-rotated-access')));
    expect(await Promise.all([a, b])).toEqual(['shared-rotated-access', 'shared-rotated-access']);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retains the refresh token on a temporary failure, then recovers', async () => {
    const { client, fetcher, storage } = await signedIn();
    fetcher.mockResolvedValueOnce(json({ message: 'Temporarily unavailable' }, 503));
    await expect(client.getToken(true)).rejects.toBeInstanceOf(OAuthError);
    expect(client.getState().status).toBe('authenticated');
    expect([...storage.values.keys()].some(key => key.includes(':session:'))).toBe(true);
    fetcher.mockResolvedValueOnce(json(tokens('recovered-access')));
    expect(await client.getToken(true)).toBe('recovered-access');
  });

  it('clears a rejected refresh token rather than endlessly retrying it', async () => {
    const { client, fetcher, storage } = await signedIn();
    fetcher.mockResolvedValueOnce(json({ message: 'Invalid refresh token' }, 403));
    await expect(client.getToken(true)).rejects.toBeInstanceOf(OAuthError);
    expect(client.getState().user).toBeNull();
    expect([...storage.values.keys()].some(key => key.includes(':session:'))).toBe(false);
    await expect(client.getToken()).rejects.toThrow('Sign in');
  });

  it('does not resurrect a session after sign-out during refresh', async () => {
    const { client, fetcher, storage } = await signedIn();
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const refreshing = client.getToken(true);
    client.signOut();
    complete(json(tokens('late-access')));
    await expect(refreshing).rejects.toThrow('cancelled');
    expect(client.getState().status).toBe('anonymous');
    expect([...storage.values.keys()].some(key => key.includes(':session:'))).toBe(false);
  });

  it('restores a tab session and verifies identity again after reload', async () => {
    const { storage, fetcher } = await signedIn();
    const client = createWallboardClient({ serverUrl, clientId, storage, fetch: fetcher });
    expect((await client.initialize()).user?.email).toBe(user.email);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
