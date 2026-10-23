import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { Redactor } from '../src/util.js';
import { fixture, json } from './helpers.js';

test('short cookie-like values preserve versions, identifiers, dates, and handles', () => {
  const redactor = new Redactor();
  for (const value of ['1', '0', 'true', 'en-US']) redactor.add(value);
  const data = { version: '1.49', Identifier: '1', date: '2026-10-23T01:00:00Z',
    continuation: '11111111-1111-4111-8111-111111111111', timezone: 'America/Chicago' };
  assert.deepEqual(redactor.clean(data), data);
  assert.equal(redactor.text('Authorization: Bearer 1'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redactor.text('Cookie: flag=1; session=0\nversion=1.49'), 'Cookie: [REDACTED]\nversion=1.49');
  assert.equal(redactor.clean({ Password: '1', Cookie: 'flag=1', 'X-Csrf-Token': '0' }).Password, '[REDACTED]');
});

test('transport preserves internal values while presentation and exports sanitize credentials', async t => {
  const { client, auth } = await fixture(t);
  const credential = 'opaque-fixture-credential';
  client.redactor.add(credential);
  const data = { Password: 'short', x: credential, Identifier: '1', zero: 0, no: false };
  auth.handler = () => json(data, 200, { etag: credential });
  const wire = await client.transport.request(new URL(client.config.origin + '/d2l/api/fixture/1.0/value'), { method: 'GET', headers: {} }, true);
  assert.deepEqual(wire.data, data);
  assert.equal(wire.headers.etag, credential);
  const shown = await client.read({ method: 'GET', path: '/d2l/api/fixture/1.0/value' });
  assert.deepEqual(shown.data, { ...data, Password: '[REDACTED]', x: '[REDACTED]' });
  assert.deepEqual(shown.headers, { etag: '[REDACTED]' });
  const exported = await client.store.present(wire.data, true);
  const stored = await readFile(exported.localPath as string, 'utf8');
  assert.ok(!stored.includes(credential)); assert.ok(!stored.includes('short'));
});

test('secret-field evidence stays redacted after internal parsing and state checks', async t => {
  const { client, auth, stateDir } = await fixture(t);
  auth.handler = () => ({ status: 200, headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"Password":9007199254740993123,"Identifier":9007199254740993124}') });
  const read = await client.read({ method: 'GET', path: '/d2l/api/fixture/1.0/value' });
  assert.ok(!JSON.stringify(read).includes('9007199254740993123'));
  assert.ok(JSON.stringify(read).includes('9007199254740993124'));
  const metadata = client.redactor.clean([
    { path: '/nested/Password', before: 'short-before', after: 'short-after', beforePresent: true },
    { pointer: '/nested/XSRF.Token', actual: 'short-actual', equals: 'short-expected', matches: true },
    { name: 'Cookie', value: 'flag=1' },
    { pointer: '/Identifier', actual: '1', equals: '1', matches: true }
  ]);
  assert.deepEqual(metadata, [
    { path: '/nested/Password', before: '[REDACTED]', after: '[REDACTED]', beforePresent: true },
    { pointer: '/nested/XSRF.Token', actual: '[REDACTED]', equals: '[REDACTED]', matches: true },
    { name: 'Cookie', value: '[REDACTED]' },
    { pointer: '/Identifier', actual: '1', equals: '1', matches: true }
  ]);
  let password = 'one';
  auth.handler = (_url, request) => {
    if (request.method === 'PUT') password = 'two';
    return json({ Password: password });
  };
  const request = { method: 'GET' as const, path: '/d2l/api/fixture/1.0/value' };
  const write = await client.write({
    request: { ...request, method: 'PUT', body: { Password: 'two' } },
    before: { request, checks: [{ pointer: '/Password', equals: 'one' }] },
    verification: { request, checks: [{ pointer: '/Password', equals: 'two' }] }
  });
  assert.equal(write.accepted, true);
  assert.equal((write.verification as { status: string }).status, 'verified');
  const audit = await readFile(`${stateDir}/records/${write.requestId}.json`, 'utf8');
  for (const raw of [JSON.stringify(write), audit]) {
    assert.ok(!raw.includes('"one"')); assert.ok(!raw.includes('"two"'));
  }
});

test('MCP versioned reads and stored continuations work with a synthetic flag cookie', async t => {
  const { client, auth } = await fixture(t);
  client.redactor.add('1');
  client.redactor.add('actual-session-credential');
  // Deterministic handles ensure the flag appears in every handle under test.
  let id = 0;
  client.store.id = () => `11111111-1111-4111-8111-${String(++id).padStart(12, '0')}`;
  auth.handler = url => {
    const last = url.searchParams.get('bookmark') === '1';
    return json({ Items: [{ Identifier: last ? '101' : '1', Password: 'short-password', echo: 'actual-session-credential' }],
      PagingInfo: { HasMoreItems: !last, Bookmark: '1' } });
  };
  const server = createServer(client), mcp = new Client({ name: 'redaction-regression', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await mcp.connect(b);
  t.after(() => mcp.close()); t.after(() => server.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const raw = JSON.stringify(result);
    assert.ok(!raw.includes('actual-session-credential')); assert.ok(!raw.includes('short-password'));
    return result.structuredContent as Record<string, unknown>;
  };
  const versions = await call('d2l_api_versions');
  assert.ok(JSON.stringify(versions).includes('1.49'));
  const description = await call('d2l_describe_operation', { operationId: 'enrollments.mine' });
  assert.deepEqual(description.versions, { min: '1.49', max: '1.59' });
  const first = await call('d2l_api_paginate', { request: { operationId: 'enrollments.mine' }, maxPages: 1, maxItems: 10 });
  assert.equal(first.complete, false); assert.equal(first.pages, 1); assert.equal(first.itemCount, 1);
  assert.equal((first.data as { Identifier: string }[])[0]!.Identifier, '1');
  assert.match((first.retrievals as { retrievedAt: string }[])[0]!.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  await call('d2l_get_request_status', { requestId: first.requestId });
  const rest = await call('d2l_api_paginate', { continuation: first.continuation, exportOnly: true });
  assert.equal(rest.complete, true); assert.equal(rest.itemCount, 1);
  const exported = await call('d2l_get_result', { resultHandle: rest.resultHandle });
  assert.deepEqual(exported.data, [{ Identifier: '101', Password: '[REDACTED]', echo: '[REDACTED]' }]);
  const record = await readFile(rest.localPath as string, 'utf8');
  assert.ok(!record.includes('actual-session-credential')); assert.ok(!record.includes('short-password'));
  assert.ok(auth.calls.some(c => c.url.pathname === '/d2l/api/lp/1.59/enrollments/myenrollments/' && c.url.searchParams.get('bookmark') === '1'));
});
