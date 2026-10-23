import type { Config } from './config.js';
import { D2LError } from './errors.js';

export class Boundary {
  readonly routes: Array<{ origin: string; prefixes: string[] }>;
  constructor(readonly config: Config) {
    this.routes = [{ origin: config.origin, prefixes: ['/d2l/api/'] }, ...config.apiRoutes.map(route => {
      const url = new URL(route.origin);
      if (url.protocol !== 'https:' || url.origin !== route.origin || url.username || url.password) this.fail();
      route.prefixes.forEach(p => this.path(p));
      return { origin: url.origin, prefixes: route.prefixes };
    })];
  }
  private fail(): never { throw new D2LError('BOUNDARY_VIOLATION', 'Request is outside the configured tenant API boundary.'); }
  path(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\?#\x00-\x20\x7f]/.test(path)) this.fail();
    // Reject traversal, encoded separators, double encoding and parser ambiguities before URL normalization.
    if (/%(?![0-9a-f]{2})/i.test(path) || /%(?:2f|5c|25|00|0[ad]|3f|23)/i.test(path)) this.fail();
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { this.fail(); }
    if (decoded!.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x20\x7f]/.test(decoded!) || path.includes('//')) this.fail();
    if (new URL(path, this.config.origin).pathname !== path) this.fail();
    return path;
  }
  url(path: string, origin = this.config.origin): URL {
    this.path(path);
    if (!this.routes.some(route => route.origin === origin && route.prefixes.some(p => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`)))) this.fail();
    return new URL(path, origin);
  }
  nextUrl(value: string, current: URL): URL {
    const rawPath = value.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0]!;
    // Check the original spelling before WHATWG URL resolves dot segments or backslashes.
    if (rawPath) this.path(rawPath.startsWith('/') ? rawPath : `/${rawPath}`);
    const next = new URL(value, current);
    // Do not forward credentials to a different API origin on a redirect or pagination link.
    if (next.origin !== current.origin || next.username || next.password || next.hash) this.fail();
    this.url(next.pathname, next.origin);
    for (const key of next.searchParams.keys()) this.queryKey(key);
    return next;
  }
  headers(input: Record<string, string> = {}): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!['accept', 'content-type', 'if-match', 'if-none-match', 'if-unmodified-since', 'if-modified-since', 'prefer'].includes(key.toLowerCase()) || /[\r\n\x00]/.test(value)) {
        throw new D2LError('BOUNDARY_VIOLATION', 'Only content negotiation and conditional headers may be supplied by callers.');
      }
      result[key.toLowerCase()] = value;
    }
    return result;
  }
  queryKey(key: string) {
    if (/^(?:x_[a-z]|authorization|cookie|access_token|refresh_token)$/i.test(key) || /csrf|xsrf/i.test(key)) throw new D2LError('BOUNDARY_VIOLATION', 'Authentication parameters are managed by the server.');
  }
}
