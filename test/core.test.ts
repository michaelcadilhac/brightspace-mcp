import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, json } from './helpers.js';
import { D2LError } from '../src/errors.js';
import { chooseVersion, compareVersions, operationSchema } from '../src/catalog.js';
import { parseJson, differences } from '../src/util.js';
import type { ApiRequest } from '../src/schemas.js';

const code = (expected: string) => (e: unknown) => e instanceof D2LError && e.code === expected;

test('catalog descriptions separate documented, implemented and tenant-validated facts', async t => {
  const { client } = await fixture(t);
  assert.equal(client.catalog.search('announcements', 'read')[0]?.id, 'news.list');
  const description = client.catalog.describe('quizzes.update');
  assert.equal(description.support, 'documented'); assert.equal(description.schemaKnowledge, 'partial');
  assert.equal(description.tenantValidation, 'not-asserted'); assert.equal(description.updateBehavior, 'replace');
  assert.throws(() => client.catalog.get('a-task-specific-handler'), code('CONTRACT_UNKNOWN'));
  assert.match(client.catalog.describe('sections.paged').description, /only sections/i);
});

test('version components are numeric and selection stays inside known contracts', async t => {
  const { client, auth } = await fixture(t);
  assert.ok(compareVersions('1.100', '1.98') > 0);
  const op = client.catalog.get('news.list');
  assert.equal(chooseVersion(['1.82', '1.98', '1.100'], op), '1.98');
  assert.throws(() => chooseVersion(['1.100'], op), code('VERSION_INCOMPATIBLE'));
  auth.handler = () => json([]);
  await client.read({ operationId: 'news.list', pathParams: { orgUnitId: '123' } });
  assert.ok(auth.calls.some(c => c.url.pathname === '/d2l/api/le/1.98/123/news/'));
  const explicit = await client.read({ method: 'GET', path: '/d2l/api/le/1.100/123/news/' });
  assert.equal(explicit.complete, null); assert.match(JSON.stringify(explicit.validation), /transport-only/);
});

test('generic reads and writes across courses, grades and announcements preserve data distinctions', async t => {
  const { client, auth } = await fixture(t);
  const data = { zero: 0, nil: null, no: false, UnknownFutureField: { value: 'x', unit: 'points' } };
  auth.handler = (_u, req) => json(req.body ? parseJson(req.body) : data);
  for (const operationId of ['courses.get', 'grades.get', 'news.get']) {
    const pathParams: Record<string, string> = operationId === 'courses.get' ? { orgUnitId: '12' } : operationId === 'grades.get' ? { orgUnitId: '12', gradeObjectId: '4' } : { orgUnitId: '12', newsItemId: '5' };
    assert.deepEqual((await client.read({ operationId, pathParams })).data, data);
  }
  const requests: ApiRequest[] = [
    { operationId: 'grades.update', pathParams: { orgUnitId: '12', gradeObjectId: '4' }, body: data },
    { operationId: 'news.update', pathParams: { orgUnitId: '12', newsItemId: '5' }, body: data }
  ];
  for (const request of requests) {
    const result = await client.write({ request });
    assert.equal(result.accepted, true); assert.equal((result.verification as { status: string }).status, 'unverified');
  }
  const explicit = await client.read({ method: 'GET', path: '/d2l/api/ep/2.5/unlisted-resource' });
  assert.deepEqual(explicit.data, data); assert.equal(explicit.complete, null);
  await assert.rejects(client.read({ operationId: 'news.update', pathParams: { orgUnitId: '12', newsItemId: '5' } }), code('VALIDATION_REJECTED'));
  await assert.rejects(client.write({ request: { operationId: 'news.list', pathParams: { orgUnitId: '12' } } }), code('VALIDATION_REJECTED'));
});

test('exact numeric JSON, unknown fields, and secret redaction do not conflate null, zero or false', async t => {
  const { client, auth } = await fixture(t);
  const raw = '{"Identifier":9007199254740993123,"zero":0,"nil":null,"no":false,"unknown":[1,2],"Password":"hidden"}';
  auth.handler = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(raw) });
  const result = await client.read({ method: 'GET', path: '/d2l/api/test/1.0/value' });
  assert.deepEqual(result.data, { Identifier: '9007199254740993123', zero: 0, nil: null, no: false, unknown: [1, 2], Password: '[REDACTED]' });
  assert.equal(Object.hasOwn(result.data as object, 'missing'), false);
  assert.deepEqual((result.numericRepresentations as { data: unknown }).data, [{ pointer: '/Identifier', sourceType: 'number', raw: '9007199254740993123', representation: 'exact-decimal-string' }]);
  assert.deepEqual(differences({ x: null, y: 0 }, { x: null, y: false, z: null }), [
    { path: '/y', beforePresent: true, afterPresent: true, before: 0, after: false },
    { path: '/z', beforePresent: false, afterPresent: true, before: undefined, after: null }
  ]);
  const bodyJson = '{"Identifier":9007199254740993123,"zero":0,"nil":null,"no":false}';
  await client.write({ request: { method: 'PUT', path: '/d2l/api/test/1.0/value', bodyJson } });
  assert.equal(auth.calls.at(-1)!.request.body, bodyJson);
  await assert.rejects(client.write({ request: { method: 'PUT', path: '/d2l/api/test/1.0/value', body: { Identifier: 9007199254740993123 } } }), code('VALIDATION_REJECTED'));
});

test('catalog extension, reload and declarative read/write serialization need no new tool', async t => {
  const { client, auth, config, stateDir } = await fixture(t);
  const extension = join(stateDir, 'extension.json'); config.catalogFiles.push(extension);
  const document = { revision: 'fixture-extension.1', operations: [{
    id: 'fixture.settings.update', resource: 'fixture settings', description: 'A verified first-party fixture contract',
    method: 'PUT', path: '/d2l/api/fixture/1.0/settings', semantics: 'write', support: 'verified-first-party', sources: ['fixture:request-trace'],
    updateBehavior: 'partial', schemaKnowledge: 'complete',
    serializer: { kind: 'field-map', fields: [{ from: '/Nested/Enabled', to: '/IsEnabled' }, { from: '/Title', to: '/Name' }] },
    requestSchema: { type: 'object', required: ['IsEnabled', 'Name'], additionalProperties: false, properties: { IsEnabled: { type: 'boolean' }, Name: { type: 'string' } } }
  }] };
  await writeFile(extension, JSON.stringify(document)); await client.refreshCatalog();
  assert.equal(client.catalog.search('fixture settings').length, 1);
  auth.handler = (_url, req) => json(parseJson(req.body!));
  await client.write({ request: { operationId: 'fixture.settings.update', sourceBody: { Nested: { Enabled: false }, Title: 'Changed', ReadOnlyId: '123' } } });
  assert.deepEqual(parseJson(auth.calls.at(-1)!.request.body!), { IsEnabled: false, Name: 'Changed' });
  await assert.rejects(client.write({ request: { operationId: 'fixture.settings.update', sourceBody: { Title: '[REDACTED]' } } }), code('CONTRACT_UNKNOWN'));
  await assert.rejects(client.write({ request: { operationId: 'fixture.settings.update', body: { IsEnabled: 'false', Name: 'x' } } }), code('VALIDATION_REJECTED'));
  document.revision = 'fixture-extension.2'; await writeFile(extension, JSON.stringify(document));
  assert.ok((await client.refreshCatalog()).revisions.includes('fixture-extension.2'));
});

test('known semantically read-only POST is available only through the read tool', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = () => json({ Supported: true });
  assert.equal((await client.read({ operationId: 'versions.check', body: [{ ProductCode: 'lp', Version: '1.49' }] })).status, 200);
  await assert.rejects(client.write({ request: { method: 'POST', path: '/d2l/api/versions/check', body: [] } }), code('VALIDATION_REJECTED'));
});

test('bookmark pagination preserves filters, carries partial pages, and exports complete collections', async t => {
  const { client, auth, config } = await fixture(t, { inlineBytes: 256 });
  auth.handler = (url) => {
    assert.deepEqual(url.searchParams.getAll('sortBy'), ['OrgUnitName', '-EndDate']);
    return url.searchParams.get('bookmark') === 'b' ? json({ Items: [{ id: '3', x: 'c'.repeat(80) }], PagingInfo: { HasMoreItems: false, Bookmark: 'c' } }) : json({ Items: [{ id: '1', x: 'a'.repeat(80) }, { id: '2', x: 'b'.repeat(80) }], PagingInfo: { HasMoreItems: true, Bookmark: 'b' } });
  };
  const request: ApiRequest = { operationId: 'enrollments.mine', query: { sortBy: ['OrgUnitName', '-EndDate'] } };
  const first = await client.paginate({ request, maxItems: 1 });
  assert.equal(first.complete, false); assert.equal(first.itemCount, 1);
  const rest = await client.paginate({ continuation: first.continuation as string, maxItems: 10, exportOnly: true });
  assert.equal(rest.complete, true); assert.equal(rest.itemCount, 2);
  const slice = await client.store.result(rest.resultHandle as string, 0, 10);
  assert.deepEqual((slice.data as { id: string }[]).map(x => x.id), ['2', '3']);
  assert.equal((await stat(config.stateDir + '/records')).mode & 0o777, 0o700);
  assert.equal((await stat(rest.localPath as string)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(rest.localPath as string, 'utf8')); assert.equal(record.value.kind, 'result');
});

test('pagination page limits, failed continuation and unknown contracts report incomplete evidence', async t => {
  const { client, auth } = await fixture(t);
  let fail = false;
  auth.handler = url => {
    if (url.searchParams.has('bookmark') && fail) return json({ error: 'busy' }, 503);
    return url.searchParams.has('bookmark') ? json({ Items: [], PagingInfo: { HasMoreItems: false, Bookmark: '' } }) : json({ Items: [1, 2], PagingInfo: { HasMoreItems: true, Bookmark: '2' } });
  };
  const first = await client.paginate({ request: { operationId: 'enrollments.mine' }, maxPages: 1 });
  assert.equal(first.complete, false); assert.equal(first.pages, 1); assert.equal(first.incompleteReason, 'page-limit');
  fail = true;
  const failed = await client.paginate({ continuation: first.continuation as string });
  assert.equal(failed.complete, false); assert.equal((failed.error as { code: string }).code, 'TRANSIENT_FAILURE');
  fail = false;
  assert.equal((await client.paginate({ continuation: failed.continuation as string })).complete, true);
  const unknown = await client.paginate({ request: { method: 'GET', path: '/d2l/api/other/1.0/unknown' } });
  assert.equal(unknown.complete, false); assert.equal((unknown.error as { code: string }).code, 'CONTRACT_UNKNOWN');
});

test('ObjectListPage follows established Next links and detects missing completion markers', async t => {
  const { client, auth } = await fixture(t);
  auth.handler = url => json(url.searchParams.has('page') ? { Objects: [3], Next: null } : { Objects: [1, 2], Next: '/d2l/api/le/1.98/12/classlist/paged/?page=2' });
  const result = await client.paginate({ request: { operationId: 'classlist.paged', pathParams: { orgUnitId: '12' } } });
  assert.equal(result.complete, true); assert.deepEqual(result.data, [1, 2, 3]);
  auth.handler = () => json({ Objects: [] });
  const broken = await client.paginate({ request: { operationId: 'classlist.paged', pathParams: { orgUnitId: '12' } } });
  assert.equal(broken.complete, false); assert.equal((broken.error as { code: string }).code, 'CONTRACT_UNKNOWN');
});

test('large result retrieval is bounded, resumable and expired records cannot be read', async t => {
  const { client } = await fixture(t, { inlineBytes: 256 });
  const value = { nested: 'é'.repeat(1000), zero: 0, nil: null };
  const result = await client.store.present(value);
  let offset = 0, raw = '';
  do {
    const chunk = await client.store.result(result.resultHandle as string, offset, 10000);
    assert.ok(Buffer.byteLength(JSON.stringify(chunk.chunk)) < 256);
    raw += chunk.chunk; offset = chunk.nextOffset as number;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(raw), value);
  const path = result.localPath as string;
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.expiresAt = 0;
  await writeFile(path, JSON.stringify(saved));
  await assert.rejects(client.store.get(result.resultHandle as string), code('NOT_FOUND'));
});
