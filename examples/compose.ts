/** Runs entirely against fixtures by default. --config explicitly selects live, read-only stdio calls. */
import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeConfig } from '../src/config.js';
import { createClient } from '../src/runtime.js';
import { createServer } from '../src/server.js';
import type { AuthProvider } from '../src/auth.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, course: { type: 'string', default: '123' }, since: { type: 'string', default: '2026-01-01T00:00:00.000Z' } } });
const mcp = new Client({ name: 'd2l-composition-example', version: '1.0' });
let cleanup: () => Promise<void>;
if (values.config) {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli.js'), 'serve', '--config', resolve(values.config)], stderr: 'inherit' }));
  cleanup = () => mcp.close();
} else {
  const stateDir = await mkdtemp(join(tmpdir(), 'd2l-demo-'));
  const auth: AuthProvider = { kind: 'fixture', close: async () => {}, send: async url => {
    const data = url.pathname.endsWith('/whoami') ? { Identifier: '42', FirstName: 'Fixture' }
      : url.pathname.endsWith('/versions/') ? [{ ProductCode: 'lp', SupportedVersions: ['1.49'] }, { ProductCode: 'le', SupportedVersions: ['1.82'] }]
      : url.pathname.includes('myenrollments') ? { Items: [{ OrgUnit: { Id: '123', Name: 'Fixture course' } }], PagingInfo: { HasMoreItems: false, Bookmark: '123' } }
      : url.pathname.endsWith('/courses/schema') ? [{ Type: { Id: '5', Name: 'Semester' } }]
      : [{ Id: '7', Title: 'Fixture announcement', RequestedSince: url.searchParams.get('since') }];
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(data)) };
  } };
  const client = await createClient(normalizeConfig({ origin: 'https://fixture.example.edu', stateDir,
    auth: { provider: 'bearer' }, catalogFiles: [resolve('examples/catalog-extension.json')] }), auth);
  const server = createServer(client), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await mcp.connect(b);
  cleanup = async () => { await mcp.close(); await server.close(); await client.close(); await rm(stateDir, { recursive: true, force: true }); };
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await mcp.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent as Record<string, unknown>;
}
try {
  console.log(JSON.stringify({ mode: values.config ? 'live-read-only' : 'fixture' }));
  await call('d2l_session_status', {});
  const discovered = await call('d2l_search_operations', { query: 'enrollments', semantics: 'read' });
  console.log(JSON.stringify({ discovered }));
  const enrollments = await call('d2l_api_paginate', { request: { operationId: 'enrollments.mine' }, maxPages: 10, maxItems: 1000 });
  console.log(JSON.stringify({ enrollments }));
  await call('d2l_describe_operation', { operationId: 'news.list' });
  for (const since of [values.since, '2025-01-01T00:00:00.000Z']) {
    const announcements = await call('d2l_api_read', { operationId: 'news.list', pathParams: { orgUnitId: values.course }, query: { since } });
    console.log(JSON.stringify({ course: values.course, since, announcements }));
  }
  // The additional catalog operation uses the same tool. The live example demonstrates the uncataloged path instead.
  const constraints = await call('d2l_api_read', values.config
    ? { method: 'GET', path: '/d2l/api/lp/1.49/courses/schema', pagination: { kind: 'none', itemsPointer: '' } }
    : { operationId: 'courses.schema' });
  console.log(JSON.stringify({ constraints }));
} finally { await cleanup(); }
