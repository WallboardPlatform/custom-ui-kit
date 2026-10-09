import { describe, expect, it, vi } from 'vitest';
import { createWallboardApi, CustomerScopeRequiredError, WallboardApiError } from '../../src/api/client.js';
import { readCompleteList } from '../../src/api/pagination.js';
import { readDatasourceData, replaceDatasourceData } from '../../src/api/datasource.js';
import { and, contains, equals, or } from '../../src/api/wbql.js';
import { resolveMediaUrl } from '../../src/api/media.js';

const serverUrl = 'https://wallboard.example';
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers });
const setup = (fetcher = vi.fn<typeof fetch>(async () => json({ ok: true }))) => {
  const getToken = vi.fn<(forceRefresh?: boolean) => Promise<string>>(async () => 'synthetic-access');
  return { fetcher, getToken, api: createWallboardApi({ serverUrl, fetch: fetcher, getToken, retryDelayMs: 0 }) };
};

describe('tenant selectors and token transport', () => {
  it('blocks unscoped requests before authentication or network work', async () => {
    const { api, fetcher, getToken } = setup();
    await expect(api.get('/api/v2/device')).rejects.toBeInstanceOf(CustomerScopeRequiredError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('keeps customer scope explicit and encodes structured queries once', async () => {
    const { api, fetcher } = setup();
    await api.forCustomer(42).get('/api/v2/device', { query: { search: 'name:A+B', sort: ['name,asc', 'id,desc'], empty: '' } });
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.searchParams.get('customerId')).toBe('42');
    expect(url.searchParams.get('search')).toBe('name:A+B');
    expect(url.searchParams.getAll('sort')).toEqual(['name,asc', 'id,desc']);
    expect(url.searchParams.has('empty')).toBe(false);
    const init = fetcher.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-access');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
  });

  it('allows a deliberate instance operation and the current-user singleton', async () => {
    const { api } = setup();
    await expect(api.get('/api/customer/simple', { instance: true })).resolves.toEqual({ ok: true });
    await expect(api.get('/api/v2/user/me')).resolves.toEqual({ ok: true });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid customer selector %s', async (customerId) => {
    const { api, fetcher } = setup();
    await expect(api.get('/api/v2/device', { customerId })).rejects.toThrow('positive');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects conflicting customer parameters and token exfiltration URLs', async () => {
    const { api, fetcher } = setup();
    await expect(api.forCustomer(42).get('/api/v2/device', { query: { customerId: 99 } })).rejects.toThrow('Conflicting');
    for (const path of ['https://other.example/api/device', '//other.example/api/device', '/api/../oauth/token', '/api/v2/device?customerId=-1']) {
      await expect(api.get(path, { instance: true })).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bounded retries', () => {
  it('retries a network-failed read once', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json({ ok: true }));
    const { api } = setup(fetcher);
    await expect(api.get('/api/v2/device', { customerId: 42 })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not replay a write whose network result is unknown', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));
    const { api } = setup(fetcher);
    await expect(api.post('/api/content', { customerId: 42, body: { name: 'Synthetic' } })).rejects.toThrow('offline');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on 401 and stops on another 401', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ message: 'Unauthorized' }, 401));
    const { api, getToken } = setup(fetcher);
    await expect(api.get('/api/v2/device', { customerId: 42 })).rejects.toBeInstanceOf(WallboardApiError);
    expect(getToken.mock.calls.filter(call => call[0] === true)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('can retry an explicitly rate-limited write, but rejects long waits', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 429, { 'Retry-After': '0' })).mockResolvedValueOnce(json({ ok: true }));
    const { api } = setup(fetcher);
    await api.post('/api/content', { customerId: 42, body: {} });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(json({}, 429, { 'Retry-After': '60' }));
    await expect(api.get('/api/v2/device', { customerId: 42 })).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not send an already cancelled request', async () => {
    const { api, fetcher } = setup();
    await expect(api.get('/api/v2/device', { customerId: 42, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('portable API helpers', () => {
  it('escapes WBQL values and groups OR predicates', () => {
    expect(contains('name', 'A+B,(!)')).toBe('name:A%2BB%2C%28%21%29');
    expect(and(equals('deviceStatus', 'ONLINE'), or(equals('name', 'One'), equals('name', 'Two')))).toBe('deviceStatus=ONLINE,(name=One|name=Two)');
  });

  it('refuses a changing directory rather than returning an incomplete selection', async () => {
    const page = (number: number, total: number) => ({ content: [{ id: number }], number, totalElements: total, totalPages: 2, last: number === 1 });
    const fetcher = vi.fn().mockResolvedValueOnce(json(page(0, 2))).mockResolvedValueOnce(json(page(1, 3)));
    const { api } = setup(fetcher);
    await expect(readCompleteList(api.forCustomer(42), '/api/v2/device', { size: 1 })).rejects.toThrow('changed');
  });

  it('loads parsed datasource data and makes full replacement explicit', async () => {
    const { api, fetcher } = setup();
    const scoped = api.forCustomer(42);
    await readDatasourceData(scoped, 'synthetic-id');
    expect(new URL(fetcher.mock.calls[0][0] as string).searchParams.get('parseData')).toBe('true');
    await replaceDatasourceData(scoped, 'synthetic-id', { rows: [{ name: 'Synthetic' }] });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ data: { rows: [{ name: 'Synthetic' }] } });
  });

  it('resolves media without embedding bearer tokens or unsafe URL schemes', () => {
    expect(resolveMediaUrl(serverUrl, '/api/storage/synthetic.png')).toBe(`${serverUrl}/api/storage/synthetic.png`);
    expect(resolveMediaUrl(serverUrl, null)).toBeNull();
    expect(() => resolveMediaUrl(serverUrl, 'javascript:alert(1)')).toThrow('HTTP');
  });
});
