import { parse, isSafeNumber } from 'lossless-json';
import { createHash } from 'node:crypto';
import { D2LError } from './errors.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface NumericRepresentation { pointer: string; sourceType: 'number'; raw: string; representation: 'exact-decimal-string' }
class ExactNumber { constructor(readonly raw: string) {} }
export function parseDocument(raw: string): { data: Json; numericRepresentations: NumericRepresentation[] } {
  const parsed = parse(raw, undefined, value => isSafeNumber(value) ? Number(value) : new ExactNumber(value));
  const numericRepresentations: NumericRepresentation[] = [];
  function convert(value: unknown, path: string): Json {
    if (value instanceof ExactNumber) {
      numericRepresentations.push({ pointer: path, sourceType: 'number', raw: value.raw, representation: 'exact-decimal-string' });
      return value.raw;
    }
    if (Array.isArray(value)) return value.map((v, i) => convert(v, `${path}/${i}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
      [key, convert(v, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)]));
    return value as Json;
  }
  return { data: convert(parsed, ''), numericRepresentations };
}
export function parseJson(raw: string): Json {
  return parseDocument(raw).data;
}
export function assertSafeNumbers(value: unknown): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new D2LError('VALIDATION_REJECTED', 'Unsafe numeric input. Pass identifiers as strings or send an exact bodyJson.');
  }
  if (value && typeof value === 'object') for (const item of Object.values(value)) assertSafeNumbers(item);
}
const secretKey = /password|cookie|authorization|(?:^|[-_.])(?:csrf|xsrf|token|secret)(?:$|[-_.])|access_?token|refresh_?token|client_?secret/i;
const credentialCookie = /auth|session|csrf|xsrf|token|ticket|saml|nonce|credential|jwt|login/i;
const referencedValues = new Set(['raw', 'value', 'before', 'after', 'actual', 'equals']);
function sensitivePointer(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('/') && value.slice(1).split('/')
    .some(part => secretKey.test(part.replace(/~1/g, '/').replace(/~0/g, '~')));
}
export class Redactor {
  private secrets = new Set<string>();
  // Short values collide with ordinary IDs, versions, dates, and handles. They are
  // protected by field/header context, never by unrestricted substring replacement.
  add(secret: string | undefined) { if (secret && secret.length >= 12) this.secrets.add(secret); }
  addCookie(cookie: { name: string; value: string; httpOnly: boolean }) {
    if (cookie.httpOnly || credentialCookie.test(cookie.name)) this.add(cookie.value);
  }
  text(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(Bearer|Basic)\s+[^\s"<>]+/gi, '$1 [REDACTED]')
      .replace(/(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
      .replace(/((?:XSRF\.Token|X-Csrf-Token|access_token|refresh_token|password)\s*[=:]\s*)[^\s&"<>]+/gi, '$1[REDACTED]');
  }
  clean<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T;
    if (Array.isArray(value)) return value.map(v => this.clean(v)) as T;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      // Numeric provenance, state checks, and diffs refer to fields by pointer;
      // their value slots must carry the same protection as the original field.
      const sensitiveReference = sensitivePointer(object.pointer) || sensitivePointer(object.path);
      const sensitiveName = typeof object.name === 'string' && secretKey.test(object.name);
      return Object.fromEntries(Object.entries(object).map(([key, v]) => [key,
        secretKey.test(key) || (sensitiveReference && referencedValues.has(key)) || (sensitiveName && key === 'value')
          ? '[REDACTED]' : this.clean(v)])) as T;
    }
    return value;
  }
}
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/')) throw new D2LError('VALIDATION_REJECTED', 'Expected a JSON pointer.');
  let result: unknown = value;
  for (const part of path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, part)) return undefined;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}
export function changeAt(value: unknown, path: string, action: 'omit' | 'set', replacement?: unknown): unknown {
  const clone = structuredClone(value);
  if (!path.startsWith('/') || path === '/') throw new D2LError('VALIDATION_REJECTED', 'A field pointer is required.');
  const parts = path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new D2LError('VALIDATION_REJECTED', 'Unsafe field pointer.');
  const key = parts.pop()!;
  const parent = parts.reduce<unknown>((v, p) => v && typeof v === 'object' && Object.hasOwn(v, p) ? (v as Record<string, unknown>)[p] : undefined, clone);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new D2LError('VALIDATION_REJECTED', 'Field parent is not an object.');
  if (action === 'omit') delete (parent as Record<string, unknown>)[key];
  else (parent as Record<string, unknown>)[key] = replacement;
  return clone;
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
export function differences(before: unknown, after: unknown, path = ''): unknown[] {
  if (equal(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => differences(
      (before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k], `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [{ path, beforePresent: before !== undefined, afterPresent: after !== undefined, before, after }];
}
