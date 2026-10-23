import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeConfig } from '../src/config.js';
import { createClient } from '../src/runtime.js';
import { BrowserAuth } from '../src/auth.js';
import { D2LError } from '../src/errors.js';
import type { TestContext } from 'node:test';

async function recoveryFixture(t: TestContext, mode: 'sso' | 'csrf' | 'interactive' | 'permission' | 'timeout' = 'sso') {
  let valid = false, pageLoads = 0, identityReads = 0, writes = 0;
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method!);
    if (req.url === '/') {
      pageLoads++;
      if (mode === 'timeout') return;
      res.writeHead(302, { location: '/sso' }); res.end(); return;
    }
    if (req.url === '/sso') {
      res.setHeader('Content-Type', 'text/html');
      if (mode === 'interactive') { res.end('<html><form><input name="password" type="password"><button>Sign in</button></form></html>'); return; }
      if (!req.headers.cookie?.includes('fixture_sso=existing-sso-credential')) { res.statusCode = 401; res.end('<html>Sign in</html>'); return; }
      valid = true;
      res.setHeader('Set-Cookie', 'fixture_session=refreshed-session-credential; Path=/; HttpOnly');
      res.end('<html><script>localStorage.setItem("XSRF.Token","refreshed-csrf-credential")</script></html>'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PUT') { writes++; res.statusCode = 401; res.end('{"error":"login required"}'); return; }
    if (req.url?.endsWith('/whoami')) identityReads++;
    if (mode === 'permission') { res.statusCode = 403; res.end('{"error":"Permission denied"}'); return; }
    if (!valid || req.headers['x-csrf-token'] !== 'refreshed-csrf-credential') {
      res.statusCode = 403;
      if (mode === 'csrf') res.end('{"error":"CSRF token is stale"}');
      else { res.setHeader('Content-Type', 'text/html'); res.end('<html>Sign in required</html>'); }
      return;
    }
    res.end(req.url?.endsWith('/whoami') ? '{"Identifier":"1","FirstName":"Fixture"}' : '{"Enabled":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const stateDir = await mkdtemp(join(tmpdir(), 'd2l-session-refresh-'));
  const config = normalizeConfig({ origin, stateDir, allowHttpLocalhost: true, timeoutMs: 800, readRetries: 0,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM } });
  await writeFile(join(stateDir, 'csrf.json'), JSON.stringify({ origin, token: 'stale-csrf-credential' }));
  const client = await createClient(config), browser = client.auth as BrowserAuth, context = await browser.open();
  await context.addCookies([{ name: 'fixture_sso', value: 'existing-sso-credential', url: origin, httpOnly: true }]);
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(stateDir, { recursive: true, force: true }); });
  return { client, browser, context, config, stateDir, pageLoads: () => pageLoads, identityReads: () => identityReads, writes: () => writes,
    invalidate: () => { valid = false; }, methods };
}

for (const mode of ['sso', 'csrf'] as const) {
  test(`headless ${mode} refresh reuses saved sign-in, captures new credentials, verifies API access, and survives restart`, async t => {
    const f = await recoveryFixture(t, mode), pagesBefore = f.context.pages().length;
    const status = await f.client.sessionStatus();
    assert.equal(status.authentication, 'authenticated');
    const recovery = status.sessionRecovery as Record<string, unknown>;
    assert.equal(recovery.attempted, true); assert.equal(recovery.headless, true);
    assert.equal(recovery.outcome, 'authenticated'); assert.equal(recovery.navigation, 'loaded');
    assert.equal(f.pageLoads(), 1); assert.equal(f.identityReads(), 2);
    assert.equal(f.context.pages().length, pagesBefore); // Temporary refresh page is closed.
    assert.ok(f.methods.every(method => method === 'GET'));
    const diagnostic = await f.client.requestStatus(status.requestId as string);
    const audit = await readFile(`${f.stateDir}/records/${status.requestId}.json`, 'utf8');
    assert.equal((diagnostic.data as { action: string }).action, 'session-status');
    assert.ok(audit.includes('initialHttpStatus')); assert.ok(audit.includes('headless'));
    for (const text of [JSON.stringify(status), JSON.stringify(diagnostic), audit]) {
      assert.ok(!text.includes('existing-sso-credential')); assert.ok(!text.includes('refreshed-session-credential'));
      assert.ok(!text.includes('refreshed-csrf-credential')); assert.ok(!text.includes('stale-csrf-credential')); assert.ok(!text.includes('<html>'));
    }
    await f.client.close();
    const restarted = await createClient(f.config);
    try {
      const status = await restarted.sessionStatus();
      assert.equal(status.authentication, 'authenticated'); assert.equal((status.sessionRecovery as { attempted: boolean }).attempted, false);
      assert.equal(f.pageLoads(), 1);
    } finally { await restarted.close(); }
  });
}

test('a real interaction requirement gets one background attempt and then pauses without submitting a form', async t => {
  const f = await recoveryFixture(t, 'interactive');
  const status = await f.client.sessionStatus();
  assert.equal(status.authentication, 'unverified'); assert.equal(status.manualLoginRequired, true);
  assert.equal((status.sessionRecovery as { attempted: boolean }).attempted, true);
  const again = await f.client.sessionStatus();
  assert.equal((again.sessionRecovery as { navigation: string }).navigation, 'already-attempted');
  assert.equal(f.pageLoads(), 1); assert.equal(f.identityReads(), 3);
  const calls = f.methods.length;
  await assert.rejects(f.client.read({ method: 'GET', path: '/d2l/api/fixture/1.0/settings' }), e => e instanceof D2LError && e.code === 'AUTHENTICATION_REQUIRED');
  assert.equal(f.methods.length, calls); assert.ok(f.methods.every(method => method === 'GET'));
});

test('ordinary permission denial does not launch session renewal or claim manual login is required', async t => {
  const f = await recoveryFixture(t, 'permission');
  const status = await f.client.sessionStatus();
  assert.equal(status.authentication, 'unverified'); assert.equal(status.manualLoginRequired, false);
  assert.equal((status.error as { code: string }).code, 'PERMISSION_DENIED');
  assert.equal(f.pageLoads(), 0); assert.equal(f.identityReads(), 1);
  await assert.rejects(f.client.read({ method: 'GET', path: '/d2l/api/fixture/1.0/settings' }), e => e instanceof D2LError && e.code === 'PERMISSION_DENIED');
  assert.equal(f.identityReads(), 1);
});

test('session refresh cannot be redirected by configuration to an unrelated initial origin', async t => {
  const f = await recoveryFixture(t);
  if (f.config.auth.provider === 'browser') f.config.auth.loginPath = 'https://unrelated.example/sign-in';
  const status = await f.client.sessionStatus();
  assert.equal((status.error as { code: string }).code, 'BOUNDARY_VIOLATION');
  assert.equal(status.manualLoginRequired, false); assert.equal(f.pageLoads(), 0);
});

test('a timed-out background refresh remains bounded, rechecks the API, and records the outcome', async t => {
  const f = await recoveryFixture(t, 'timeout');
  const status = await f.client.sessionStatus();
  assert.equal(status.authentication, 'unverified'); assert.equal(status.manualLoginRequired, true);
  assert.equal((status.sessionRecovery as { navigation: string }).navigation, 'timed-out');
  assert.equal(f.identityReads(), 2); assert.equal(f.pageLoads(), 1);
});

test('expired reads recover once and expired writes are never replayed', async t => {
  const f = await recoveryFixture(t);
  assert.equal((await f.client.sessionStatus()).authentication, 'authenticated');
  f.invalidate();
  const read = await f.client.read({ method: 'GET', path: '/d2l/api/fixture/1.0/settings' });
  assert.deepEqual(read.data, { Enabled: true }); assert.equal(f.pageLoads(), 2);
  await assert.rejects(f.client.write({ request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body: {} } }), e => e instanceof D2LError && e.code === 'AUTHENTICATION_REQUIRED');
  assert.equal(f.writes(), 1); assert.equal(f.pageLoads(), 2);
});

test('CLI state preparation errors identify local I/O rather than a missing server feature', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'd2l-cli-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'file-not-directory'), config = join(dir, 'config.json');
  await writeFile(stateDir, 'fixture');
  await writeFile(config, JSON.stringify({ origin: 'https://fixture.example.edu', stateDir }));
  try { await promisify(execFile)(process.execPath, ['dist/cli.js', 'status', '--config', config]); assert.fail('Expected a local I/O failure'); }
  catch (error) {
    const result = JSON.parse((error as { stderr: string }).stderr).error;
    assert.equal(result.code, 'LOCAL_IO_ERROR'); assert.equal(result.stage, 'prepare-private-directory');
    assert.equal(result.systemCode, 'EEXIST');
  }
});
