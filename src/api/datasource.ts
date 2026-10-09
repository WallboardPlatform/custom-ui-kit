import type { RequestOptions, WallboardApi, CustomerApi } from './client.js';

export interface DatasourceData<T> {
  name?: string;
  data?: T;
  configMetadata?: unknown;
}

type DataApi = Pick<WallboardApi, 'get' | 'put'> | Pick<CustomerApi, 'get' | 'put'>;

function datasourcePath(id: string): string {
  if (!id || id === '.' || id === '..') throw new TypeError('A datasource id is required.');
  return `/api/datasource/${encodeURIComponent(id)}/data`;
}

/** parseData=true returns parsed JSON instead of a JSON string. */
export function readDatasourceData<T = unknown>(api: DataApi, id: string, options: RequestOptions = {}): Promise<DatasourceData<T>> {
  return api.get(datasourcePath(id), { ...options, query: { ...options.query, parseData: true } });
}

/** Replaces the entire internal datasource document. This is not a field merge. */
export function replaceDatasourceData<T>(api: DataApi, id: string, data: T, options: RequestOptions = {}): Promise<void> {
  return api.put(datasourcePath(id), { ...options, body: { data } });
}
