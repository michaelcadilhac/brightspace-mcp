import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeConfig } from '../src/config.js';
import { createClient } from '../src/runtime.js';
import { BrowserAuth } from '../src/auth.js';
import { ProfileLock } from '../src/lock.js';
import { connectSession, sessionSocketPath } from '../src/session.js';

async function setup(t: TestContext, browser = false) {
  let value = 0, writes = 0, hold: (() => Promise<void>) | undefined;
  const tenant = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html>Local sign-in fixture</html>'); return; }
    if (!req.headers.authorization && !req.headers.cookie?.includes('fixture_session=shared-session-credential')) {
      res.statusCode = 401; res.end('{"error":"Sign in required"}'); return;
    }
    if (req.url?.endsWith('/whoami')) { res.end('{"Identifier":"42","FirstName":"Fixture"}'); return; }
    if (req.method === 'PUT') {
      writes++;
      let body = ''; for await (const chunk of req) body += chunk;
      await hold?.();
      value = JSON.parse(body).Value;
    }
    res.end(JSON.stringify({ Value: value }));
  });
  await new Promise<void>(resolve => tenant.listen(0, '127.0.0.1', resolve));
  const stateDir = await mkdtemp(join(tmpdir(), 'd2l-shared-'));
  const configFile = join(stateDir, 'config.json');
  const input = { origin: `http://127.0.0.1:${(tenant.address() as { port: number }).port}`, stateDir, allowHttpLocalhost: true,
    auth: browser ? { provider: 'browser', executablePath: process.env.D2L_TEST_CHROMIUM, csrfCookieName: 'XSRF.Token' } : { provider: 'bearer', tokenEnv: 'FIXTURE_TOKEN' } };
  await writeFile(configFile, JSON.stringify(input));
  const config = normalizeConfig(input), clients: Client[] = [], diagnostics: string[] = [];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>, FIXTURE_TOKEN: 'shared-fixture-token' };
  const connect = async (file = configFile, extraEnv: Record<string, string> = {}) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'serve', '--config', file], env: { ...env, ...extraEnv }, stderr: 'pipe' });
    const index = diagnostics.length; diagnostics.push('');
    transport.stderr?.on('data', chunk => { diagnostics[index] += String(chunk); });
    const client = new Client({ name: 'shared-session-fixture', version: '1.0' }); clients.push(client);
    try { await client.connect(transport); return client; }
    catch (error) { await client.close(); throw error; }
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    // The owner closes one second after the last connection; wait for the real kernel lock.
    const lock = new ProfileLock();
    for (let attempt = 0; ; attempt++) {
      try { await lock.acquire(stateDir); await lock.release(); break; }
      catch (error) { if (attempt >= 80) throw error; await delay(100); }
    }
    tenant.closeAllConnections(); await new Promise<void>(resolve => tenant.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });
  return { config, configFile, stateDir, env, connect, diagnostics, writes: () => writes,
    hold: (action: (() => Promise<void>) | undefined) => { hold = action; } };
}
type ToolValue = Record<string, unknown> & { authentication?: string; requestId?: string; resultHandle?: string;
  verification?: { status: string }; error?: { code: string } };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, value: result.structuredContent as ToolValue };
};
const request = { method: 'GET', path: '/d2l/api/fixture/1.0/settings' };

test('simultaneous stdio startups share one owner, preserve protocol isolation, and permit CLI status', async t => {
  const f = await setup(t);
  const clients = await Promise.all([f.connect(), f.connect(), f.connect()]);
  const statuses = await Promise.all(clients.map(client => call(client, 'd2l_session_status')));
  for (const result of statuses) assert.equal(result.value.authentication, 'authenticated');
  assert.equal(new Set(statuses.map(result => result.value.requestId)).size, 3);
  const socket = await stat(sessionSocketPath(f.config));
  assert.ok(socket.isSocket()); assert.equal(socket.mode & 0o777, 0o600);
  const lock = new ProfileLock();
  await assert.rejects(lock.acquire(f.stateDir), { code: 'PROFILE_IN_USE' });
  const cli = await promisify(execFile)(process.execPath, ['dist/cli.js', 'status', '--config', f.configFile], { env: f.env });
  assert.equal(JSON.parse(cli.stdout).authentication, 'authenticated');
  await clients[0]!.close();
  assert.deepEqual((await call(clients[1]!, 'd2l_api_read', request)).value.data, { Value: 0 });
  const exported = await call(clients[1]!, 'd2l_api_paginate', { request: { ...request, pagination: { kind: 'none' } }, exportOnly: true });
  const result = await call(clients[2]!, 'd2l_get_result', { resultHandle: exported.value.resultHandle });
  assert.deepEqual(result.value.data, [{ Value: 0 }]);
  for (const text of [...f.diagnostics, ...statuses.map(value => JSON.stringify(value))]) assert.ok(!text.includes('shared-fixture-token'));
});

test('different configuration and bearer credentials cannot silently reuse an existing session', async t => {
  const f = await setup(t), first = await f.connect();
  const other = join(f.stateDir, 'other.json');
  await writeFile(other, JSON.stringify({ ...f.config, timezone: 'UTC' }));
  await assert.rejects(f.connect(other));
  assert.ok(f.diagnostics.at(-1)!.includes('CONFLICT'));
  await assert.rejects(f.connect(f.configFile, { FIXTURE_TOKEN: 'different-fixture-token' }));
  assert.ok(f.diagnostics.at(-1)!.includes('CONFLICT'));
  assert.ok(!f.diagnostics.join('').includes('different-fixture-token'));
  assert.equal((await call(first, 'd2l_session_status')).value.authentication, 'authenticated');
});

test('competing writes serialize their entire precondition/write/verification sequence across clients', async t => {
  const f = await setup(t), [first, second] = await Promise.all([f.connect(), f.connect()]);
  f.hold(() => delay(75));
  const write = { request: { ...request, method: 'PUT', body: { Value: 1 } },
    before: { request, checks: [{ pointer: '/Value', equals: 0 }] },
    verification: { request, checks: [{ pointer: '/Value', equals: 1 }] } };
  const results = await Promise.all([call(first, 'd2l_api_write', write), call(second, 'd2l_api_write', write)]);
  assert.equal(results.filter(result => result.value.verification?.status === 'verified').length, 1);
  assert.equal(results.filter(result => result.value.error?.code === 'CONFLICT').length, 1);
  assert.equal(f.writes(), 1);

  let sent!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hold(async () => { sent(); await gate; });
  const pending = call(first, 'd2l_api_write', { request: { ...request, method: 'PUT', body: { Value: 2 } },
    verification: { request, checks: [{ pointer: '/Value', equals: 2 }] } }).catch(() => undefined);
  try { await started; await first.close(); } finally { release(); }
  await pending;
  assert.deepEqual((await call(second, 'd2l_api_read', request)).value.data, { Value: 2 });
  assert.equal(f.writes(), 2); // Disconnect never replays or interrupts an already transmitted mutation.
});

test('the last client can disconnect during a write and reconnect while the owner drains it', async t => {
  const f = await setup(t), first = await f.connect();
  let sent!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hold(async () => { sent(); await gate; });
  const pending = call(first, 'd2l_api_write', { request: { ...request, method: 'PUT', body: { Value: 3 } },
    verification: { request, checks: [{ pointer: '/Value', equals: 3 }] } }).catch(() => undefined);
  let second: Client;
  try {
    await started; await first.close();
    await delay(1200); // The idle deadline passes while the transmitted write remains in flight.
    second = await f.connect();
  } finally { release(); }
  await pending;
  assert.deepEqual((await call(second!, 'd2l_api_read', request)).value.data, { Value: 3 });
  assert.equal(f.writes(), 1);
});

test('a dead owner leaves a recoverable socket and new clients start a fresh owner without replay', async t => {
  const f = await setup(t);
  const daemon = spawn(process.execPath, ['dist/cli.js', 'session-daemon', '--config', f.configFile], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (daemon.exitCode === null) daemon.kill('SIGTERM'); });
  const [message] = await once(daemon, 'message'); assert.equal(message.ready, true);
  const first = await f.connect();
  assert.equal((await call(first, 'd2l_session_status')).value.authentication, 'authenticated');
  const exited = once(daemon, 'exit'); daemon.kill('SIGKILL'); await exited; await first.close();
  const second = await f.connect();
  assert.equal((await call(second, 'd2l_session_status')).value.authentication, 'authenticated');
  assert.equal(f.writes(), 0);
});

test('browser clients share the saved profile and CLI manual login pauses and resumes existing connections',
  { skip: !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Manual login needs a graphical display.' : false }, async t => {
  const f = await setup(t, true);
  const seed = await createClient(f.config), auth = seed.auth as BrowserAuth;
  try {
    const context = await auth.open();
    await context.addCookies([
      { name: 'fixture_session', value: 'shared-session-credential', url: f.config.origin, httpOnly: true },
      { name: 'XSRF.Token', value: 'shared-csrf-credential', url: f.config.origin }
    ]);
    await auth.capture();
  } finally { await seed.close(); }
  // The owner deliberately lacks the graphical terminal's environment.
  const headlessEnv = { DISPLAY: '', WAYLAND_DISPLAY: '', XAUTHORITY: '', XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' };
  const [first, second] = await Promise.all([f.connect(f.configFile, headlessEnv), f.connect(f.configFile, headlessEnv)]);
  for (const client of [first, second]) assert.equal((await call(client, 'd2l_session_status')).value.authentication, 'authenticated');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [process.execPath, 'dist/cli.js', 'login', '--config', f.configFile].map(quote).join(' ');
  const login = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (login.exitCode === null) login.kill('SIGTERM'); });
  const exited = once(login, 'exit'); let output = '';
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('The interactive login prompt did not appear.')), 15000);
      login.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('then press Enter here.')) { clearTimeout(timer); ready(); }
      });
      login.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const paused = await call(first, 'd2l_api_read', request);
    assert.equal(paused.value.error?.code, 'AUTHENTICATION_REQUIRED');
    await assert.rejects(connectSession(f.config, f.configFile, 'login'), { code: 'CONFLICT' });
    // Confirm only a localhost fixture; no production sign-in is automated.
    login.stdin.write('\n');
    const [exitCode] = await exited; assert.equal(exitCode, 0, output);
    assert.ok(output.includes('"authentication": "authenticated"'));
    assert.ok(!output.includes('shared-session-credential')); assert.ok(!output.includes('shared-csrf-credential'));
  } finally { login.stdin.end(); if (login.exitCode === null) login.kill('SIGTERM'); }
  // The final cookie capture finishes before the CLI can report completion.
  assert.deepEqual((await call(second, 'd2l_api_read', request)).value.data, { Value: 0 });
  assert.equal(f.writes(), 0);
});
