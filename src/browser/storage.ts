export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('Tab storage is unavailable. Allow session storage before signing in; PKCE state must survive the redirect.');
    this.name = 'StorageUnavailableError';
  }
}

export function readStored<T>(storage: StorageLike, key: string): T | null {
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { throw new StorageUnavailableError(); }
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function writeStored(storage: StorageLike, key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new StorageUnavailableError();
  } catch { throw new StorageUnavailableError(); }
}

export function removeStored(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new StorageUnavailableError();
  } catch { throw new StorageUnavailableError(); }
}
