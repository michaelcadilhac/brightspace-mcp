import { D2LError, asError } from './errors.js';

/** Preserve the failing phase and safe runtime codes without including credential-bearing logs. */
export function authenticationError(error: unknown, stage: string): D2LError {
  if (error instanceof D2LError) return error;
  const systemCode = error && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' && /^(?:EACCES|EPERM|ENOENT|ENOSPC|EROFS|EIO|ERR_USE_AFTER_CLOSE|ABORT_ERR)$/.test(error.code)
    ? error.code : undefined;
  const closed = error instanceof Error && /(?:Target page, context or browser|Browser context|Browser|Target).*closed/i.test(error.message);
  if (closed) return new D2LError('AUTHENTICATION_REQUIRED', 'The dedicated browser closed before authentication could be captured.',
    { stage, cause: 'BROWSER_CLOSED' }, 'Run login again, leave the browser open after signing in, and press Enter in the terminal.');
  if (stage === 'login-confirmation' && systemCode) return new D2LError('AUTHENTICATION_REQUIRED', 'The login confirmation terminal input was closed or interrupted.',
    { stage, systemCode }, 'Run login in an interactive terminal, leave the browser open, and press Enter after sign-in finishes.');
  if (systemCode && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'ENOENT'].includes(systemCode)) {
    return asError(error, stage);
  }
  return new D2LError('INTERNAL_ERROR', `Authentication failed during ${stage}.`,
    { stage, systemCode, cause: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'AUTHENTICATION_RUNTIME_ERROR' },
    'Keep the login browser open and inspect the reported phase; no authentication secrets or raw browser logs are included.');
}
