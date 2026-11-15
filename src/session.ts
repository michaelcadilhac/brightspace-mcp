import { createConnection, createServer as createNetServer, type Socket } from 'node:net';
import { chmod, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { privateDir, type Config } from './config.js';
import { ownedClient } from './runtime.js';
import { createServer } from './server.js';
import { BrowserAuth } from './auth.js';
import { asError, D2LError, type ErrorCode } from './errors.js';
import { hash } from './util.js';

const protocol = 1;
const displayKeys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;
type Mode = 'mcp' | 'login';
type Reply = { ready?: boolean; status?: Record<string, unknown>; warning?: string; error?: ReturnType<D2LError['toJSON']> };

function fingerprint(config: Config): string {
  const credential = config.auth.provider === 'bearer' ? process.env[config.auth.tokenEnv] : undefined;
  return hash({ protocol, config, credential: credential ? hash(credential) : null });
}

export function sessionSocketPath(config: Config): string {
  const path = join(config.stateDir, 'session.sock');
  if (Buffer.byteLength(path) > 100) throw new D2LError('VALIDATION_REJECTED',
    'The state directory path is too long for a local session socket. Configure a shorter stateDir.');
  return path;
}

/** Read one bounded control line, leaving subsequent MCP bytes on the paused socket. */
function readLine(socket: Socket, timeoutMs: number, maxBytes = 16384): Promise<Reply & Record<string, unknown>> {
  return new Promise((resolveLine, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error?: unknown, value?: Reply & Record<string, unknown>) => {
      clearTimeout(timer); socket.pause();
      socket.off('data', data); socket.off('error', failed); socket.off('close', closed); socket.off('end', closed);
      if (error) reject(error); else resolveLine(value!);
    };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new D2LError('TRANSIENT_FAILURE', 'The local session connection closed. Requests are not replayed.'));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if ((end < 0 ? buffer.length : end) > maxBytes) {
        finish(new D2LError('VALIDATION_REJECTED', 'The local session control message exceeds its size limit.')); return;
      }
      if (end < 0) return;
      try {
        const value: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid control message');
        socket.pause();
        if (buffer.length > end + 1) socket.unshift(buffer.subarray(end + 1));
        finish(undefined, value as Reply & Record<string, unknown>);
      } catch { finish(new D2LError('VALIDATION_REJECTED', 'Invalid local session control message.')); }
    };
    const timer = setTimeout(() => finish(new D2LError('TRANSIENT_FAILURE', 'The local session connection timed out.')), timeoutMs);
    socket.on('data', data); socket.once('error', failed); socket.once('close', closed); socket.once('end', closed);
    if (socket.destroyed || socket.readableEnded) closed(); else socket.resume();
  });
}

async function writeLine(socket: Socket, value: unknown): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => socket.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolveWrite()));
}

function replyError(reply: Reply): void {
  if (reply.error) {
    const { code, message, nextStep, ...evidence } = reply.error;
    throw new D2LError(code as ErrorCode, message, evidence, nextStep);
  }
}

/** The SDK's newline framing works over a private Unix socket as well as stdio. */
export class SessionTransport extends StdioServerTransport {
  private closed = false;
  constructor(readonly socket: Socket) {
    super(socket, socket);
    socket.once('close', () => { void this.close(); });
  }
  override async start(): Promise<void> { await super.start(); this.socket.resume(); }
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await super.close(); this.socket.destroy();
  }
}

async function connectSocket(path: string): Promise<Socket> {
  const socket = createConnection(path);
  // Keep errors handled between the control handshake and transport attachment.
  socket.on('error', () => {});
  try {
    await new Promise<void>((connected, reject) => {
      const timer = setTimeout(() => reject(new D2LError('TRANSIENT_FAILURE', 'Connecting to the local session timed out.')), 2000);
      const failed = (error: Error) => { clearTimeout(timer); reject(error); };
      socket.once('error', failed);
      socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); socket.pause(); connected(); });
    });
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

/** Only a startup connection is retried. No MCP request is ever reconnected/replayed. */
export async function connectSession(config: Config, configFile: string, mode: Mode = 'mcp'): Promise<{ socket: Socket; reply: Reply }> {
  await privateDir(config.stateDir);
  const deadline = Date.now() + 25000;
  while (true) {
    try { return await connectReadySession(config, configFile, mode, deadline); }
    catch (error) {
      // An owner can finish idle shutdown between connect() and the handshake.
      // No MCP request has been sent, so establishing a new connection is safe.
      if (!(error instanceof D2LError) || error.code !== 'TRANSIENT_FAILURE' || Date.now() >= deadline) throw error;
      await delay(75);
    }
  }
}

async function connectReadySession(config: Config, configFile: string, mode: Mode, deadline: number): Promise<{ socket: Socket; reply: Reply }> {
  const path = sessionSocketPath(config);
  let started = false, startupError: D2LError | undefined;
  let socket: Socket;
  while (true) {
    try { socket = await connectSocket(path); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw asError(error, 'connect-session');
      if (!started) {
        started = true;
        const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'session-daemon', '--config', resolve(configFile)], {
          detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        });
        child.on('error', error => { startupError = asError(error, 'start-session'); });
        let reported = false;
        child.on('message', (message: Reply) => {
          reported = true;
          if (message.error && message.error.code !== 'PROFILE_IN_USE') {
            try { replyError(message); } catch (error) { startupError = asError(error, 'start-session'); }
          }
        });
        child.on('exit', code => {
          if (code && !reported && !startupError) startupError = new D2LError('PROFILE_IN_USE',
            'A process owns the profile but no shared session is available. Restart older D2L connections once to use the shared session.');
        });
        child.unref(); child.channel?.unref();
      }
      if (startupError) throw startupError;
      if (Date.now() >= deadline) throw new D2LError('PROFILE_IN_USE',
        'The shared session did not become available. Stop any older D2L server or login process and retry.');
      await delay(75);
    }
  }
  try {
    const displayEnv = mode === 'login' ? Object.fromEntries(displayKeys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) : undefined;
    await writeLine(socket, { protocol, fingerprint: fingerprint(config), mode, displayEnv });
    const reply = await readLine(socket, mode === 'login' ? config.timeoutMs + 40000 : 10000);
    replyError(reply);
    if (!reply.ready) throw new D2LError('CONTRACT_UNKNOWN', 'The shared session returned an invalid handshake.');
    return { socket, reply };
  } catch (error) { socket.destroy(); throw error; }
}

export async function finishLogin(socket: Socket): Promise<Reply> {
  await writeLine(socket, { confirm: true });
  const result = await readLine(socket, 180000);
  replyError(result); return result;
}

/** One browser/store/queue owner; each socket has a separate MCP protocol session. */
export async function startSession(config: Config, idleMs = 1000): Promise<{ close: () => Promise<void> }> {
  const path = sessionSocketPath(config), identity = fingerprint(config);
  const deadline = Date.now() + 20000;
  let owned: Awaited<ReturnType<typeof ownedClient>>;
  while (true) {
    try { owned = await ownedClient(config); break; }
    catch (error) {
      if (!(error instanceof D2LError) || error.code !== 'PROFILE_IN_USE' || Date.now() >= deadline) throw error;
      // Another startup won, or the previous owner is still closing its browser.
      // Leave a live owner's socket alone; only its eventual successor unlinks it.
      try {
        const existing = await connectSocket(path); existing.destroy(); throw error;
      } catch (connectionError) {
        if (connectionError === error) throw error;
        if (!['ENOENT', 'ECONNREFUSED'].includes((connectionError as NodeJS.ErrnoException).code ?? '')) throw connectionError;
      }
      await delay(75);
    }
  }
  const client = owned.client;
  const sockets = new Set<Socket>();
  let loginSocket: Socket | undefined, idle: NodeJS.Timeout | undefined, closing: Promise<void> | undefined;
  const server = createNetServer(socket => {
    if (closing) { socket.destroy(); return; }
    clearTimeout(idle); sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); scheduleIdle(); });
    void handle(socket).catch(async error => {
      await writeLine(socket, { error: client.redactor.clean(asError(error, 'shared-session').toJSON()) }).catch(() => {});
      socket.destroy();
    });
  });
  const close = () => closing ??= (async () => {
    clearTimeout(idle);
    const stopped = new Promise<void>(resolveClose => server.close(() => resolveClose()));
    for (const socket of sockets) socket.destroy();
    try {
      // Disconnected callers do not interrupt a write already in progress.
      await client.serial(async () => {}); await stopped;
    } finally { await owned.close(); }
  })();
  const scheduleIdle = () => {
    clearTimeout(idle);
    if (!sockets.size && !closing) idle = setTimeout(() => {
      // Continue accepting reconnects while a disconnected writer finishes.
      void client.serial(async () => {}).then(() => {
        if (!sockets.size) return close();
      }).catch(() => {});
    }, idleMs);
  };
  const handle = async (socket: Socket) => {
    const hello = await readLine(socket, 5000);
    if (hello.protocol !== protocol || hello.fingerprint !== identity) throw new D2LError('CONFLICT',
      'A shared session is already running with different configuration or credentials. Close its connections before changing configuration.');
    if (hello.mode === 'mcp') {
      const mcp = createServer(client, () => {
        if (loginSocket) throw new D2LError('AUTHENTICATION_REQUIRED', 'Manual D2L sign-in is in progress. Retry after the login command finishes.');
      });
      socket.once('close', () => { void mcp.close().catch(() => {}); });
      await mcp.connect(new SessionTransport(socket));
      await writeLine(socket, { ready: true });
      return;
    }
    if (hello.mode !== 'login') throw new D2LError('VALIDATION_REJECTED', 'Unknown local session connection mode.');
    if (!(client.auth instanceof BrowserAuth)) throw new D2LError('VALIDATION_REJECTED', 'Bearer authentication is configured. Supply a token from your registered provider.');
    if (loginSocket) throw new D2LError('CONFLICT', 'A manual login is already in progress.');
    const displayEnv: Record<string, string> = {};
    if (hello.displayEnv && typeof hello.displayEnv === 'object' && !Array.isArray(hello.displayEnv)) {
      for (const [key, value] of Object.entries(hello.displayEnv)) {
        if (!displayKeys.includes(key as typeof displayKeys[number]) || typeof value !== 'string' || value.includes('\0')) throw new D2LError('VALIDATION_REJECTED', 'Invalid manual login display environment.');
        displayEnv[key] = value;
      }
    }
    loginSocket = socket;
    try {
      const result = await client.serial(async () => {
        const auth = client.auth as BrowserAuth;
        if (socket.destroyed || socket.readableEnded) throw new D2LError('TRANSIENT_FAILURE', 'The manual login connection closed before sign-in could start.');
        try {
          await auth.close();
          const context = await auth.open(false, displayEnv);
          const url = new URL(config.auth.provider === 'browser' ? config.auth.loginPath : '/', config.origin);
          if (url.origin !== config.origin || url.username || url.password) throw new D2LError('BOUNDARY_VIOLATION', 'The initial login URL must belong to the configured tenant.');
          const page = context.pages()[0] ?? await context.newPage();
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }).catch(() => {});
          await writeLine(socket, { ready: true });
          // Only the explicit interactive CLI can confirm; MCP exposes no login/browser tool.
          const confirmation = await readLine(socket, 24 * 60 * 60 * 1000);
          if (confirmation.confirm !== true) throw new D2LError('VALIDATION_REJECTED', 'Manual login was not confirmed.');
          await auth.capture();
          const warning = auth.captureWarning(), status = await client.sessionStatus();
          return { status: client.redactor.clean(status), warning };
        } finally { await auth.close(); }
      });
      loginSocket = undefined;
      await writeLine(socket, result); socket.end();
    } finally { loginSocket = undefined; }
  };
  try {
    // Only the kernel-lock owner may remove a stale socket; never remove owner.lock.
    try {
      const prior = await lstat(path);
      if (!prior.isSocket() || prior.uid !== process.getuid?.()) throw new D2LError('LOCAL_PERMISSION_DENIED', 'The local session socket path is not an owned socket.');
      await rm(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise<void>((listening, reject) => { server.once('error', reject); server.listen(path, listening); });
    await chmod(path, 0o600); scheduleIdle();
    return { close };
  } catch (error) { await close(); throw error; }
}
