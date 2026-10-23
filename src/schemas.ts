import { z } from 'zod';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const querySchema = z.record(z.string(), z.union([scalar, z.array(scalar)]));
export const paginationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), itemsPointer: z.string().optional() }).strict(),
  z.object({ kind: z.literal('bookmark'), itemsPointer: z.string(), hasMorePointer: z.string(),
    cursorPointer: z.string(), queryParameter: z.string().default('bookmark'), source: z.string() }).strict(),
  z.object({ kind: z.literal('next-url'), itemsPointer: z.string(), nextPointer: z.string(), source: z.string() }).strict()
]);
export const requestSchema = z.object({
  operationId: z.string().optional(),
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  path: z.string().optional(),
  apiOrigin: z.string().optional().describe('An explicitly configured API origin; tenant origin is the default.'),
  version: z.string().optional(),
  pathParams: z.record(z.string(), scalar).optional(),
  query: querySchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  bodyJson: z.string().optional().describe('Exact JSON, useful for numeric identifiers beyond JavaScript precision.'),
  sourceBody: z.unknown().optional().describe('Read model for the catalog field-map serializer, when implemented. Never pass redacted or incomplete read models.'),
  responseType: z.enum(['json', 'text', 'binary']).default('json'),
  pagination: paginationSchema.optional().describe('Established contract for an explicit request; include its evidence source.')
}).strict();
export type ApiRequest = z.input<typeof requestSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export const checkSchema = z.object({ pointer: z.string(), equals: z.unknown(), exists: z.boolean().optional() }).strict();
export const observationSchema = z.object({ request: requestSchema, checks: z.array(checkSchema).default([]),
  sha256: z.string().optional() }).strict();
export const writeSchema = z.object({
  request: requestSchema,
  preview: z.boolean().default(false),
  before: observationSchema.optional(),
  verification: observationSchema.optional(),
  compatibility: z.array(z.object({
    pointer: z.string(), rejectionPattern: z.string().min(3).max(200),
    omit: z.boolean().default(true), defaultValue: z.unknown().optional(),
    allowNullTransition: z.boolean().default(false), source: z.string().min(1)
  }).strict()).max(10).default([])
}).strict();
export type WriteInput = z.input<typeof writeSchema>;
export const paginateSchema = z.object({ request: requestSchema.optional(), continuation: z.string().optional(),
  maxPages: z.number().int().min(1).max(100).default(10),
  maxItems: z.number().int().min(1).max(100000).default(10000),
  exportOnly: z.boolean().default(false)
}).strict();
export type PaginateInput = z.input<typeof paginateSchema>;
