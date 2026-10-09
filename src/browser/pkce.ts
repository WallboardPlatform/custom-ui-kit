function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export const createState = createCodeVerifier;

export async function createCodeChallenge(verifier: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('PKCE requires Web Crypto. Use HTTPS or localhost.');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(hash));
}
