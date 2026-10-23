import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeConfig } from '../src/config.js';
import { createClient } from '../src/runtime.js';
import { BrowserAuth } from '../src/auth.js';
import { D2LError } from '../src/errors.js';
import type { D2LClient } from '../src/client.js';

async function localTenant(requireReadCsrf = false) {
  let expired = false, writes = 0;
  const seen: Array<{ path: string; cookie?: string; csrf?: string }> = [];
  const server = createServer(async (req, res) => {
    const path = req.url!;
    seen.push({ path, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'] as string });
    res.setHeader('Content-Type', 'application/json');
    const authenticated = !expired && (req.headers.cookie?.includes('fixture_session=secret-cookie') || req.headers.authorization === 'Bearer fixture-token');
    if (path.endsWith('/versions/')) { res.end(JSON.stringify([{ ProductCode: 'lp', SupportedVersions: ['1.49'] }])); return; }
    if (path === '/d2l/api/fixture/1.0/csrf') { res.end('{"Token":"fixture-csrf"}'); return; }
    if (!authenticated) { res.statusCode = 401; res.end('{"error":"sign in"}'); return; }
    if (requireReadCsrf && req.headers.cookie && req.headers['x-csrf-token'] !== 'fixture-csrf') {
      res.statusCode = 403; res.end('{"error":"CSRF is required for session reads"}'); return;
    }
    if (path.endsWith('/whoami')) { res.end('{"Identifier":"42","FirstName":"Local fixture"}'); return; }
    if (path.includes('/enrollments/myenrollments/')) {
      const last = new URL(path, 'http://fixture').searchParams.get('bookmark') === '1';
      res.setHeader('Set-Cookie', 'auth_rotation=rotated-session-credential; Path=/; HttpOnly');
      res.end(JSON.stringify({ Items: [{ Identifier: last ? '101' : '1', Date: '2026-10-23T01:00:00Z', Timezone: 'America/Chicago',
        Password: '1', echo: 'secret-cookie', rotated: 'rotated-session-credential', csrf: 'fixture-csrf' }],
        PagingInfo: { HasMoreItems: !last, Bookmark: '1' } })); return;
    }
    if (req.method === 'PUT') {
      if (req.headers.cookie && req.headers['x-csrf-token'] !== 'fixture-csrf') { res.statusCode = 403; res.end('{"error":"CSRF rejected"}'); return; }
      writes++; res.end('{"Enabled":true}'); return;
    }
    res.end('{"Enabled":false,"zero":0,"nil":null}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, seen, writes: () => writes, expire: () => { expired = true; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('real Chromium session cookies survive restart; configured CSRF is sent and expiry pauses requests', async t => {
  const tenant = await localTenant(), stateDir = await mkdtemp(join(tmpdir(), 'd2l-browser-integration-'));
  const clients: D2LClient[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await tenant.close(); await rm(stateDir, { recursive: true, force: true }); });
  const config = normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM, csrfCookieName: 'XSRF.Token' } });
  const first = await createClient(config); clients.push(first);
  const browser = first.auth as BrowserAuth, context = await browser.open();
  // Fixture authentication material, not an automated real-world sign-in flow.
  await context.addCookies([
    { name: 'fixture_session', value: 'secret-cookie', url: tenant.origin, httpOnly: true },
    { name: 'XSRF.Token', value: 'fixture-csrf', url: tenant.origin }
  ]);
  await browser.capture();
  assert.equal((await first.sessionStatus()).authentication, 'authenticated');
  const body = { Enabled: true };
  assert.equal((await first.write({ request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body } })).accepted, true);
  assert.equal(tenant.writes(), 1);
  await first.close();
  const second = await createClient(config); clients.push(second);
  const status = await second.sessionStatus(); assert.equal(status.authentication, 'authenticated');
  assert.ok(!JSON.stringify(status).includes('secret-cookie')); assert.ok(!JSON.stringify(status).includes('fixture-csrf'));
  const snapshot = JSON.parse(await readFile(join(stateDir, 'auth-state.json'), 'utf8'));
  assert.ok(snapshot.state.cookies.some((c: { name: string }) => c.name === 'fixture_session'));
  tenant.expire();
  await assert.rejects(second.read({ method: 'GET', path: '/d2l/api/fixture/1.0/settings' }), (e: unknown) => e instanceof D2LError && e.code === 'AUTHENTICATION_REQUIRED');
  const calls = tenant.seen.length;
  await assert.rejects(second.read({ method: 'GET', path: '/d2l/api/fixture/1.0/settings' })); assert.equal(tenant.seen.length, calls);
});

test('browser cookie flags preserve versioned catalog reads, bookmarks, and metadata while credentials stay private', async t => {
  const tenant = await localTenant(), stateDir = await mkdtemp(join(tmpdir(), 'd2l-cookie-redaction-'));
  let client: D2LClient | undefined;
  t.after(async () => { await client?.close(); await tenant.close(); await rm(stateDir, { recursive: true, force: true }); });
  client = await createClient(normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM, csrfCookieName: 'XSRF.Token' } }));
  const browser = client.auth as BrowserAuth, context = await browser.open();
  await context.addCookies([
    { name: 'fixture_session', value: 'secret-cookie', url: tenant.origin, httpOnly: true },
    { name: 'XSRF.Token', value: 'fixture-csrf', url: tenant.origin },
    { name: 'cookie_consent', value: '1', url: tenant.origin },
    { name: 'tenant_auth_flag', value: '1', url: tenant.origin, httpOnly: true },
    { name: 'timezone', value: 'America/Chicago', url: tenant.origin }
  ]);
  await browser.capture();
  assert.equal((await client.sessionStatus()).authentication, 'authenticated');
  const versions = await client.versions();
  assert.deepEqual((versions.families as { SupportedVersions: string[] }[])[0]!.SupportedVersions, ['1.49']);
  const first = await client.paginate({ request: { operationId: 'enrollments.mine' }, maxPages: 1 });
  assert.equal(first.pages, 1); assert.equal(first.itemCount, 1); assert.equal(first.complete, false);
  assert.deepEqual(first.data, [{ Identifier: '1', Date: '2026-10-23T01:00:00Z', Timezone: 'America/Chicago',
    Password: '[REDACTED]', echo: '[REDACTED]', rotated: '[REDACTED]', csrf: '[REDACTED]' }]);
  assert.match(first.requestId as string, /^[\da-f-]{36}$/);
  await client.requestStatus(first.requestId as string);
  const rest = await client.paginate({ continuation: first.continuation as string, exportOnly: true });
  assert.equal(rest.complete, true); assert.equal(rest.itemCount, 1);
  const exported = await client.store.result(rest.resultHandle as string);
  assert.equal((exported.data as { Identifier: string }[])[0]!.Identifier, '101');
  const record = await readFile(rest.localPath as string, 'utf8');
  for (const raw of [JSON.stringify(first), JSON.stringify(rest), JSON.stringify(exported), record]) {
    assert.ok(!raw.includes('secret-cookie')); assert.ok(!raw.includes('rotated-session-credential')); assert.ok(!raw.includes('fixture-csrf'));
  }
  assert.ok(tenant.seen.some(r => r.path === '/d2l/api/lp/1.49/enrollments/myenrollments/?bookmark=1'));
});

test('real Chromium refuses a missing CSRF contract and supports a configured programmatic token interface', async t => {
  const tenant = await localTenant(), stateDir = await mkdtemp(join(tmpdir(), 'd2l-csrf-integration-'));
  let client: D2LClient | undefined;
  t.after(async () => { await client?.close(); await tenant.close(); await rm(stateDir, { recursive: true, force: true }); });
  const config = normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM } });
  client = await createClient(config);
  const context = await (client.auth as BrowserAuth).open();
  await context.addCookies([{ name: 'fixture_session', value: 'secret-cookie', url: tenant.origin, httpOnly: true }]);
  await assert.rejects(client.write({ request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body: {} } }), (e: unknown) => e instanceof D2LError && e.code === 'CSRF_REQUIRED');
  assert.equal(tenant.writes(), 0);
  if (config.auth.provider === 'browser') config.auth.csrfTokenEndpoint = { path: '/d2l/api/fixture/1.0/csrf', pointer: '/Token', source: 'fixture:established-token-api' };
  assert.equal((await client.write({ request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body: {} } })).accepted, true);
  assert.equal(tenant.writes(), 1);
});

test('the default XSRF.Token local-storage pattern is captured without exposing browser control to MCP', async t => {
  const tenant = await localTenant(true), stateDir = await mkdtemp(join(tmpdir(), 'd2l-storage-integration-'));
  let client: D2LClient | undefined;
  t.after(async () => { await client?.close(); await tenant.close(); await rm(stateDir, { recursive: true, force: true }); });
  client = await createClient(normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM } }));
  const browser = client.auth as BrowserAuth, context = await browser.open();
  await context.addCookies([{ name: 'fixture_session', value: 'secret-cookie', url: tenant.origin, httpOnly: true }]);
  // Seed only the fake localhost authentication state. The production server exposes no browser/JS tool.
  const page = await context.newPage();
  await page.goto(tenant.origin + '/d2l/api/fixture/1.0/settings');
  await page.evaluate(() => localStorage.setItem('XSRF.Token', 'fixture-csrf'));
  await browser.capture();
  assert.equal((await client.sessionStatus()).authentication, 'authenticated');
  assert.equal((await client.write({ request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body: {} } })).accepted, true);
  assert.equal(browser.csrfStatus(), 'tenant-local-storage-observed');
  assert.equal(tenant.writes(), 1);
});

test('authentication capture survives full SSO storage-state failures and persists the session before optional storage reads', async t => {
  const tenant = await localTenant(), stateDir = await mkdtemp(join(tmpdir(), 'd2l-sso-capture-'));
  let client: D2LClient | undefined;
  t.after(async () => { await client?.close(); await tenant.close(); await rm(stateDir, { recursive: true, force: true }); });
  client = await createClient(normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM } }));
  const auth = client.auth as BrowserAuth, context = await auth.open();
  await context.addCookies([{ name: 'fixture_session', value: 'secret-cookie', url: tenant.origin, httpOnly: true }]);
  let fullStateCalls = 0;
  context.storageState = async () => { fullStateCalls++; throw new Error('An unrelated SSO origin denied storage'); };
  const page = await context.newPage(); await page.goto(tenant.origin + '/d2l/api/fixture/1.0/settings');
  page.evaluate = (async () => {
    const saved = JSON.parse(await readFile(join(stateDir, 'auth-state.json'), 'utf8'));
    assert.ok(saved.state.cookies.some((cookie: { name: string }) => cookie.name === 'fixture_session'));
    throw new Error('The optional token read failed; Cookie: secret-cookie');
  }) as typeof page.evaluate;
  await auth.capture();
  assert.equal(fullStateCalls, 0); assert.ok(auth.captureWarning());
  assert.ok(!auth.captureWarning()!.includes('secret-cookie'));
  assert.equal((await client.sessionStatus()).authentication, 'authenticated');
  await auth.close();
  // Closing the browser before a later capture produces an actionable error, while cleanup stays safe.
  const fresh = await createClient(normalizeConfig({ origin: tenant.origin, stateDir, allowHttpLocalhost: true,
    auth: { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM } }));
  client = fresh;
  const freshContext = await (fresh.auth as BrowserAuth).open(); await freshContext.close();
  await assert.rejects((fresh.auth as BrowserAuth).capture(), (e: unknown) => e instanceof D2LError && e.code === 'AUTHENTICATION_REQUIRED');
});

test('real stdio MCP process verifies bearer auth, performs reads, and keeps diagnostics off stdout', async t => {
  const tenant = await localTenant(), stateDir = await mkdtemp(join(tmpdir(), 'd2l-stdio-integration-'));
  t.after(() => tenant.close()); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ origin: tenant.origin, stateDir, allowHttpLocalhost: true, auth: { provider: 'bearer', tokenEnv: 'FIXTURE_TOKEN' } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve', '--config', configPath],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, FIXTURE_TOKEN: 'fixture-token' }, stderr: 'pipe' });
  let diagnostics = ''; transport.stderr?.on('data', c => { diagnostics += String(c); });
  const mcp = new Client({ name: 'integration-fixture', version: '1.0' });
  t.after(() => mcp.close()); await mcp.connect(transport);
  assert.equal((await mcp.listTools()).tools.length, 10);
  const status = await mcp.callTool({ name: 'd2l_session_status', arguments: {} });
  assert.equal((status.structuredContent as { authentication: string }).authentication, 'authenticated');
  const read = await mcp.callTool({ name: 'd2l_api_read', arguments: { method: 'GET', path: '/d2l/api/fixture/1.0/settings' } });
  assert.deepEqual((read.structuredContent as { data: unknown }).data, { Enabled: false, zero: 0, nil: null });
  assert.ok(!JSON.stringify(read).includes('fixture-token'));
  assert.ok(diagnostics.includes('stdio'));
});
