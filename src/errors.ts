export type ErrorCode = 'AUTHENTICATION_REQUIRED' | 'PERMISSION_DENIED' | 'CSRF_REQUIRED' |
  'VALIDATION_REJECTED' | 'VERSION_INCOMPATIBLE' | 'DATA_INCOMPLETE' | 'CONTRACT_UNKNOWN' |
  'SERVER_FEATURE_MISSING' | 'API_CAPABILITY_UNAVAILABLE' | 'TRANSIENT_FAILURE' |
  'CONFLICT' | 'UNCERTAIN_OUTCOME' | 'BOUNDARY_VIOLATION' | 'PROFILE_IN_USE' | 'NOT_FOUND' |
  'LOCAL_PERMISSION_DENIED' | 'LOCAL_IO_ERROR' | 'INTERNAL_ERROR';

export class D2LError extends Error {
  constructor(public code: ErrorCode, message: string, public evidence: Record<string, unknown> = {},
    public nextStep?: string) { super(message); }
  toJSON() { return { code: this.code, message: this.message, ...this.evidence, nextStep: this.nextStep }; }
}

export function asError(error: unknown, stage = 'operation'): D2LError {
  if (error instanceof D2LError) return error;
  // Raw exception messages/stacks can contain browser logs, cookies, or payloads.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'EACCES' || code === 'EPERM') return new D2LError('LOCAL_PERMISSION_DENIED',
    'Local filesystem or process access was denied.', { stage, systemCode: code },
    'Check local ownership and permissions. In a restricted runner, allow access to the configured state directory and browser subprocesses; signing in again will not resolve this restriction.');
  if (typeof code === 'string' && /^(?:ENOENT|EEXIST|ENOTDIR|EISDIR|EROFS|ENOSPC|EIO|EMFILE|ENFILE)$/.test(code)) {
    return new D2LError('LOCAL_IO_ERROR', code === 'EROFS' ? 'The local filesystem is read-only.' : 'A local file or directory operation failed.', { stage, systemCode: code },
      code === 'EROFS' ? 'Allow this process to write to the configured private state directory, or run it in a terminal with that access. Signing in again will not resolve a read-only filesystem.' :
        'Check the configured paths, filesystem availability, and available disk space.');
  }
  const errorType = error instanceof Error && /^(?:Error|TypeError|RangeError|SyntaxError|TimeoutError)$/.test(error.name) ? error.name : undefined;
  return new D2LError('INTERNAL_ERROR', 'An unexpected local error interrupted the operation.', { stage, errorType },
    'Inspect the reported operation stage. This error does not identify a missing D2L API feature.');
}
