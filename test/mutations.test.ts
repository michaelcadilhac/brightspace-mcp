import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './helpers.js';
import { D2LError } from '../src/errors.js';
import { parseJson } from '../src/util.js';
import type { ApiRequest } from '../src/schemas.js';

const request: ApiRequest = { method: 'PUT', path: '/d2l/api/test/1.0/settings', body: { Enabled: false, Count: 0, Nothing: null } };
const read: ApiRequest = { method: 'GET', path: '/d2l/api/test/1.0/settings', pagination: { kind: 'none' } };
const code = (value: string) => (e: unknown) => e instanceof D2LError && e.code === value;

test('preconditions and previews capture state without sending a write; conditional requests propagate', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = () => json({ Enabled: true, Count: 0 });
  await assert.rejects(client.write({ request, before: { request: read, checks: [{ pointer: '/Enabled', equals: false }] } }), code('CONFLICT'));
  assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 0);
  const preview = await client.write({ request, preview: true, before: { request: read } });
  assert.equal(preview.preview, true); assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 0);
  auth.handler = (_u, r) => r.method === 'PUT' ? json({}, 412) : json({ Enabled: true });
  await assert.rejects(client.write({ request: { ...request, headers: { 'If-Match': '"etag1"' } } }), code('CONFLICT'));
  assert.equal(auth.calls.at(-1)!.request.headers['if-match'], '"etag1"');
});

test('read-back records actual before/after differences and checks only explicit assertions', async t => {
  const { client, auth } = await fixture(t);
  let state: unknown = { Enabled: true, Count: 0, Nothing: null, Unrelated: 'keep' };
  auth.handler = (_u, r) => { if (r.method === 'PUT') state = parseJson(r.body!); return json(state); };
  const result = await client.write({ request: { ...request, body: { Enabled: false, Count: 0, Nothing: null, Unrelated: 'keep' } },
    before: { request: read, checks: [{ pointer: '/Unrelated', equals: 'keep' }] },
    verification: { request: read, checks: [{ pointer: '/Enabled', equals: false }, { pointer: '/Count', equals: 0 }, { pointer: '/Nothing', equals: null }] } });
  const verification = result.verification as { status: string; differences: { data: Array<{ path: string }> } };
  assert.equal(verification.status, 'verified'); assert.deepEqual(verification.differences.data.map(d => d.path), ['/Enabled']);
  const audit = (await client.requestStatus(result.requestId as string)).data as Record<string, unknown>;
  assert.equal(audit.state, 'accepted'); assert.equal(audit.verification, 'verified'); assert.ok(audit.before); assert.ok(audit.after);
  const observed = await client.write({ request, verification: { request: read } });
  assert.equal((observed.verification as { status: string }).status, 'observed');
});

test('compatibility preserves first, then omits, then applies only an authorized finite default', async t => {
  const { client, auth } = await fixture(t);
  let state = { NumberOfAttemptsAllowed: 0, Unrelated: false };
  const bodies: unknown[] = [];
  auth.handler = (_url, req) => {
    if (req.method === 'GET') return json(state);
    const body = parseJson(req.body!) as typeof state; bodies.push(body);
    if (body.NumberOfAttemptsAllowed === undefined || body.NumberOfAttemptsAllowed === 0) return json({ error: 'NumberOfAttemptsAllowed invalid' }, 400);
    state = body; return json(state);
  };
  const result = await client.write({ request: { ...request, body: state }, before: { request: read },
    verification: { request: read, checks: [{ pointer: '/NumberOfAttemptsAllowed', equals: 1 }, { pointer: '/Unrelated', equals: false }] },
    compatibility: [{ pointer: '/NumberOfAttemptsAllowed', rejectionPattern: 'NumberOfAttemptsAllowed', defaultValue: 1, source: 'fixture:known-validation-constraint' }] });
  assert.deepEqual(bodies, [
    { NumberOfAttemptsAllowed: 0, Unrelated: false }, { Unrelated: false }, { NumberOfAttemptsAllowed: 1, Unrelated: false }
  ]);
  assert.equal((result.verification as { status: string }).status, 'verified');
  assert.equal((result.warnings as string[]).length, 2);
});

test('successful omission is read back rather than treated as preservation', async t => {
  const { client, auth } = await fixture(t);
  let state = { Count: 0 };
  auth.handler = (_url, req) => {
    if (req.method === 'GET') return json(state);
    const body = parseJson(req.body!) as { Count: number };
    if (body.Count === 0) return json({ error: 'Count must be positive' }, 422);
    state = { Count: body.Count ?? 7 }; return json(state);
  };
  const result = await client.write({ request: { ...request, body: { Count: 0 } }, before: { request: read },
    verification: { request: read, checks: [{ pointer: '/Count', equals: 0 }] },
    compatibility: [{ pointer: '/Count', rejectionPattern: 'Count', defaultValue: 1, source: 'fixture:validation' }] });
  assert.equal((result.verification as { status: string }).status, 'mismatch');
  assert.deepEqual(state, { Count: 7 }); assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 2);
});

test('null-to-finite compatibility transitions require the corresponding policy', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = () => json({ error: 'Count rejected' }, 400);
  await assert.rejects(client.write({ request: { ...request, body: { Count: null } }, verification: { request: read },
    compatibility: [{ pointer: '/Count', rejectionPattern: 'Count', omit: false, defaultValue: 1, source: 'fixture:validation' }] }), code('VALIDATION_REJECTED'));
  assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 1);
});

for (const status of [401, 403, 409, 429, 503]) {
  test(`compatibility alternatives are never attempted after HTTP ${status}`, async t => {
    const { client, auth } = await fixture(t);
    auth.handler = () => json({ error: 'Count rejected' }, status);
    await assert.rejects(client.write({ request, verification: { request: read },
      compatibility: [{ pointer: '/Count', rejectionPattern: 'Count', defaultValue: 1, source: 'fixture:validation' }] }));
    assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 1);
  });
}

test('an uncertain write is audited and reconciled by reading, without replaying the write', async t => {
  const { client, auth } = await fixture(t);
  let applied = false, requestId = '';
  auth.handler = (_url, req) => {
    if (req.method === 'PUT') { applied = true; throw new Error('timeout after service commit'); }
    return json({ Enabled: applied });
  };
  try { await client.write({ request, verification: { request: read } }); assert.fail('expected uncertainty'); }
  catch (e) { assert.ok(e instanceof D2LError); assert.equal(e.code, 'UNCERTAIN_OUTCOME'); requestId = e.evidence.requestId as string; }
  const result = await client.requestStatus(requestId, { request: read, checks: [{ pointer: '/Enabled', equals: true }] });
  const audit = result.data as { state: string; reconciliation: { status: string } };
  assert.equal(audit.state, 'uncertain'); assert.equal(audit.reconciliation.status, 'matches-expected-state');
  assert.equal(auth.calls.filter(c => c.request.method === 'PUT').length, 1);
});

test('read-back failure preserves HTTP acceptance and is never treated as a rejected write', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = (_url, req) => req.method === 'PUT' ? json({ accepted: true }, 202) : json({ error: 'read denied' }, 403);
  const result = await client.write({ request, verification: { request: read } });
  assert.equal(result.accepted, true); assert.equal(result.status, 202);
  assert.equal((result.verification as { status: string }).status, 'failed');
  assert.equal(((await client.requestStatus(result.requestId as string)).data as { state: string }).state, 'accepted');
});

test('a successful write with an unsupported response stays accepted and can be verified', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = (_url, req) => req.method === 'PUT'
    ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('accepted') }
    : json({ Enabled: false });
  const result = await client.write({ request, verification: { request: read, checks: [{ pointer: '/Enabled', equals: false }] } });
  assert.equal(result.accepted, true);
  assert.equal((result.verification as { status: string }).status, 'verified');
  assert.equal((((result.response as { data: { responseError: { code: string } } }).data).responseError).code, 'SERVER_FEATURE_MISSING');
});
