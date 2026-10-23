import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticationError } from '../src/auth-errors.js';
import { D2LError, asError } from '../src/errors.js';

test('authentication diagnostics preserve safe failure phases and filesystem codes without secrets', () => {
  const error = Object.assign(new Error('permission denied Cookie: private-session; password=private-password'), { code: 'EACCES' });
  const result = authenticationError(error, 'save-session-cookies');
  assert.equal(result.evidence.stage, 'save-session-cookies');
  assert.equal(result.evidence.systemCode, 'EACCES');
  assert.equal(result.code, 'LOCAL_PERMISSION_DENIED');
  assert.ok(!JSON.stringify(result).includes('private-session'));
  assert.ok(!JSON.stringify(result).includes('private-password'));
});

test('local permission, I/O, and unexpected errors do not imply a missing API capability', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOTDIR']) {
    const error = asError(Object.assign(new Error('Cookie: hidden; password=hidden'), { code }), 'prepare-private-directory');
    assert.equal(error.code, ['EACCES', 'EPERM'].includes(code) ? 'LOCAL_PERMISSION_DENIED' : 'LOCAL_IO_ERROR');
    assert.equal(error.evidence.systemCode, code); assert.equal(error.evidence.stage, 'prepare-private-directory');
    assert.ok(!JSON.stringify(error).includes('hidden'));
  }
  const unknown = asError(new TypeError('Bearer private-token'), 'cli-startup');
  assert.equal(unknown.code, 'INTERNAL_ERROR'); assert.equal(unknown.evidence.errorType, 'TypeError');
  assert.ok(!JSON.stringify(unknown).includes('private-token'));
});

test('closed browser and interrupted terminal are authentication-recovery states', () => {
  assert.equal(authenticationError(new Error('browserContext.cookies: Target page, context or browser has been closed'), 'capture-cookies').code, 'AUTHENTICATION_REQUIRED');
  const terminal = authenticationError(Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' }), 'login-confirmation');
  assert.equal(terminal.code, 'AUTHENTICATION_REQUIRED'); assert.equal(terminal.evidence.stage, 'login-confirmation');
  const original = new D2LError('PROFILE_IN_USE', 'Already owned');
  assert.equal(authenticationError(original, 'capture-cookies'), original);
});
