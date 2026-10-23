import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './helpers.js';
import { D2LError } from '../src/errors.js';
import { ApiTransport } from '../src/transport.js';
import { ProfileLock } from '../src/lock.js';
import { Redactor } from '../src/util.js';

const code = (expected: string) => (e: unknown) => e instanceof D2LError && e.code === expected;

test('canonical tenant boundary blocks URL/path escapes and protected headers before HTTP', async t => {
  const { client, auth } = await fixture(t);
  for (const path of ['https://evil.example/api', '//evil.example/d2l/api/', '/d2l/api/../login', '/d2l/api/%2e%2e/login',
    '/d2l/api/x%2fy', '/d2l/api/%252e%252e/login', '/d2l/api/x\\evil', '/d2l/api/x?token=bad', '/d2l/api//evil', '/d2l/api/x%00', '/d2l/login']) {
    await assert.rejects(client.read({ method: 'GET', path }), code('BOUNDARY_VIOLATION'));
  }
  for (const header of ['Authorization', 'Cookie', 'X-Csrf-Token', 'Host', 'Origin', 'Referer', 'Proxy-Authorization']) {
    await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x', headers: { [header]: 'malicious' } }), code('BOUNDARY_VIOLATION'));
  }
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x', apiOrigin: 'https://evil.example' }), code('BOUNDARY_VIOLATION'));
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x', query: { access_token: 'caller-secret' } }), code('BOUNDARY_VIOLATION'));
  assert.equal(auth.calls.length, 0);
});

test('verified route extensions grant API access without granting unrelated routes', async t => {
  const { client } = await fixture(t, { apiRoutes: [{ origin: 'https://tenant.example.edu', prefixes: ['/d2l/first-party/v1'], source: 'fixture:application-trace' }] });
  assert.equal((await client.read({ method: 'GET', path: '/d2l/first-party/v1/settings' })).status, 200);
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/first-party/v10/settings' }), code('BOUNDARY_VIOLATION'));
});

test('redirects do not forward credentials outside same-origin API routes', async t => {
  const { client, auth } = await fixture(t);
  for (const location of ['https://evil.example/d2l/api/x', '/d2l/login', '/d2l/api/%2e%2e/login', 'https://tenant.example.edu@evil.example/d2l/api/x']) {
    const calls = auth.calls.length;
    auth.handler = () => ({ status: 302, headers: { location }, body: Buffer.alloc(0) });
    await assert.rejects(client.transport.request(new URL('https://tenant.example.edu/d2l/api/test/1.0/x'), { method: 'GET', headers: {} }, true), code('AUTHENTICATION_REQUIRED'));
    assert.equal(auth.calls.length, calls + 1);
  }
  auth.handler = url => url.pathname.endsWith('/next') ? json({ ok: true }) : { status: 307, headers: { location: '/d2l/api/test/1.0/next' }, body: Buffer.alloc(0) };
  assert.deepEqual((await client.transport.request(new URL('https://tenant.example.edu/d2l/api/test/1.0/x'), { method: 'GET', headers: {} }, true)).data, { ok: true });
  await assert.rejects(client.transport.request(new URL('https://tenant.example.edu/d2l/api/test/1.0/x'), { method: 'PUT', headers: {} }, false), code('UNCERTAIN_OUTCOME'));
  await assert.rejects(client.transport.request(new URL('https://tenant.example.edu/d2l/api/test/1.0/x'), { method: 'POST', headers: {} }, true), code('CONTRACT_UNKNOWN'));
});

test('session expiry pauses affected requests and login HTML never becomes API data', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<!doctype html><html><form>SSO Sign in password secret</form></html>') });
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' }), e => {
    assert.ok(e instanceof D2LError); assert.equal(e.code, 'AUTHENTICATION_REQUIRED'); assert.ok(!JSON.stringify(e.toJSON()).includes('<form>')); return true;
  });
  const calls = auth.calls.length;
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' }), code('AUTHENTICATION_REQUIRED'));
  assert.equal(auth.calls.length, calls);
  assert.equal((await client.sessionStatus()).authentication, 'authenticated');
  auth.handler = () => json({ ok: true });
  assert.equal((await client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' })).status, 200);
});

test('rate limiting obeys bounded Retry-After for reads and never retries writes', async t => {
  const { client, auth, config } = await fixture(t, { readRetries: 2, maxRetryDelayMs: 1000 });
  const delays: number[] = [];
  const transport = new ApiTransport(config, client.boundary, auth, client.redactor, async ms => { delays.push(ms); });
  let calls = 0;
  auth.handler = () => ++calls < 3 ? json({ error: 'quota' }, 429, { 'retry-after': '0.1' }) : json({ ok: true });
  await transport.request(new URL(config.origin + '/d2l/api/test/1.0/x'), { method: 'GET', headers: {} }, true);
  assert.deepEqual(delays, [100, 100]);
  auth.handler = () => json({ error: 'quota' }, 429, { 'retry-after': '120' });
  await assert.rejects(transport.request(new URL(config.origin + '/d2l/api/test/1.0/x'), { method: 'GET', headers: {} }, true), code('TRANSIENT_FAILURE'));
  assert.equal(delays.length, 2);
  await assert.rejects(transport.request(new URL(config.origin + '/d2l/api/test/1.0/x'), { method: 'PUT', headers: {} }, false), code('TRANSIENT_FAILURE'));
  assert.equal(delays.length, 2);
});

test('failures distinguish permission, CSRF, validation, not-found, conflicts and transfer gaps', async t => {
  const { client, auth } = await fixture(t);
  for (const [status, body, expected] of [
    [403, { error: 'Permission required' }, 'PERMISSION_DENIED'], [403, { error: 'CSRF failed' }, 'CSRF_REQUIRED'],
    [400, { error: 'invalid body' }, 'VALIDATION_REJECTED'], [404, {}, 'NOT_FOUND'], [409, {}, 'CONFLICT'], [415, {}, 'CONTRACT_UNKNOWN']
  ] as const) {
    auth.handler = () => json(body, status);
    await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' }), code(expected));
  }
  auth.handler = () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-fixture') });
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' }), code('SERVER_FEATURE_MISSING'));
  const binary = await client.read({ method: 'GET', path: '/d2l/api/test/1.0/x', responseType: 'binary' });
  assert.ok(binary.resultHandle);
  auth.handler = () => json({ Token: 'sensitive' });
  await assert.rejects(client.read({ method: 'GET', path: '/d2l/api/test/1.0/x', responseType: 'binary' }), code('SERVER_FEATURE_MISSING'));
  await assert.rejects(client.write({ request: { method: 'POST', path: '/d2l/api/test/1.0/x', body: {}, headers: { 'content-type': 'multipart/form-data' } } }), code('SERVER_FEATURE_MISSING'));
});

test('sanitization removes known tokens, cookies, passwords and nested secret fields', async t => {
  const { client, auth } = await fixture(t);
  client.redactor.add('a-secret-token');
  auth.handler = () => json({ Password: 'hidden', nested: { access_token: 'also-hidden' }, message: 'bearer a-secret-token', x: 'a-secret-token', value: false });
  const result = await client.read({ method: 'GET', path: '/d2l/api/test/1.0/x' });
  const raw = JSON.stringify(result);
  assert.ok(!raw.includes('hidden')); assert.ok(!raw.includes('a-secret-token')); assert.ok(raw.includes('false'));
  assert.equal(new Redactor().clean({ 'XSRF.Token': 'secret' })['XSRF.Token'], '[REDACTED]');
});

test('kernel profile lock permits exactly one owner and releases cleanly', async t => {
  const { stateDir } = await fixture(t);
  const first = new ProfileLock(), second = new ProfileLock();
  t.after(() => first.release()); t.after(() => second.release());
  await first.acquire(stateDir);
  await assert.rejects(second.acquire(stateDir), code('PROFILE_IN_USE'));
  await first.release();
  await second.acquire(stateDir); await second.release();
});
