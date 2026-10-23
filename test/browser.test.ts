import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveChromiumExecutable, browserLaunchError } from '../src/browser.js';
import { D2LError } from '../src/errors.js';

test('browser resolution prefers explicit config, then a bundled browser, then system Chromium', async t => {
  const root = await mkdtemp(join(tmpdir(), 'd2l-browser-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configured = join(root, 'configured'), bundled = join(root, 'bundled'), system = join(root, 'system');
  for (const path of [configured, bundled, system]) await writeFile(path, '#!/bin/sh\n', { mode: 0o700 });
  assert.deepEqual(await resolveChromiumExecutable({ configured, bundled, systemPaths: [system] }), { path: configured, source: 'configured' });
  assert.deepEqual(await resolveChromiumExecutable({ bundled, systemPaths: [system] }), { path: bundled, source: 'playwright' });
  await rm(bundled);
  assert.deepEqual(await resolveChromiumExecutable({ bundled, systemPaths: [join(root, 'absent'), system] }), { path: system, source: 'system' });
  await assert.rejects(resolveChromiumExecutable({ configured: join(root, 'absent'), bundled, systemPaths: [system] }),
    (e: unknown) => e instanceof D2LError && e.evidence.startupReason === 'INVALID_BROWSER_EXECUTABLE');
});

test('missing and non-executable browsers produce actionable errors without launching anything', async t => {
  const root = await mkdtemp(join(tmpdir(), 'd2l-browser-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'not-executable'); await writeFile(path, 'fixture', { mode: 0o600 });
  await assert.rejects(resolveChromiumExecutable({ bundled: path, systemPaths: [] }), (e: unknown) => {
    assert.ok(e instanceof D2LError); assert.equal(e.evidence.startupReason, 'BROWSER_NOT_INSTALLED');
    assert.match(e.nextStep!, /auth.executablePath/); return true;
  });
});

test('startup errors distinguish profile ownership, display access, libraries, and process restrictions without raw logs', () => {
  const browser = { path: '/usr/bin/chromium', source: 'system' } as const;
  for (const [message, reason] of [
    ['Failed to create a ProcessSingleton for your profile', 'BROWSER_PROFILE_IN_USE'],
    ['Missing X server or $DISPLAY', 'DISPLAY_UNAVAILABLE'],
    ['error while loading shared libraries: libnss3.so: cannot open shared object file', 'MISSING_BROWSER_LIBRARY'],
    ['Failed to move to new namespace: Operation not permitted', 'BROWSER_PROCESS_RESTRICTED'],
    ['Unrecognized failure; Cookie: private-session; access_token=private-token', 'BROWSER_STARTUP_FAILED']
  ]) {
    const error = browserLaunchError(new Error(message), browser, false);
    assert.equal(error.evidence.startupReason, reason);
    assert.ok(!JSON.stringify(error.toJSON()).includes('private-session'));
    assert.ok(!JSON.stringify(error.toJSON()).includes('private-token'));
  }
  assert.equal(browserLaunchError(new Error('ProcessSingleton'), browser, false).code, 'PROFILE_IN_USE');
  assert.equal(browserLaunchError(new Error('Operation not permitted'), browser, true).code, 'LOCAL_PERMISSION_DENIED');
  assert.equal(browserLaunchError(new Error('Unexpected startup failure'), browser, true).code, 'INTERNAL_ERROR');
});
