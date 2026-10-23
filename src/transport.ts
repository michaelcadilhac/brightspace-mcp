import type { Config } from './config.js';
import { Boundary } from './boundary.js';
import type { AuthProvider, WireRequest, WireResponse } from './auth.js';
import { D2LError } from './errors.js';
import { parseJson, parseDocument, Redactor, type NumericRepresentation } from './util.js';

export interface HttpResult { status: number; headers: Record<string, string>; data: unknown; raw: Buffer; retrievedAt: string; contentType: string; numericRepresentations: NumericRepresentation[] }
export class ApiTransport {
  constructor(readonly config: Config, readonly boundary: Boundary, readonly auth: AuthProvider,
    readonly redactor: Redactor, readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  async request(url: URL, request: Omit<WireRequest, 'timeoutMs'>, read: boolean, responseType = 'json'): Promise<HttpResult> {
    this.boundary.url(url.pathname, url.origin);
    for (const key of url.searchParams.keys()) this.boundary.queryKey(key);
    let response: WireResponse | undefined;
    let redirects = 0, retries = 0;
    while (true) {
      try { response = await this.auth.send(url, { ...request, timeoutMs: this.config.timeoutMs }); }
      catch (error) {
        if (error instanceof D2LError) throw error;
        throw new D2LError(read ? 'TRANSIENT_FAILURE' : 'UNCERTAIN_OUTCOME',
          read ? 'The API request failed before a usable response arrived.' : 'The write may have reached the service. Do not replay it before reconciliation.',
          { method: request.method, path: url.pathname, verification: 'not-performed' }, read ? 'Retry this read after checking connectivity.' : 'Use get_request_status with a reconciliation read.');
      }
      const { status, headers } = response;
      if (status >= 300 && status < 400 && status !== 304) {
        const location = headers.location;
        if (!read) throw new D2LError('UNCERTAIN_OUTCOME', 'A write returned a redirect; it was not followed.', { status });
        if (!['GET', 'HEAD'].includes(request.method)) throw new D2LError('CONTRACT_UNKNOWN', 'Redirects for unusual read methods require an established redirect contract; none was followed.', { status });
        if (!location || redirects++ >= 3) throw new D2LError('AUTHENTICATION_REQUIRED', 'An API redirect could not be safely resolved.');
        try { url = this.boundary.nextUrl(location, url); }
        catch { throw new D2LError('AUTHENTICATION_REQUIRED', 'The API redirected outside its API boundary, possibly to sign-in. No credentials were forwarded.'); }
        continue;
      }
      if (read && [429, 502, 503, 504].includes(status) && retries < this.config.readRetries) {
        const retryAfter = headers['retry-after'];
        const delay = retryAfter ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 500 * 2 ** retries;
        if (Number.isFinite(delay) && delay >= 0 && delay <= this.config.maxRetryDelayMs) {
          retries++; await this.sleep(delay); continue;
        }
      }
      break;
    }
    const { status, headers, body } = response;
    const contentType = (headers['content-type'] ?? '').split(';')[0]!.toLowerCase();
    const text = body.toString('utf8');
    const html = /(?:text\/html|application\/xhtml)/.test(contentType) || /^\s*<(?:!doctype\s+html|html)\b/i.test(text);
    const login = html && /(?:login|sign[ -]?in|saml|sso|password|authenticat)/i.test(text);
    if (status === 401 || login) throw new D2LError('AUTHENTICATION_REQUIRED', 'The API requires fresh authentication. Login content was discarded.', { status }, 'Stop the server, run d2l-mcp login, and restart the server.');
    if (status >= 400 || status === 304) {
      let evidence: unknown;
      try { evidence = parseJson(text); } catch { evidence = html ? '[HTML response discarded]' : text.slice(0, 2000); }
      const info = { status, response: evidence, method: request.method, path: url.pathname };
      if (status === 403) throw new D2LError(/csrf|xsrf|forgery/i.test(text) ? 'CSRF_REQUIRED' : 'PERMISSION_DENIED',
        'The API denied this request. A 403 can also indicate an unrecognized session or CSRF mechanism.', info,
        'Verify whoami and the tenant CSRF contract; then inspect the endpoint permission requirements.');
      if ([400, 422].includes(status)) throw new D2LError('VALIDATION_REJECTED', 'The API rejected the supplied contract data.', info);
      if ([409, 412, 304].includes(status)) throw new D2LError('CONFLICT', 'The API reported a conflict or an unmet conditional request.', info);
      if (status === 404) throw new D2LError('NOT_FOUND', 'This resource or route was not found; this does not establish a task-level API gap.', info,
        'Check identifiers, permissions, supported API versions, and related operation contracts.');
      if (status === 405 || status === 415) throw new D2LError('CONTRACT_UNKNOWN', 'The method or content type was rejected by this route.', info);
      throw new D2LError(read || status === 429 ? 'TRANSIENT_FAILURE' : 'UNCERTAIN_OUTCOME', 'The service did not complete this request successfully.', info);
    }
    if (body.length > this.config.maxResponseBytes) throw new D2LError('SERVER_FEATURE_MISSING', 'Response exceeds the configured transfer limit.', { status, responseReceived: true, accepted: !read });
    if (html) throw new D2LError('CONTRACT_UNKNOWN', 'An API returned HTML instead of the requested data. HTML was discarded.', { status });
    const safeHeaders = Object.fromEntries(['etag', 'last-modified', 'retry-after', 'x-rate-limit-remaining', 'x-request-id'].filter(k => headers[k] !== undefined).map(k => [k, headers[k]!]));
    let data: unknown = null;
    let numericRepresentations: NumericRepresentation[] = [];
    if (body.length && request.method !== 'HEAD') {
      if (responseType === 'json') {
        if (!/(?:application\/(?:[a-z0-9.-]+\+)?json)/i.test(contentType)) {
          if (read) throw new D2LError('SERVER_FEATURE_MISSING', 'The response is not JSON. Select text or binary transfer explicitly.', { status, contentType });
          data = { responseError: { code: 'SERVER_FEATURE_MISSING', message: 'Write accepted, but the response requires an explicit text or binary transfer contract.', contentType } };
        } else {
          try {
            const document = parseDocument(text);
            // Internal version selection, pagination, validation, and state checks
            // need exact API values. Sanitize only at presentation/storage boundaries.
            data = document.data;
            numericRepresentations = document.numericRepresentations;
          }
          catch {
            if (read) throw new D2LError('CONTRACT_UNKNOWN', 'The API returned malformed JSON.', { status });
            data = { responseError: { code: 'CONTRACT_UNKNOWN', message: 'Write accepted, but the response was malformed JSON.' } };
          }
        }
      } else if (responseType === 'text') {
        if (!/^(?:text\/|application\/(?:xml|csv))/.test(contentType)) throw new D2LError('SERVER_FEATURE_MISSING', 'This response requires binary transfer.', { status, contentType });
        data = text;
      } else {
        if (/^(?:text\/|application\/(?:[a-z0-9.-]+\+)?(?:json|xml))/.test(contentType)) throw new D2LError('SERVER_FEATURE_MISSING', 'Use JSON or text mode for textual responses so authentication fields can be redacted.', { status, responseReceived: true, accepted: !read });
        data = { transfer: 'binary', bytes: body.length };
      }
    }
    return { status, headers: safeHeaders, data, raw: body, contentType, retrievedAt: new Date().toISOString(), numericRepresentations };
  }
}
