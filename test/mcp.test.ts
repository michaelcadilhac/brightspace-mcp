import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { fixture, json } from './helpers.js';

test('official SDK publishes accurate schemas/annotations and executes generic calls', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = (_url, req) => json({ Enabled: req.method === 'GET' ? false : true });
  const server = createServer(client), mcp = new Client({ name: 'fixture-client', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await mcp.connect(b);
  t.after(() => mcp.close()); t.after(() => server.close());
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 10);
  assert.equal(tools.find(t => t.name === 'd2l_api_write')!.annotations!.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'd2l_api_write')!.annotations!.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'd2l_api_read')!.annotations!.readOnlyHint, true);
  assert.ok(tools.find(t => t.name === 'd2l_api_write')!.inputSchema.properties!.verification);
  const search = await mcp.callTool({ name: 'd2l_search_operations', arguments: { query: 'announcements' } });
  assert.ok(JSON.stringify(search).includes('news.list'));
  const read = await mcp.callTool({ name: 'd2l_api_read', arguments: { method: 'GET', path: '/d2l/api/fixture/1.0/settings' } });
  assert.deepEqual((read.structuredContent as { data: unknown }).data, { Enabled: false });
  const write = await mcp.callTool({ name: 'd2l_api_write', arguments: {
    request: { method: 'PUT', path: '/d2l/api/fixture/1.0/settings', body: { Enabled: true } },
    verification: { request: { method: 'GET', path: '/d2l/api/fixture/1.0/settings' }, checks: [{ pointer: '/Enabled', equals: true }] }
  } });
  assert.equal((write.structuredContent as { accepted: boolean }).accepted, true);
  const bad = await mcp.callTool({ name: 'd2l_api_read', arguments: { method: 'GET', path: '//evil.example/x' } });
  assert.equal(bad.isError, true); assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'BOUNDARY_VIOLATION');
});
