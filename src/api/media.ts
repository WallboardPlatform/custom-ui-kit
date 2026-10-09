/** Resolve a media path against Wallboard without placing access tokens in the URL. */
export function resolveMediaUrl(serverUrl: string, path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('data:image/')) return path;
  const url = new URL(path, `${serverUrl.replace(/\/+$/, '')}/`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Use an HTTP(S) media URL or an image data URL.');
  return url.toString();
}
