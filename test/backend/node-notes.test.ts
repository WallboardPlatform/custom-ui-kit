import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNotesServer } from '../../examples/node-notes/server.js';
import { NotesStore } from '../../examples/node-notes/store.js';
import { WallboardValidationError, type CustomerScope, type VerifiedIdentity } from '../../src/backend/index.js';

const owner: VerifiedIdentity = {
  serverUrl: 'https://wallboard.example.test', email: 'one@example.test', name: 'One',
  role: 'OWNER', customerId: 10, readOnly: false,
};
const identities: Record<string, VerifiedIdentity> = {
  'user-one': owner,
  'other-user': { ...owner, email: 'two@example.test' },
  'other-customer': { ...owner, email: 'three@example.test', customerId: 20 },
  'read-only': { ...owner, readOnly: true },
  viewer: { ...owner, role: 'VIEWER' },
  admin: { ...owner, role: 'ADMIN', customerId: null },
};

describe('application-owned SQLite records', () => {
  it('isolates server, customer, and user ownership on reads, updates, and deletes', () => {
    const store = new NotesStore();
    const scope: CustomerScope = { serverUrl: owner.serverUrl, customerId: 10, userEmail: owner.email };
    try {
      const note = store.create(scope, "SQL-looking input: '); DROP TABLE notes; --");
      const unauthorizedScopes = [
        { ...scope, serverUrl: 'https://different-wallboard.example.test' },
        { ...scope, customerId: 20 },
        { ...scope, userEmail: 'two@example.test' },
      ];
      for (const unauthorized of unauthorizedScopes) {
        expect(store.list(unauthorized)).toEqual([]);
        expect(store.update(unauthorized, note.id, 'stolen')).toBeNull();
        expect(store.delete(unauthorized, note.id)).toBe(false);
      }
      expect(store.list(scope)).toEqual([note]);
      expect(store.update(scope, note.id, 'Updated')?.text).toBe('Updated');
      expect(store.delete(scope, note.id)).toBe(true);
      expect(store.list(scope)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('notes HTTP backend', () => {
  let server: Server;
  let store: NotesStore;
  let baseUrl: string;
  let allowWrites: boolean;
  const validate = vi.fn(async (accessToken: string): Promise<VerifiedIdentity> => {
    const identity = identities[accessToken];
    if (!identity) throw new WallboardValidationError('invalid_token', 401, 'Invalid access token.');
    return identity;
  });

  async function start(writes = true): Promise<void> {
    allowWrites = writes;
    server = createNotesServer({
      validator: { validate }, store, allowedOrigin: 'http://localhost:5173',
      allowWrites, allowedAdminCustomerIds: [10], maxBodyBytes: 2_048,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const call = (path: string, accessToken = 'user-one', init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  });
  const write = (text: string, accessToken = 'user-one', path = '/api/notes', method = 'POST') => call(path, accessToken, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });

  beforeEach(async () => {
    validate.mockClear();
    store = new NotesStore();
    await start();
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  it('authenticates before every database access and serves the actual CRUD path', async () => {
    const created = await write('My note');
    expect(created.status).toBe(201);
    const note = await created.json();
    expect(await (await call('/api/notes')).json()).toEqual({ notes: [note] });
    const updated = await write('Changed', 'user-one', `/api/notes/${note.id}`, 'PATCH');
    expect(updated.status).toBe(200);
    expect((await updated.json()).text).toBe('Changed');
    expect((await call(`/api/notes/${note.id}`, 'user-one', { method: 'DELETE' })).status).toBe(204);
    expect(await (await call('/api/notes')).json()).toEqual({ notes: [] });
    expect(validate).toHaveBeenCalledTimes(5);
  });

  it.each(['other-user', 'other-customer'])('does not reveal or mutate owned records to %s', async (accessToken) => {
    const note = await (await write('Private note')).json();
    expect(await (await call('/api/notes', accessToken)).json()).toEqual({ notes: [] });
    expect((await write('Changed', accessToken, `/api/notes/${note.id}`, 'PATCH')).status).toBe(404);
    expect((await call(`/api/notes/${note.id}`, accessToken, { method: 'DELETE' })).status).toBe(404);
    expect((await (await call('/api/notes')).json()).notes[0].text).toBe('Private note');
  });

  it('rejects missing or rejected credentials before database effects', async () => {
    expect((await fetch(`${baseUrl}/api/notes`)).status).toBe(401);
    expect(validate).not.toHaveBeenCalled();
    expect((await write('Unaccepted', 'unknown')).status).toBe(401);
    expect(await (await call('/api/notes')).json()).toEqual({ notes: [] });
  });

  it('rejects duplicate Authorization headers instead of relying on Node header coalescing', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/api/notes`, {
        headers: { Authorization: ['Bearer user-one', 'Bearer admin'] },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(401);
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(['read-only', 'viewer'])('denies writes for %s even when the application enables them', async (accessToken) => {
    expect((await write('Denied', accessToken)).status).toBe(403);
    expect((await call('/api/notes', accessToken)).status).toBe(200);
    expect((await (await call('/api/session', accessToken)).json()).writesEnabled).toBe(false);
  });

  it('requires the application operator to enable writes explicitly', async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(false);
    const response = await write('Denied');
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('writes_disabled');
  });

  it('rejects client-supplied cross-customer choices and unauthorized ADMIN customers', async () => {
    expect((await call('/api/notes', 'user-one', { headers: { 'X-Customer-Id': '20' } })).status).toBe(403);
    expect((await call('/api/notes', 'admin')).status).toBe(403);
    expect((await call('/api/notes', 'admin', { headers: { 'X-Customer-Id': '20' } })).status).toBe(403);
    expect((await call('/api/notes', 'admin', { headers: { 'X-Customer-Id': '10' } })).status).toBe(200);
    expect((await call('/api/notes', 'user-one', { headers: { 'X-Customer-Id': 'oops' } })).status).toBe(400);
  });

  it('uses an exact CORS allowlist and an endpoint-specific method allowlist', async () => {
    const denied = await call('/api/notes', 'user-one', { headers: { Origin: 'https://attacker.example.test' } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(validate).not.toHaveBeenCalled();
    const allowed = await call('/api/notes', 'user-one', { headers: { Origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const preflight = await fetch(`${baseUrl}/api/notes`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect((await call('/api/notes', 'user-one', { method: 'PUT' })).status).toBe(405);
  });

  it('rejects oversized, invalid, and authority-bearing bodies', async () => {
    expect((await write('x'.repeat(3_000))).status).toBe(413);
    expect((await write('')).status).toBe(400);
    const malformed = await call('/api/notes', 'user-one', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    expect(malformed.status).toBe(400);
    const identityInjection = await call('/api/notes', 'user-one', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'note', customerId: 20 }),
    });
    expect(identityInjection.status).toBe(400);
    expect(await (await call('/api/notes')).json()).toEqual({ notes: [] });
  });
});
