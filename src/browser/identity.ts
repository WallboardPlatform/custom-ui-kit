/** Decoded JWT data is only a display hint; it has not been signature-verified here. */
export interface DisplayIdentity {
  email: string;
  name: string;
  role: string | null;
  customerId: number | null;
  readOnly: boolean;
}

/** Identity returned by the authenticated /api/v2/user/me endpoint. */
export interface VerifiedUser {
  email: string;
  name: string;
  role: string;
  customerId: number | null;
  readOnly: boolean;
}

export function decodeDisplayIdentity(token: string): DisplayIdentity | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof claims.sub !== 'string') return null;
    return {
      email: claims.sub,
      name: typeof claims.name === 'string' ? claims.name : claims.sub,
      role: typeof claims.scope === 'string' ? claims.scope : null,
      customerId: typeof claims.customerId === 'number' ? claims.customerId : null,
      readOnly: claims.readOnly === true,
    };
  } catch { return null; }
}

export function parseVerifiedUser(payload: unknown): VerifiedUser {
  if (!payload || typeof payload !== 'object') throw new Error('Wallboard returned an invalid user identity.');
  const user = payload as Record<string, unknown>;
  if (typeof user.email !== 'string' || typeof user.role !== 'string') throw new Error('Wallboard returned an invalid user identity.');
  if (user.customerId !== null && user.customerId !== undefined && (typeof user.customerId !== 'number' || !Number.isSafeInteger(user.customerId) || user.customerId <= 0)) throw new Error('Wallboard returned an invalid customer identity.');
  return {
    email: user.email,
    name: typeof user.name === 'string' ? user.name : user.email,
    role: user.role,
    customerId: typeof user.customerId === 'number' ? user.customerId : null,
    readOnly: user.readOnly === true,
  };
}
