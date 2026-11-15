import { z } from 'zod';
import type { Config } from './config.js';
import type { AuthProvider } from './auth.js';
import { ApiTransport, type HttpResult } from './transport.js';
import { Boundary } from './boundary.js';
import { Catalog, chooseVersion, compatible, validateSchema, type Operation } from './catalog.js';
import { Store } from './store.js';
import { D2LError, asError } from './errors.js';
import { assertSafeNumbers, parseJson, pointer, hash, equal, differences, changeAt, type Redactor } from './util.js';
import { requestSchema, writeSchema, paginateSchema, observationSchema, type ApiRequest, type WriteInput, type PaginateInput, type Pagination } from './schemas.js';

interface Resolved {
  request: ApiRequest; operation?: Operation; method: string; url: URL; body?: string;
  headers: Record<string, string>; validation: string[]; version?: string; pagination?: Pagination;
}
interface Audit extends Record<string, unknown> {
  kind: 'request'; requestId: string; startedAt: string; state: string; verification: string;
}
interface PageState { kind: 'continuation'; request: ApiRequest; pending: unknown[]; next?: ApiRequest; seen: string[]; pendingRetrieval?: Record<string, unknown> }
type Observation = z.infer<typeof writeSchema>['before'];

export class D2LClient {
  private versionCache?: { at: number; data: Array<{ ProductCode: string; SupportedVersions: string[]; [k: string]: unknown }> };
  private identity?: { at: number; account: Record<string, unknown> };
  private paused?: D2LError;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly config: Config, readonly auth: AuthProvider, readonly transport: ApiTransport,
    readonly boundary: Boundary, readonly catalog: Catalog, readonly store: Store, readonly redactor: Redactor) {}

  /** The shared session's queue keeps each tool's precondition/write/read-back sequence together across connections. */
  serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action); this.queue = run.catch(() => {}); return run;
  }
  async sessionStatus(): Promise<Record<string, unknown>> {
    return this.audit('session-status', async audit => {
      const url = this.boundary.url(`/d2l/api/lp/${this.config.auth.whoamiVersion}/users/whoami`);
      audit.method = 'GET'; audit.path = url.pathname;
      let sessionRecovery: Record<string, unknown> = { attempted: false };
      const verify = async () => {
        const result = await this.transport.request(url, { method: 'GET', headers: { accept: 'application/json' } }, true);
        const data = result.data as Record<string, unknown>;
        if (!data || typeof data !== 'object' || !['string', 'number'].includes(typeof data.Identifier)) throw new D2LError('AUTHENTICATION_REQUIRED', 'The identity API did not verify an account.');
        return { result, data };
      };
      try {
        let verified;
        try { verified = await verify(); }
        catch (error) {
          const initial = asError(error, 'verify-session');
          if (!['AUTHENTICATION_REQUIRED', 'CSRF_REQUIRED'].includes(initial.code) || !this.auth.refreshSession) throw initial;
          audit.initialError = initial.toJSON(); audit.state = 'refreshing-session';
          sessionRecovery = { attempted: true, startedAt: new Date().toISOString(), reason: initial.code, initialHttpStatus: initial.evidence.status };
          audit.sessionRecovery = sessionRecovery;
          await this.store.put(audit, audit.requestId);
          Object.assign(sessionRecovery, await this.auth.refreshSession(), { finishedAt: new Date().toISOString() });
          if (!sessionRecovery.attempted) throw initial;
          verified = await verify(); // A loaded page alone never proves authentication.
        }
        const { result, data } = verified;
        const account = Object.fromEntries(['Identifier', 'FirstName', 'LastName', 'UniqueName'].filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]]));
        this.identity = { at: Date.now(), account }; this.paused = undefined; this.auth.sessionVerified?.();
        audit.state = 'succeeded'; audit.httpStatus = result.status; audit.authentication = 'authenticated';
        audit.sessionRecovery = { ...sessionRecovery, outcome: 'authenticated' };
        return { requestId: audit.requestId, authentication: 'authenticated', account, tenant: this.config.origin, provider: this.auth.kind,
          verifiedAt: result.retrievedAt, timezone: this.config.timezone, csrf: this.auth.csrfStatus?.(), sessionRecovery: audit.sessionRecovery,
          sessionSupport: this.auth.kind === 'browser' ? 'Tenant identity verified; CSRF observation is not proof of mutation support.' : 'Configured bearer provider' };
      } catch (error) {
        const failure = asError(error, 'verify-session');
        this.identity = undefined;
        const manualLoginRequired = this.auth.kind === 'browser' && ['AUTHENTICATION_REQUIRED', 'CSRF_REQUIRED'].includes(failure.code);
        this.paused = new D2LError(failure.code, failure.message, { ...failure.evidence, authenticationRequestId: audit.requestId, manualLoginRequired }, failure.nextStep);
        audit.state = 'failed'; audit.authentication = 'unverified'; audit.error = failure.toJSON();
        audit.sessionRecovery = { ...sessionRecovery, finishedAt: sessionRecovery.attempted ? new Date().toISOString() : undefined, outcome: 'unverified' };
        return { requestId: audit.requestId, authentication: 'unverified', tenant: this.config.origin, provider: this.auth.kind,
          error: failure.toJSON(), manualLoginRequired, sessionRecovery: audit.sessionRecovery };
      }
    });
  }
  private async ensureSession() {
    if (this.paused) throw this.paused;
    if (!this.identity || Date.now() - this.identity.at > 60000) {
      const status = await this.sessionStatus();
      if (status.authentication !== 'authenticated') {
        const error = status.error as ReturnType<D2LError['toJSON']>;
        throw new D2LError(error.code, error.message, { identityVerified: false, authenticationRequestId: status.requestId, manualLoginRequired: status.manualLoginRequired }, error.nextStep);
      }
    }
  }
  async versions(refresh = false): Promise<Record<string, unknown>> {
    if (!refresh && this.versionCache && Date.now() - this.versionCache.at < 86400000) return this.redactor.clean({ families: this.versionCache.data, retrievedAt: new Date(this.versionCache.at).toISOString(), cached: true });
    const result = await this.transport.request(this.boundary.url('/d2l/api/versions/'), { method: 'GET', headers: { accept: 'application/json' } }, true);
    const schema = z.array(z.object({ ProductCode: z.string(), SupportedVersions: z.array(z.string()), LatestVersion: z.string().optional() }).passthrough());
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) throw new D2LError('CONTRACT_UNKNOWN', 'Version discovery returned an unexpected contract.');
    this.versionCache = { at: Date.now(), data: parsed.data };
    return this.redactor.clean({ families: parsed.data, retrievedAt: result.retrievedAt, cached: false, tenantValidation: 'version-advertisement-only' });
  }
  async resolve(input: ApiRequest, read: boolean): Promise<Resolved> {
    const request = requestSchema.parse(input);
    assertSafeNumbers(request);
    if (request.operationId && (request.path || request.method)) throw new D2LError('VALIDATION_REJECTED', 'Use an operation ID with pathParams, or an explicit method/path. Do not override an operation route.');
    if (!request.operationId && (!request.path || !request.method)) throw new D2LError('VALIDATION_REJECTED', 'Supply operationId, or method and path.');
    let operation: Operation | undefined, path = request.path, method = request.method, version = request.version;
    if (request.operationId) {
      operation = this.catalog.get(request.operationId); method = operation.method;
      if (operation.apiFamily) {
        await this.versions();
        const supported = this.versionCache!.data.find(f => f.ProductCode === operation!.apiFamily)?.SupportedVersions ?? [];
        version = chooseVersion(supported, operation, version);
      }
      const params = request.pathParams ?? {};
      const expected = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!).filter(k => k !== 'version');
      if (Object.keys(params).some(k => !expected.includes(k)) || expected.some(k => params[k] === undefined || params[k] === null)) throw new D2LError('VALIDATION_REJECTED', 'Missing or unexpected path parameters.', { expected });
      path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(key === 'version' ? version : params[key])));
    } else {
      if (request.pathParams || request.version) throw new D2LError('VALIDATION_REJECTED', 'Explicit paths already contain their version and path parameters.');
      operation = this.catalog.match(method!, path!);
      version = path!.match(/^\/d2l\/api\/[^/]+\/(\d+\.\d+)\//)?.[1];
      if (operation?.versions && (!version || !compatible(version, operation))) operation = undefined; // Honest transport-only access beyond a bundled contract.
    }
    const semantics = operation?.semantics ?? (['GET', 'HEAD', 'OPTIONS'].includes(method!) ? 'read' : 'write');
    if ((semantics === 'read') !== read) throw new D2LError('VALIDATION_REJECTED', `This ${semantics} operation must use the corresponding API tool.`);
    const url = this.boundary.url(path!, request.apiOrigin);
    for (const [key, values] of Object.entries(request.query ?? {})) {
      this.boundary.queryKey(key);
      for (const value of Array.isArray(values) ? values : [values]) url.searchParams.append(key, value === null ? 'null' : String(value));
    }
    const headers: Record<string, string> = { accept: request.responseType === 'json' ? 'application/json' : request.responseType === 'text' ? 'text/plain, text/*' : 'application/octet-stream, */*', ...this.boundary.headers(request.headers) };
    const count = Number(request.body !== undefined) + Number(request.bodyJson !== undefined) + Number(request.sourceBody !== undefined);
    if (count > 1) throw new D2LError('VALIDATION_REJECTED', 'Supply only one of body, bodyJson, or sourceBody.');
    let body: string | undefined, data = request.body;
    if (request.sourceBody !== undefined) {
      if (!operation) throw new D2LError('CONTRACT_UNKNOWN', 'A catalog contract is required for read-to-write serialization.');
      data = this.catalog.serialize(operation, request.sourceBody);
    }
    if (request.bodyJson !== undefined) {
      try { data = parseJson(request.bodyJson); } catch { throw new D2LError('VALIDATION_REJECTED', 'bodyJson is not valid JSON.'); }
      body = request.bodyJson;
    } else if (data !== undefined) body = JSON.stringify(data);
    if (body !== undefined && ['GET', 'HEAD', 'OPTIONS'].includes(method!)) throw new D2LError('VALIDATION_REJECTED', 'This transport does not send bodies with GET, HEAD, or OPTIONS.');
    if (body !== undefined) {
      if (headers['content-type'] && !/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(headers['content-type'])) throw new D2LError('SERVER_FEATURE_MISSING', 'Only JSON request bodies are implemented. Multipart and streaming uploads require a transport extension.');
      headers['content-type'] ??= 'application/json';
    }
    const validation = [validateSchema(operation?.querySchema, request.query ?? {}, 'query'),
      validateSchema(operation?.requestSchema, data, 'request body')];
    if (!operation) validation.push('Contract unknown; explicit API transport remains available.');
    else validation.push(`Catalog schema knowledge: ${operation.schemaKnowledge}; tenant behavior is not asserted.`);
    if (request.operationId && operation?.apiFamily) request.version = version;
    request.pagination ??= operation?.pagination;
    return { request, operation, method: method!, url, body, headers, version, validation, pagination: request.pagination };
  }
  private async send(resolved: Resolved, read: boolean): Promise<HttpResult> {
    await this.ensureSession();
    const request = () => this.transport.request(resolved.url, { method: resolved.method, headers: resolved.headers, body: resolved.body }, read, resolved.request.responseType);
    try {
      return await request();
    } catch (e) {
      if (e instanceof D2LError && (e.code === 'AUTHENTICATION_REQUIRED' || (read && e.code === 'CSRF_REQUIRED' && this.auth.refreshSession))) {
        this.paused = e; this.identity = undefined;
        // A read can be retried once after account verification. Never replay a write.
        if (read && this.auth.refreshSession) {
          const status = await this.sessionStatus();
          if (status.authentication === 'authenticated') {
            try { return await request(); }
            catch (retryError) {
              if (retryError instanceof D2LError && ['AUTHENTICATION_REQUIRED', 'CSRF_REQUIRED'].includes(retryError.code)) { this.paused = retryError; this.identity = undefined; }
              throw retryError;
            }
          }
          const failure = status.error as ReturnType<D2LError['toJSON']>;
          throw new D2LError(failure.code, failure.message, { authenticationRequestId: status.requestId }, failure.nextStep);
        }
      }
      throw e;
    }
  }
  private async audit<T>(kind: string, action: (audit: Audit) => Promise<T>): Promise<T> {
    const requestId = this.store.id();
    const audit: Audit = { kind: 'request', requestId, action: kind, startedAt: new Date().toISOString(), state: 'started', verification: 'not-performed' };
    await this.store.put(audit, requestId);
    try {
      const result = await action(audit);
      audit.finishedAt = new Date().toISOString();
      await this.store.put(audit, requestId);
      // Public operation reports are a presentation boundary. Keep the transport
      // and in-memory observations intact; sanitize the returned copy and audit.
      return this.redactor.clean(result);
    } catch (e) {
      const error = e instanceof z.ZodError ? new D2LError('VALIDATION_REJECTED', 'Tool inputs do not match the transport schema.', { issues: e.issues.map(i => ({ path: i.path, message: i.message })) }) : asError(e);
      if (error.evidence.responseReceived && Number(error.evidence.status) >= 200 && Number(error.evidence.status) < 300 && kind === 'write') {
        audit.state = 'accepted'; audit.verification = 'unverified';
      } else if (audit.state !== 'accepted') audit.state = error.code === 'UNCERTAIN_OUTCOME' ? 'uncertain' : 'failed';
      audit.error = error.toJSON(); audit.finishedAt = new Date().toISOString();
      await this.store.put(audit, requestId);
      throw new D2LError(error.code, error.message, { operationId: audit.operationId, method: audit.method, path: audit.path,
        apiVersion: audit.apiVersion, ...this.redactor.clean(error.evidence), requestId, verification: audit.verification },
        error.nextStep ?? 'Inspect the operation contract and technical request record before choosing the next API request.');
    }
  }
  private describeRequest(r: Resolved, audit: Audit) {
    Object.assign(audit, { method: r.method, path: r.url.pathname, operationId: r.operation?.id,
      apiVersion: r.version, tenant: r.url.origin, query: Object.fromEntries(r.url.searchParams),
      validation: r.validation, updateBehavior: r.operation?.updateBehavior ?? 'unknown', bodySha256: r.body ? hash(r.body) : undefined });
  }
  private coverage(r: Resolved) {
    return { scope: 'Records visible to the verified account for the specified endpoint and filters.', visibility: 'not-proven-complete',
      limitations: r.operation?.limitations ?? ['Uncataloged API coverage and visibility require caller review.'], snapshotConsistency: 'not-guaranteed' };
  }
  private async page(r: Resolved, result: HttpResult, seen: string[] = []): Promise<{ items: unknown[]; complete: boolean | null; next?: ApiRequest }> {
    const contract = r.pagination;
    if (!contract) return { items: [], complete: null };
    if (contract.kind === 'none') {
      const items = contract.itemsPointer !== undefined ? pointer(result.data, contract.itemsPointer) : [result.data];
      if (!Array.isArray(items)) throw new D2LError('CONTRACT_UNKNOWN', 'Expected an array at the established items pointer.');
      return { items, complete: true };
    }
    const items = pointer(result.data, contract.itemsPointer);
    if (!Array.isArray(items)) throw new D2LError('CONTRACT_UNKNOWN', 'The response does not match its established pagination items pointer.');
    let next: ApiRequest | undefined;
    if (contract.kind === 'bookmark') {
      const more = pointer(result.data, contract.hasMorePointer), cursor = pointer(result.data, contract.cursorPointer);
      if (typeof more !== 'boolean' || (more && (typeof cursor !== 'string' || !cursor))) throw new D2LError('CONTRACT_UNKNOWN', 'Malformed bookmark pagination response.');
      if (more) next = { ...r.request, query: { ...r.request.query, [contract.queryParameter]: cursor as string } };
    } else {
      const link = pointer(result.data, contract.nextPointer);
      if (link !== null && typeof link !== 'string') throw new D2LError('CONTRACT_UNKNOWN', 'Expected Next to be a URL string or explicit null.');
      if (link !== null) {
        const url = this.boundary.nextUrl(link as string, r.url);
        const query: Record<string, string | string[]> = {};
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key); query[key] = values.length === 1 ? values[0]! : values;
        }
        next = { method: 'GET', path: url.pathname, apiOrigin: url.origin, query, pagination: contract, responseType: 'json' };
      }
    }
    if (next && (seen.includes(hash(next)) || hash(next) === hash(r.request))) throw new D2LError('DATA_INCOMPLETE', 'The endpoint repeated a pagination continuation; collection stopped.');
    return { items, complete: !next, next };
  }
  async read(input: ApiRequest): Promise<Record<string, unknown>> {
    return this.audit('read', async audit => {
      const r = await this.resolve(input, true); this.describeRequest(r, audit);
      const result = await this.send(r, true);
      const page = await this.page(r, result);
      const continuation = page.next ? await this.store.put({ kind: 'continuation', request: page.next, pending: [], seen: [hash(r.request)] } satisfies PageState) : undefined;
      audit.state = 'succeeded'; audit.httpStatus = result.status; audit.responseHeaders = result.headers;
      const responseValidation = this.responseValidation(r.operation, result.data);
      const presentation = await this.presentResponse(result);
      return { requestId: audit.requestId, status: result.status, ...presentation, headers: result.headers,
        retrievedAt: result.retrievedAt, apiVersion: r.version, validation: [...r.validation, responseValidation],
        numericRepresentations: result.numericRepresentations.length ? await this.store.present(result.numericRepresentations) : undefined,
        complete: page.complete, continuation, completionMeaning: page.complete === null ? 'No established pagination contract; completeness is unknown.' : 'Endpoint page traversal only; visibility is separate.', coverage: this.coverage(r) };
    });
  }
  private responseValidation(operation: Operation | undefined, data: unknown): string {
    try { return validateSchema(operation?.responseSchema, data, 'response'); }
    catch { return 'Response did not match the known schema. All returned fields were preserved; inspect the contract before further writes.'; }
  }
  private async presentResponse(result: HttpResult): Promise<Record<string, unknown>> {
    // Binary exports are base64, private and expiring; they never pass through JSON parsing.
    if (result.data && (result.data as { transfer?: string }).transfer === 'binary') {
      return this.store.present({ encoding: 'base64', contentType: result.contentType, base64: result.raw.toString('base64') }, true);
    }
    return this.store.present(result.data);
  }
  private async observe(spec: NonNullable<Observation>): Promise<{ result: HttpResult; checks: unknown[]; matches: boolean }> {
    const r = await this.resolve(spec.request, true);
    if ((r.request.responseType ?? 'json') !== 'json') throw new D2LError('VALIDATION_REJECTED', 'State checks require a JSON read contract.');
    const result = await this.send(r, true);
    const checks = spec.checks.map(check => {
      const actual = pointer(result.data, check.pointer);
      return { ...check, actual, actualPresent: actual !== undefined,
        matches: (check.exists === undefined || check.exists === (actual !== undefined)) && equal(actual, check.equals) };
    });
    if (spec.sha256) checks.push({ pointer: '', equals: spec.sha256, actual: hash(result.data), actualPresent: true, matches: spec.sha256 === hash(result.data) });
    return { result, checks, matches: checks.every(c => c.matches) };
  }
  async write(input: WriteInput): Promise<Record<string, unknown>> {
    return this.audit('write', async audit => {
      const spec = writeSchema.parse(input);
      let r = await this.resolve(spec.request, false); this.describeRequest(r, audit);
      if (spec.compatibility.length && !spec.verification) throw new D2LError('VALIDATION_REJECTED', 'Compatibility retries require a read-back specification.');
      // Resolve follow-up contracts before sending a write, so an invalid verification request cannot surprise us afterward.
      if (spec.before) await this.resolve(spec.before.request, true);
      if (spec.verification) await this.resolve(spec.verification.request, true);
      const before = spec.before ? await this.observe(spec.before) : undefined;
      if (before) { audit.before = before.result.data; audit.beforeNumericRepresentations = before.result.numericRepresentations; audit.preconditions = before.checks; }
      if (before && !before.matches) throw new D2LError('CONFLICT', 'Before-state preconditions did not match. No mutation was sent.', { checks: before.checks });
      const warnings = r.operation?.updateBehavior === 'replace' ? ['This API replaces properties. Only the supplied write model is sent; omitted fields may be reset.'] : [];
      if (spec.preview) {
        audit.state = 'preview';
        return { requestId: audit.requestId, preview: true, method: r.method, path: r.url.pathname, apiVersion: r.version,
          body: r.body === undefined ? undefined : this.redactor.clean(parseJson(r.body)), validation: r.validation, warnings,
          before: before ? await this.store.present(before.result.data) : undefined, plannedReadBack: spec.verification };
      }
      const attempts: unknown[] = []; audit.attempts = attempts;
      let result: HttpResult;
      let activeRule: number | undefined, stage: 'original' | 'omission' | 'default' = 'original';
      while (true) {
        audit.state = 'sending'; audit.verification = 'pending'; audit.bodySha256 = r.body ? hash(r.body) : undefined;
        await this.store.put(audit, audit.requestId); // Durable intent before the side effect.
        try {
          result = await this.send(r, false);
          attempts.push({ stage, status: result.status }); break;
        } catch (e) {
          const error = asError(e); attempts.push({ stage, error: error.toJSON() });
          if (error.code !== 'VALIDATION_REJECTED' || ![400, 422].includes(Number(error.evidence.status))) throw error;
          const evidence = JSON.stringify(error.evidence.response).toLowerCase();
          const nextRule = activeRule ?? spec.compatibility.findIndex(rule => evidence.includes(rule.rejectionPattern.toLowerCase()));
          const rule = spec.compatibility[nextRule];
          if (!rule || !evidence.includes(rule.rejectionPattern.toLowerCase())) throw error;
          let body: unknown = r.body ? parseJson(r.body) : undefined;
          if (!body || typeof body !== 'object' || spec.request.bodyJson) throw error;
          const originalBody = spec.request.body ?? (spec.request.sourceBody !== undefined && r.operation ? this.catalog.serialize(r.operation, spec.request.sourceBody) : undefined);
          const originalValue = pointer(originalBody, rule.pointer);
          if (stage === 'original' && rule.omit) {
            if (originalValue === null && !rule.allowNullTransition) throw new D2LError('VALIDATION_REJECTED', 'Omitting a null/unlimited setting could change its status. The compatibility policy does not authorize that transition.');
            body = changeAt(body, rule.pointer, 'omit'); stage = 'omission';
          }
          else if (stage !== 'default' && Object.hasOwn(rule, 'defaultValue')) {
            if (((originalValue === null) !== (rule.defaultValue === null)) && !rule.allowNullTransition) throw new D2LError('VALIDATION_REJECTED', 'Compatibility policy does not authorize a transition between null and a finite value. No normalization was sent.');
            body = changeAt(body, rule.pointer, 'set', rule.defaultValue); stage = 'default';
          } else throw error;
          activeRule = nextRule;
          r = await this.resolve({ ...spec.request, sourceBody: undefined, bodyJson: undefined, body }, false);
          warnings.push(`Applied caller-authorized ${stage} for ${rule.pointer} after a definitive validation rejection. Read-back determines the actual effect.`);
        }
      }
      audit.httpStatus = result.status; audit.responseHeaders = result.headers; audit.state = 'accepted'; audit.verification = 'unverified';
      // Persist acceptance before attempting verification. A later read failure never erases an accepted write.
      await this.store.put(audit, audit.requestId);
      let verification: Record<string, unknown> = { status: 'unverified', checked: [] };
      if (spec.verification) {
        try {
          const after = await this.observe(spec.verification); audit.after = after.result.data; audit.afterNumericRepresentations = after.result.numericRepresentations;
          const checked = spec.verification.checks.length + Number(!!spec.verification.sha256);
          audit.verification = checked ? (after.matches ? 'verified' : 'mismatch') : 'observed';
          audit.differences = before ? differences(before.result.data, after.result.data) : undefined;
          verification = { status: audit.verification, checked: after.checks, observedAt: after.result.retrievedAt,
            numericRepresentations: after.result.numericRepresentations.length ? await this.store.present(after.result.numericRepresentations) : undefined,
            after: await this.store.present(after.result.data), differences: before ? await this.store.present(audit.differences) : undefined,
            scope: checked ? 'Only the listed field/hash assertions were checked.' : 'Read-back captured; no intended-effect assertion was supplied.' };
        } catch (e) {
          audit.verification = 'failed'; verification = { status: 'failed', error: this.redactor.clean(asError(e).toJSON()),
            nextStep: 'Inspect the request and reconcile through a read; do not replay the accepted write.' };
        }
      }
      return { requestId: audit.requestId, accepted: true, status: result.status, apiVersion: r.version,
        response: await this.presentResponse(result), validation: r.validation, verification, warnings, attempts,
        retrievedAt: result.retrievedAt };
    });
  }
  async paginate(input: PaginateInput): Promise<Record<string, unknown>> {
    return this.audit('paginate', async audit => {
      const spec = paginateSchema.parse(input);
      if (Number(!!spec.request) + Number(!!spec.continuation) !== 1) throw new D2LError('VALIDATION_REJECTED', 'Supply a request or a continuation handle.');
      const state: PageState = spec.continuation ? await this.store.get<PageState>(spec.continuation) : { kind: 'continuation', request: spec.request!, pending: [], seen: [] };
      if (state.kind !== 'continuation') throw new D2LError('VALIDATION_REJECTED', 'This handle is not a pagination continuation.');
      let pending = state.pending, next: ApiRequest | undefined = state.request, following = state.next, pages = 0;
      let pendingRetrieval = state.pendingRetrieval;
      const items: unknown[] = [], seen = [...state.seen], retrievals: unknown[] = pendingRetrieval ? [pendingRetrieval] : [];
      let complete = false, lastResolved: Resolved | undefined, failure: unknown;
      while (items.length < spec.maxItems) {
        if (pending.length) {
          const take = Math.min(spec.maxItems - items.length, pending.length);
          items.push(...pending.slice(0, take)); pending = pending.slice(take);
          if (pending.length) break;
          next = following; following = undefined;
          if (!next) { complete = true; break; }
          if (items.length >= spec.maxItems) break;
        }
        if (pages >= spec.maxPages || !next) { complete = !next; break; }
        try {
          const r = await this.resolve(next, true); lastResolved = r; this.describeRequest(r, audit);
          if (!r.pagination) throw new D2LError('CONTRACT_UNKNOWN', 'Collection requires an established pagination contract. Supply one with evidence for an explicit request.');
          const result = await this.send(r, true); pages++;
          const page = await this.page(r, result, seen); seen.push(hash(r.request));
          pendingRetrieval = { path: r.url.pathname, retrievedAt: result.retrievedAt, status: result.status,
            numericRepresentations: result.numericRepresentations.length ? await this.store.present(result.numericRepresentations) : undefined };
          retrievals.push(pendingRetrieval);
          pending = page.items; following = page.next;
          if (!pending.length) { next = following; following = undefined; if (!next) { complete = true; break; } }
        } catch (e) { failure = asError(e).toJSON(); break; }
      }
      const continuation = complete ? undefined : await this.store.put({ kind: 'continuation', request: next ?? state.request, pending, next: following,
        seen, pendingRetrieval: pending.length ? pendingRetrieval : undefined } satisfies PageState);
      audit.state = complete ? 'succeeded' : 'incomplete'; audit.pages = pages; audit.items = items.length; audit.failure = failure;
      return { requestId: audit.requestId, ...await this.store.present(items, spec.exportOnly), complete, continuation,
        incompleteReason: complete ? undefined : failure ? 'retrieval-failed' : pending.length ? 'item-limit' : 'page-limit',
        error: failure, itemCount: items.length, pages, retrievals,
        coverage: lastResolved ? this.coverage(lastResolved) : { visibility: 'not-proven-complete' },
        completionMeaning: 'Page traversal for this collection segment only. No transactional snapshot or complete role visibility is asserted.' };
    });
  }
  async requestStatus(requestId: string, reconcile?: z.input<typeof observationSchema>): Promise<Record<string, unknown>> {
    const audit = await this.store.get<Audit>(requestId);
    if (audit.kind !== 'request') throw new D2LError('VALIDATION_REJECTED', 'This is not a technical request handle.');
    if (audit.state === 'sending' || audit.state === 'started') {
      audit.state = 'uncertain'; audit.verification = 'not-performed';
      audit.recovery = 'A prior process stopped before saving a final outcome. Use a reconciliation read before replaying a write.';
    }
    if (reconcile) {
      const spec = observationSchema.parse(reconcile);
      const observation = await this.observe(spec);
      const hasAssertions = !!(spec.checks.length || spec.sha256);
      audit.reconciliation = { at: observation.result.retrievedAt, checks: observation.checks,
        status: hasAssertions ? (observation.matches ? 'matches-expected-state' : 'mismatch') : 'observed',
        data: observation.result.data, scope: 'This is evidence of current state; it does not prove which request caused it.' };
      await this.store.put(audit, requestId);
    }
    return { requestId, ...await this.store.present(audit) };
  }
  async refreshCatalog() {
    await this.catalog.load(this.config.catalogFiles);
    return { revisions: this.catalog.revisions, tenantValidation: 'not-asserted' };
  }
  async close() { await this.auth.close(); }
}
