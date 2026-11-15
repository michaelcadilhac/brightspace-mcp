import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { D2LClient } from './client.js';
import { asError, D2LError } from './errors.js';
import { requestSchema, writeSchema, paginateSchema, checkSchema } from './schemas.js';

export function createServer(client: D2LClient, beforeCall?: () => void): McpServer {
  const server = new McpServer({ name: 'brightspace-mcp', version: '0.1.0' }, {
    instructions: 'General Brightspace API access. Discover and inspect contracts, then compose explicit reads and writes. Resolve policy and scope client-side. A successful HTTP response or page traversal does not establish a whole task is complete. Never use UI automation as a fallback.'
  });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const run = async (action: () => Promise<unknown>) => {
    try {
      beforeCall?.();
      const value = client.redactor.clean(await client.serial(action));
      const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) {
      const normalized = error instanceof z.ZodError ? new D2LError('VALIDATION_REJECTED', 'Invalid tool input.') : asError(error);
      const structuredContent = { error: client.redactor.clean(normalized.toJSON()) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
    }
  };
  server.registerTool('d2l_session_status', { description: 'Verify the current tenant account by API. On an authentication challenge, try one background browser session refresh and recheck before requiring manual login. Return a sanitized diagnostic request ID and recovery outcome.', inputSchema: z.object({}).strict(), annotations: read }, () => run(() => client.sessionStatus()));
  server.registerTool('d2l_api_versions', { description: 'Discover API family versions. Contract-compatible selection is numeric and bounded per operation.', inputSchema: z.object({ refresh: z.boolean().default(false) }).strict(), annotations: read }, ({ refresh }) => run(() => client.versions(refresh)));
  server.registerTool('d2l_search_operations', { description: 'Search the extensible descriptive catalog. Absence here does not prevent explicit API invocation.', inputSchema: z.object({ query: z.string().default(''), semantics: z.enum(['read', 'write']).optional(), limit: z.number().int().min(1).max(100).default(30) }).strict(), annotations: { ...read, openWorldHint: false } }, ({ query, semantics, limit }) => run(async () => ({ operations: client.catalog.search(query, semantics, limit), revisions: client.catalog.revisions })));
  server.registerTool('d2l_describe_operation', { description: 'Inspect a contract, sources, permissions, versions, pagination, schema gaps, and validation coverage.', inputSchema: z.object({ operationId: z.string() }).strict(), annotations: { ...read, openWorldHint: false } }, ({ operationId }) => run(async () => client.catalog.describe(operationId)));
  server.registerTool('d2l_refresh_catalog', { description: 'Reload configured local catalog extensions without adding tools or handlers; does not probe the tenant.', inputSchema: z.object({}).strict(), annotations: { ...read, openWorldHint: false } }, () => run(() => client.refreshCatalog()));
  server.registerTool('d2l_api_read', { description: 'Invoke a catalog read or explicit tenant-relative API read. Return values, retrieval evidence, validation level, coverage, and continuation when known.', inputSchema: requestSchema, annotations: read }, input => run(() => client.read(input)));
  server.registerTool('d2l_api_write', { description: 'Apply an explicit API mutation or preview it. Supports before-state assertions, conditional headers, attributed compatibility policies, and read-back verification. No pedagogical policy or second confirmation is inferred. Unknown/timeout outcomes are never replayed.', inputSchema: writeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, input => run(() => client.write(input)));
  server.registerTool('d2l_api_paginate', { description: 'Collect established endpoint pages with bounded pages/items, expiring continuation, incomplete results, and optional private export. Does not establish full roster visibility or snapshot consistency.', inputSchema: paginateSchema, annotations: read }, input => run(() => client.paginate(input)));
  server.registerTool('d2l_get_request_status', { description: 'Read a sanitized technical audit and optionally reconcile current API state. A reconciliation read never replays a write or proves which request caused the current state.', inputSchema: z.object({ requestId: z.string(), reconcile: z.object({ request: requestSchema, checks: z.array(checkSchema).default([]), sha256: z.string().optional() }).strict().optional() }).strict(), annotations: read }, ({ requestId, reconcile }) => run(() => client.requestStatus(requestId, reconcile)));
  server.registerTool('d2l_get_result', { description: 'Retrieve bounded slices or JSON-text chunks of an exported result. Follow nextOffset, concatenate text chunks before parsing, or use the private local export.', inputSchema: z.object({ resultHandle: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(10000).default(100) }).strict(), annotations: { ...read, openWorldHint: false } }, ({ resultHandle, offset, limit }) => run(() => client.store.result(resultHandle, offset, limit)));
  return server;
}
