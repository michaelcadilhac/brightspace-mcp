import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { privateDir } from './config.js';
import { D2LError } from './errors.js';

/** Linux kernel flock, with automatic release on process/pipe closure. Never unlink a flock file. */
export class ProfileLock {
  private child?: ChildProcessWithoutNullStreams;
  async acquire(stateDir: string): Promise<void> {
    await privateDir(stateDir);
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73',
      join(stateDir, 'owner.lock'), process.execPath, '-e',
      'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'], { stdio: 'pipe' });
    this.child = child;
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-1000); });
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new D2LError('SERVER_FEATURE_MISSING', 'Linux flock is required (install util-linux).')));
      child.once('exit', code => reject(new D2LError(code === 73 ? 'PROFILE_IN_USE' : 'SERVER_FEATURE_MISSING',
        code === 73 ? 'Another server or login command owns this state directory. Stop it before starting another owner.' : 'Unable to acquire the profile lock.', { exitCode: code, diagnostics })));
      child.stdout.once('data', () => resolve());
    });
  }
  async release(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.stdin.end(); });
  }
}
