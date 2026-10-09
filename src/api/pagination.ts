import type { RequestOptions, WallboardApi, CustomerApi } from './client.js';

export interface WbPage<T> {
  content: T[];
  empty: boolean;
  first: boolean;
  last: boolean;
  number: number;
  numberOfElements: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

type ListApi = Pick<WallboardApi, 'get'> | Pick<CustomerApi, 'get'>;

export interface PageOptions extends RequestOptions {
  page?: number;
  size?: number;
  sort?: string;
  select?: string;
  search?: string;
}

export async function readPage<T>(api: ListApi, path: string, options: PageOptions = {}): Promise<WbPage<T>> {
  const page = options.page ?? 0;
  const size = options.size ?? 50;
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 1000) throw new TypeError('Use a non-negative page and a size between 1 and 1000.');
  const { sort, select, search, ...request } = options;
  const result = await api.get<WbPage<T>>(path, {
    ...request,
    query: { ...options.query, page, size, sort, select, search: search || undefined },
  });
  if (!result || !Array.isArray(result.content) || result.number !== page || !Number.isSafeInteger(result.totalPages) || result.totalPages < 0 || !Number.isSafeInteger(result.totalElements) || result.totalElements < 0) throw new Error('Wallboard returned an invalid or unexpected page.');
  return result;
}

/** Each page is loaded lazily; pass AbortSignal to stop a large traversal. */
export async function* iteratePages<T>(
  api: ListApi,
  path: string,
  options: Omit<PageOptions, 'page'> & { maxPages?: number } = {},
): AsyncGenerator<WbPage<T>> {
  const maxPages = options.maxPages ?? 1000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be a positive integer.');
  let total: number | null = null;
  let seen = 0;
  for (let page = 0; page < maxPages; page++) {
    options.signal?.throwIfAborted();
    const result = await readPage<T>(api, path, { ...options, page });
    options.signal?.throwIfAborted();
    if (total !== null && result.totalElements !== total) throw new Error('The list changed while loading. Retry it.');
    total = result.totalElements;
    seen += result.content.length;
    const last = result.last || page + 1 >= result.totalPages;
    if ((!last && !result.content.length) || (last && seen !== total)) throw new Error('A list page is missing or the list changed while loading. Retry it.');
    yield result;
    if (last) return;
  }
  throw new Error('The list exceeded maxPages. Increase the limit explicitly or use individual pages.');
}

export async function readCompleteList<T>(api: ListApi, path: string, options: Omit<PageOptions, 'page'> & { maxPages?: number } = {}): Promise<T[]> {
  const content: T[] = [];
  for await (const page of iteratePages<T>(api, path, options)) content.push(...page.content);
  return content;
}

export async function countMatching(api: ListApi, path: string, options: PageOptions = {}): Promise<number> {
  return (await readPage(api, path, { ...options, page: 0, size: 1, select: 'id' })).totalElements;
}
