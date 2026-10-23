import { chromium, type BrowserContext, type Cookie } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { privateDir, privateWrite } from './config.js';
import { Boundary } from './boundary.js';
import { D2LError } from './errors.js';
import { pointer, Redactor, parseJson } from './util.js';
import { resolveChromiumExecutable, browserLaunchError } from './browser.js';
import { authenticationError } from './auth-errors.js';

export interface WireRequest { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }
export interface WireResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface SessionRefresh {
  attempted: boolean;
  method: 'browser-page-refresh';
  headless: boolean;
  navigation: 'loaded' | 'timed-out' | 'failed' | 'already-attempted';
  tenantReached?: boolean;
}
export interface AuthProvider {
  readonly kind: string;
  send(url: URL, request: WireRequest): Promise<WireResponse>;
  close(): Promise<void>;
  csrfStatus?(): string;
  refreshSession?(): Promise<SessionRefresh>;
  sessionVerified?(): void;
}

export class BrowserAuth implements AuthProvider {
  readonly kind = 'browser';
  private context?: BrowserContext;
  private opening?: Promise<BrowserContext>;
  private csrf?: string;
  private csrfEvidence = 'not-observed';
  private contextClosed = false;
  private csrfWarning?: string;
  private headless = true;
  private refreshAttempted = false;
  private refreshing?: Promise<SessionRefresh>;
  constructor(readonly config: Config, readonly redactor: Redactor, readonly boundary: Boundary) {}
  async open(headless = true): Promise<BrowserContext> {
    if (this.context) {
      if (this.contextClosed) throw authenticationError(new Error('Browser context closed'), 'open-session');
      return this.context;
    }
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const auth = this.config.auth;
      if (auth.provider !== 'browser') throw new D2LError('VALIDATION_REJECTED', 'Browser authentication is not configured.');
      const profile = join(this.config.stateDir, 'profile');
      await privateDir(profile);
      const browser = await resolveChromiumExecutable({ configured: auth.executablePath });
      try {
        this.context = await chromium.launchPersistentContext(profile, {
          headless, executablePath: browser.path, acceptDownloads: false,
          serviceWorkers: 'block', timeout: 30000
        });
        this.headless = headless;
        this.contextClosed = false;
        this.context.on('close', () => { this.contextClosed = true; });
      } catch (error) {
        throw browserLaunchError(error, browser, headless);
      }
      try {
        const saved = JSON.parse(await readFile(join(this.config.stateDir, 'auth-state.json'), 'utf8'));
        if (saved.origin === this.config.origin && Array.isArray(saved.state?.cookies)) await this.context.addCookies(saved.state.cookies);
      } catch { /* A fresh profile has no explicit session-cookie snapshot. */ }
      try {
        const saved = JSON.parse(await readFile(join(this.config.stateDir, 'csrf.json'), 'utf8'));
        if (saved.origin === this.config.origin && typeof saved.token === 'string') {
          this.csrf = saved.token; this.redactor.add(this.csrf); this.csrfEvidence = 'captured-during-manual-login';
        }
      } catch { /* No captured authentication material yet. */ }
      return this.context;
    })();
    try { return await this.opening; } finally { this.opening = undefined; }
  }
  private async observe(knownCookies?: Cookie[]): Promise<void> {
    const context = await this.open();
    const auth = this.config.auth;
    if (auth.provider !== 'browser') return;
    for (const cookie of knownCookies ?? await context.cookies()) this.redactor.addCookie(cookie);
    const cookies = await context.cookies(this.config.origin);
    const fromCookie = auth.csrfCookieName ? cookies.find(c => c.name === auth.csrfCookieName)?.value : undefined;
    // Read only the fixed tenant authentication slot. Full storageState() traverses unrelated SSO
    // origins and can fail after an otherwise successful sign-in. No course/page content is read.
    let fromStorage: string | undefined;
    this.csrfWarning = undefined;
    for (const page of context.pages()) {
      let origin: string;
      try { origin = new URL(page.url()).origin; } catch { continue; }
      if (origin !== this.config.origin || page.isClosed()) continue;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const token = await Promise.race([
          page.evaluate(({ tenant, key }) => location.origin === tenant ? localStorage.getItem(key) : null,
            { tenant: this.config.origin, key: auth.csrfStorageKey }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Authentication storage timed out')), Math.min(this.config.timeoutMs, 5000)); })
        ]).finally(() => clearTimeout(timer));
        if (typeof token === 'string' && token) { fromStorage = token; break; }
      } catch {
        this.csrfWarning = 'The tenant CSRF storage value could not be observed. Cookies are still saved; writes require a verified CSRF mechanism.';
      }
    }
    if (fromStorage || fromCookie) {
      this.csrf = fromStorage ?? fromCookie;
      this.csrfEvidence = fromStorage ? 'tenant-local-storage-observed' : 'configured-cookie-observed';
      this.redactor.add(this.csrf);
    }
  }
  async capture(): Promise<void> {
    let stage = 'capture-cookies';
    try {
      const context = await this.open();
      const cookies = await context.cookies();
      for (const cookie of cookies) this.redactor.addCookie(cookie);
      // Save reusable session cookies before attempting optional browser storage observation.
      stage = 'save-session-cookies';
      await privateWrite(join(this.config.stateDir, 'auth-state.json'), JSON.stringify({ origin: this.config.origin, state: { cookies, origins: [] } }));
      stage = 'observe-tenant-csrf';
      await this.observe(cookies);
      stage = 'save-tenant-csrf';
      if (this.csrf) await privateWrite(join(this.config.stateDir, 'csrf.json'), JSON.stringify({ origin: this.config.origin, token: this.csrf }));
    } catch (error) { throw authenticationError(error, stage); }
  }
  sessionVerified(): void { this.refreshAttempted = false; }
  async refreshSession(): Promise<SessionRefresh> {
    if (this.refreshing) return this.refreshing;
    const report = { method: 'browser-page-refresh' as const, headless: this.headless };
    if (this.refreshAttempted) return { ...report, attempted: false, navigation: 'already-attempted' };
    this.refreshAttempted = true;
    this.refreshing = (async () => {
      const auth = this.config.auth;
      if (auth.provider !== 'browser') throw new D2LError('VALIDATION_REJECTED', 'Browser authentication is not configured.');
      const url = new URL(auth.loginPath, this.config.origin);
      if (url.origin !== this.config.origin || url.username || url.password) throw new D2LError('BOUNDARY_VIOLATION', 'The initial session refresh URL must belong to the configured tenant and contain no credentials.');
      const context = await this.open();
      const page = await context.newPage();
      const deadline = Date.now() + Math.min(this.config.timeoutMs, 30000);
      const remaining = () => Math.max(1, deadline - Date.now());
      let navigation: SessionRefresh['navigation'] = 'loaded';
      try {
        try {
          // Normal page redirects/scripts may reuse existing SSO. Never inspect or
          // fill sign-in forms, click controls, or extract course/page content.
          await page.goto(url.href, { waitUntil: 'load', timeout: remaining() });
          await page.waitForURL(current => current.origin === this.config.origin, { waitUntil: 'load', timeout: remaining() });
          if (!auth.csrfCookieName && Date.now() < deadline) {
            await page.waitForFunction(({ tenant, key }) => location.origin === tenant && !!localStorage.getItem(key),
              { tenant: this.config.origin, key: auth.csrfStorageKey }, { timeout: Math.min(remaining(), 1500) }).catch(() => {});
          }
        } catch (error) {
          navigation = error instanceof Error && error.name === 'TimeoutError' ? 'timed-out' : 'failed';
        }
        const tenantReached = new URL(page.url()).origin === this.config.origin;
        await this.capture();
        return { ...report, attempted: true, navigation, tenantReached };
      } finally { await page.close().catch(() => {}); }
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async send(url: URL, request: WireRequest): Promise<WireResponse> {
    await this.observe();
    const auth = this.config.auth;
    if (auth.provider !== 'browser') throw new D2LError('VALIDATION_REJECTED', 'Browser provider is not configured.');
    const headers = { ...request.headers };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (auth.csrfTokenEndpoint) {
        const tokenUrl = this.boundary.url(auth.csrfTokenEndpoint.path);
        const tokenResponse = await this.raw(tokenUrl, { ...request, method: 'GET', body: undefined, headers: { accept: 'application/json' } });
        if (tokenResponse.status === 401 || /text\/html/i.test(tokenResponse.headers['content-type'] ?? '')) throw new D2LError('AUTHENTICATION_REQUIRED', 'The token interface requires fresh authentication.');
        if (tokenResponse.status !== 200) throw new D2LError('CSRF_REQUIRED', 'The configured token interface failed.', { status: tokenResponse.status });
        const token = pointer(parseJson(tokenResponse.body.toString('utf8')), auth.csrfTokenEndpoint.pointer);
        if (typeof token !== 'string' || !token) throw new D2LError('CONTRACT_UNKNOWN', 'The configured token interface did not return a token at its established pointer.');
        this.csrf = token; this.redactor.add(token); this.csrfEvidence = 'configured-programmatic-token-interface';
      }
      if (!this.csrf) throw new D2LError('CSRF_REQUIRED', 'No tenant CSRF token has been observed; the request was not sent.', {},
        'Complete manual login, or configure a verified CSRF cookie or token API contract.');
    }
    // Browser-session APIs can require the observed token for identity reads as well as mutations.
    if (this.csrf) {
      if (!/^[A-Za-z0-9-]+$/.test(auth.csrfHeader) || /[\r\n]/.test(this.csrf)) throw new D2LError('VALIDATION_REJECTED', 'Invalid configured CSRF header or token.');
      headers[auth.csrfHeader] = this.csrf;
    }
    return this.raw(url, { ...request, headers });
  }
  private async raw(url: URL, request: WireRequest): Promise<WireResponse> {
    const context = await this.open();
    const response = await context.request.fetch(url.href, {
      method: request.method, headers: request.headers, data: request.body,
      timeout: request.timeoutMs, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false
    });
    try {
      const headers = response.headers();
      // fetch updates the shared cookie jar. Register rotated credentials before
      // their response can reach an output/storage boundary; ignore preference flags.
      for (const cookie of await context.cookies()) this.redactor.addCookie(cookie);
      return { status: response.status(), headers, body: await response.body() };
    } finally { await response.dispose(); }
  }
  csrfStatus(): string { return this.csrfEvidence; }
  captureWarning(): string | undefined { return this.csrfWarning; }
  async close(): Promise<void> {
    const context = this.context;
    if (!context) return;
    if (this.contextClosed) { this.context = undefined; return; }
    try { await this.capture(); } finally { this.context = undefined; await context.close(); }
  }
}

/** Registered OAuth clients may supply/renew a token externally; the server never drives IdP screens. */
export class BearerAuth implements AuthProvider {
  readonly kind = 'bearer';
  constructor(readonly config: Config, readonly redactor: Redactor) {}
  async send(url: URL, request: WireRequest): Promise<WireResponse> {
    const auth = this.config.auth;
    const token = auth.provider === 'bearer' ? process.env[auth.tokenEnv] : undefined;
    if (!token || /[\r\n]/.test(token)) throw new D2LError('AUTHENTICATION_REQUIRED', 'Supply a valid access token through the configured environment variable.');
    this.redactor.add(token);
    const response = await fetch(url, { method: request.method, headers: { ...request.headers, authorization: `Bearer ${token}` },
      body: request.body, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs) });
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) for await (const chunk of response.body) {
      length += chunk.length;
      if (length > this.config.maxResponseBytes) {
        await response.body.cancel().catch(() => {});
        throw new D2LError('SERVER_FEATURE_MISSING', 'Response exceeds the configured transfer limit.', { responseReceived: true, status: response.status });
      }
      chunks.push(chunk);
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.concat(chunks) };
  }
  async close(): Promise<void> {}
}
