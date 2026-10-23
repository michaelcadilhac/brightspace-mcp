import { z } from 'zod';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, chmod, writeFile } from 'node:fs/promises';
import { D2LError, asError } from './errors.js';

const routeSchema = z.object({ origin: z.string().url(), prefixes: z.array(z.string().startsWith('/')).min(1),
  source: z.string().min(1) }).strict();
export const configSchema = z.object({
  origin: z.string().url(),
  timezone: z.string().default('America/Chicago'),
  stateDir: z.string().optional(),
  catalogFiles: z.array(z.string()).default([]),
  apiRoutes: z.array(routeSchema).default([]),
  auth: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('browser'), csrfStorageKey: z.string().default('XSRF.Token'),
      csrfHeader: z.string().default('X-Csrf-Token'), csrfCookieName: z.string().optional(),
      csrfTokenEndpoint: z.object({ path: z.string(), pointer: z.string(), source: z.string().min(1) }).strict().optional(),
      executablePath: z.string().optional(), loginPath: z.string().default('/'),
      whoamiVersion: z.string().regex(/^\d+\.\d+$/).default('1.49') }).strict(),
    z.object({ provider: z.literal('bearer'), tokenEnv: z.string().default('D2L_ACCESS_TOKEN'),
      whoamiVersion: z.string().regex(/^\d+\.\d+$/).default('1.49') }).strict()
  ]).default({ provider: 'browser', csrfStorageKey: 'XSRF.Token', csrfHeader: 'X-Csrf-Token', loginPath: '/', whoamiVersion: '1.49' }),
  retentionHours: z.number().min(0.01).max(8760).default(24),
  inlineBytes: z.number().int().min(256).max(1000000).default(48000),
  maxResponseBytes: z.number().int().min(1024).max(100000000).default(20000000),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
  readRetries: z.number().int().min(0).max(4).default(2),
  maxRetryDelayMs: z.number().int().min(0).max(60000).default(10000),
  allowHttpLocalhost: z.boolean().default(false)
}).strict();
export type Config = z.infer<typeof configSchema> & { stateDir: string };
export const configPath = () => process.env.D2L_MCP_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'd2l-mcp', 'config.json');
export async function privateDir(path: string): Promise<void> {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
  catch (error) { throw asError(error, 'prepare-private-directory'); }
}
export async function privateWrite(path: string, content: string, exclusive = false): Promise<void> {
  try { await writeFile(path, content, { mode: 0o600, flag: exclusive ? 'wx' : 'w' }); await chmod(path, 0o600); }
  catch (error) { throw asError(error, 'write-private-file'); }
}
export function normalizeConfig(input: unknown, base = process.cwd()): Config {
  const cfg = configSchema.parse(input);
  const url = new URL(cfg.origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(cfg.allowHttpLocalhost && local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new D2LError('BOUNDARY_VIOLATION', 'Configure an HTTPS origin without a path, credentials, query, or fragment.');
  }
  new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  return { ...cfg, origin: url.origin,
    stateDir: cfg.stateDir ? resolve(base, cfg.stateDir) : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'd2l-mcp'),
    catalogFiles: cfg.catalogFiles.map(p => resolve(base, p)) };
}
export async function loadConfig(path = configPath()): Promise<Config> {
  try { return normalizeConfig(JSON.parse(await readFile(path, 'utf8')), dirname(resolve(path))); }
  catch (e) { if (e instanceof D2LError) throw e; throw new D2LError('VALIDATION_REJECTED', 'Cannot read a valid config. Run d2l-mcp init --origin https://your-tenant first.'); }
}
export async function initConfig(origin: string, path = configPath()): Promise<Config> {
  const cfg = normalizeConfig({ origin });
  await privateDir(dirname(path));
  await privateWrite(path, JSON.stringify({ origin: cfg.origin, timezone: cfg.timezone, auth: { provider: 'browser' } }, null, 2) + '\n', true);
  await privateDir(cfg.stateDir);
  return cfg;
}
