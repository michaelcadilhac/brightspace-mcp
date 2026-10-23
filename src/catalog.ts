import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { paginationSchema } from './schemas.js';
import { D2LError } from './errors.js';
import { pointer, changeAt } from './util.js';

export const operationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/), resource: z.string(), description: z.string(),
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().startsWith('/'),
  semantics: z.enum(['read', 'write']), apiFamily: z.string().optional(),
  versions: z.object({ min: z.string(), max: z.string() }).strict().optional(),
  pathParameters: z.array(z.string()).default([]),
  querySchema: z.record(z.string(), z.unknown()).optional(),
  requestSchema: z.record(z.string(), z.unknown()).optional(),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  schemaKnowledge: z.enum(['unknown', 'partial', 'complete']).default('partial'),
  support: z.enum(['documented', 'verified-first-party']), sources: z.array(z.string()).min(1),
  permissions: z.array(z.string()).default([]),
  authentication: z.string().default('Authenticated account; browser-session support must be verified on the tenant.'),
  pagination: paginationSchema.optional(),
  updateBehavior: z.enum(['none', 'replace', 'partial', 'action', 'unknown']).default('none'),
  limitations: z.array(z.string()).default([]),
  rateLimit: z.string().default('Tenant quota; honor Retry-After. Writes are never automatically replayed.'),
  concurrency: z.string().default('Serialized per server; preconditions are advisory unless a conditional API header is supported.'),
  serializer: z.object({ kind: z.literal('field-map'), fields: z.array(z.object({ from: z.string(), to: z.string(), required: z.boolean().default(true) }).strict()) }).strict().optional()
}).strict();
export type Operation = z.infer<typeof operationSchema>;
export const catalogSchema = z.object({ revision: z.string(), operations: z.array(operationSchema) }).strict();
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
export function validateSchema(schema: Record<string, unknown> | undefined, data: unknown, location: string): string {
  if (!schema) return `${location}: transport-only; no schema known`;
  let validate;
  try { validate = ajv.compile(schema); }
  catch { throw new D2LError('CONTRACT_UNKNOWN', `The catalog ${location} schema cannot be compiled.`); }
  if (!validate(data)) throw new D2LError('VALIDATION_REJECTED', `The ${location} does not match the known schema.`,
    { validationErrors: validate.errors?.map(e => ({ path: e.instancePath, keyword: e.keyword, message: e.message })) });
  return `${location}: known schema checked (no coercion or defaults)`;
}
export function compareVersions(a: string, b: string): number {
  if (!/^\d+\.\d+$/.test(a) || !/^\d+\.\d+$/.test(b)) throw new D2LError('VERSION_INCOMPATIBLE', 'Expected a numeric major.minor version.');
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  return aa[0]! < bb[0]! ? -1 : aa[0]! > bb[0]! ? 1 : aa[1]! < bb[1]! ? -1 : aa[1]! > bb[1]! ? 1 : 0;
}
export function compatible(version: string, operation: Operation): boolean {
  return !operation.versions || (compareVersions(version, operation.versions.min) >= 0 && compareVersions(version, operation.versions.max) <= 0);
}
export function chooseVersion(supported: string[], operation: Operation, preferred?: string): string {
  const versions = supported.filter(v => /^\d+\.\d+$/.test(v) && compatible(v, operation)).sort(compareVersions);
  const version = preferred ?? versions.at(-1);
  if (!version || !versions.includes(version)) throw new D2LError('VERSION_INCOMPATIBLE', 'No advertised version matches this known contract.',
    { operationId: operation.id, supported, compatibleRange: operation.versions, requested: preferred }, 'Refresh versions or establish a compatible catalog contract; explicit unknown-contract requests remain available.');
  return version;
}
function templateRegex(template: string): RegExp {
  return new RegExp(`^${template.split(/(\{[^}]+\})/).map(p => p.startsWith('{') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}/?$`);
}
export class Catalog {
  private operations = new Map<string, Operation>();
  revisions: string[] = [];
  async load(files: string[] = []): Promise<void> {
    const bundled = new URL('../catalog/builtin.json', import.meta.url);
    const documents = await Promise.all([readFile(bundled, 'utf8'), ...files.map(f => readFile(f, 'utf8'))]);
    this.import(documents.map(raw => JSON.parse(raw)));
  }
  import(documents: unknown[]): void {
    const next = new Map<string, Operation>(), revisions: string[] = [];
    for (const document of documents) {
      const catalog = catalogSchema.parse(document); revisions.push(catalog.revision);
      for (const op of catalog.operations) {
        for (const schema of [op.querySchema, op.requestSchema, op.responseSchema]) if (schema) {
          try { ajv.compile(schema); } catch { throw new D2LError('CONTRACT_UNKNOWN', 'Invalid JSON Schema in catalog extension.', { operationId: op.id }); }
        }
        if (op.path.includes('{version}') && (!op.apiFamily || !op.versions)) throw new D2LError('CONTRACT_UNKNOWN', 'Versioned catalog operations require a family and bounded compatible versions.');
        if (op.semantics === 'read' && op.updateBehavior !== 'none') throw new D2LError('CONTRACT_UNKNOWN', 'A read operation cannot describe update behavior.');
        if (op.support === 'verified-first-party' && !op.sources.length) throw new D2LError('CONTRACT_UNKNOWN', 'First-party contracts require evidence.');
        next.set(op.id, op); // Later files intentionally override contracts by ID.
      }
    }
    this.operations = next; this.revisions = revisions;
  }
  get(id: string): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new D2LError('CONTRACT_UNKNOWN', 'This operation ID is absent from the catalog. An explicit API request is still available.', { operationId: id });
    return operation;
  }
  match(method: string, path: string): Operation | undefined {
    return [...this.operations.values()].find(op => op.method === method && templateRegex(op.path).test(path));
  }
  describe(id: string) { return { ...this.get(id), catalogRevisions: this.revisions, implementationCoverage: 'generic-transport',
    tenantValidation: 'not-asserted', permissionValidation: 'only-a-live-call-can-establish-current-access' }; }
  search(query = '', semantics?: string, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.operations.values()].filter(op => (!semantics || op.semantics === semantics) && words.every(word => JSON.stringify(op).toLowerCase().includes(word)))
      .slice(0, limit).map(op => ({ id: op.id, resource: op.resource, description: op.description, method: op.method, path: op.path,
        semantics: op.semantics, support: op.support, schemaKnowledge: op.schemaKnowledge, tenantValidation: 'not-asserted' }));
  }
  serialize(operation: Operation, input: unknown): unknown {
    if (!operation.serializer) throw new D2LError('SERVER_FEATURE_MISSING', 'No read-to-write serializer is implemented for this operation. Supply an explicit body with an understood contract.');
    if (JSON.stringify(input).includes('[REDACTED]')) throw new D2LError('CONTRACT_UNKNOWN', 'A redacted read model cannot be used to construct a replacement write.');
    let result: unknown = {};
    for (const field of operation.serializer.fields) {
      const value = pointer(input, field.from);
      if (value === undefined && field.required) throw new D2LError('CONTRACT_UNKNOWN', 'The source read model lacks a required serializer field.', { pointer: field.from });
      if (value !== undefined) result = changeAt(result, field.to, 'set', value);
    }
    return result;
  }
}
