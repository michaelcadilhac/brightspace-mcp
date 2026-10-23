#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, initConfig, loadConfig } from './config.js';
import { ownedClient } from './runtime.js';
import { createServer } from './server.js';
import { BrowserAuth } from './auth.js';
import { Catalog } from './catalog.js';
import { Store } from './store.js';
import { Redactor } from './util.js';
import { asError, D2LError } from './errors.js';
import { authenticationError } from './auth-errors.js';

process.umask(0o077);
const help = `brightspace-mcp — Linux, Node.js 24 or 26\n\nCommands:\n  init --origin https://tenant.example.edu [--config PATH]\n  status [--config PATH]\n  login [--config PATH]       Open the dedicated browser for manual SSO/MFA\n  serve [--config PATH]       MCP over stdio; one owner per state directory\n  diagnostics REQUEST_ID [--config PATH]\n  catalog-check [--config PATH]\n\nThe d2l-mcp command remains an alias.\nConfig defaults to $XDG_CONFIG_HOME/d2l-mcp/config.json (or ~/.config/...).\nD2L_MCP_CONFIG may select an alternate file. No course changes occur during setup.\n`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, origin: { type: 'string' }, help: { type: 'boolean', short: 'h' }
  } });
  const [command, id] = positionals;
  if (values.help || !command) { process.stdout.write(help); return; }
  const path = values.config ?? configPath();
  if (command === 'init') {
    if (!values.origin) throw new D2LError('VALIDATION_REJECTED', '--origin is required.');
    const config = await initConfig(values.origin, path);
    process.stdout.write(JSON.stringify({ config: path, stateDir: config.stateDir, nextStep: 'Run brightspace-mcp login, then brightspace-mcp status.' }, null, 2) + '\n'); return;
  }
  const config = await loadConfig(path);
  if (command === 'catalog-check') {
    const catalog = new Catalog(); await catalog.load(config.catalogFiles);
    process.stdout.write(JSON.stringify({ valid: true, revisions: catalog.revisions, operations: catalog.search('', undefined, 10000).length }) + '\n'); return;
  }
  if (command === 'diagnostics') {
    if (!id) throw new D2LError('VALIDATION_REJECTED', 'A request ID is required.');
    const store = new Store(config, new Redactor());
    process.stdout.write(JSON.stringify(await store.get(id), null, 2) + '\n'); return;
  }
  if (!['serve', 'status', 'login'].includes(command)) throw new D2LError('VALIDATION_REJECTED', 'Unknown command. Run --help.');
  const { client, close } = await ownedClient(config);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (command === 'serve') {
    const server = createServer(client), transport = new StdioServerTransport();
    server.server.onclose = () => { void close(); };
    process.stdin.once('end', () => { void server.close().finally(close); });
    await server.connect(transport);
    process.stderr.write('brightspace-mcp ready (stdio); authentication is checked on API use.\n');
    return;
  }
  try {
    if (command === 'login') {
      if (!(client.auth instanceof BrowserAuth)) throw new D2LError('VALIDATION_REJECTED', 'Bearer authentication is configured. Supply a token from your registered provider.');
      if (!process.stdin.isTTY) throw new D2LError('VALIDATION_REJECTED', 'Run login from an interactive terminal with a graphical display.');
      const context = await client.auth.open(false);
      const loginUrl = new URL(config.auth.provider === 'browser' ? config.auth.loginPath : '/', config.origin);
      if (loginUrl.origin !== config.origin) throw new D2LError('BOUNDARY_VIOLATION', 'The initial login URL must belong to the configured tenant.');
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(loginUrl.href, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }).catch(() => {});
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { await rl.question('Complete sign-in manually in the dedicated browser, then press Enter here. '); }
      catch (error) { throw authenticationError(error, 'login-confirmation'); }
      finally { rl.close(); }
      await client.auth.capture();
      const warning = client.auth.captureWarning();
      if (warning) process.stderr.write(JSON.stringify({ warning, stage: 'observe-tenant-csrf' }) + '\n');
    }
    const status = await client.sessionStatus();
    process.stdout.write(JSON.stringify(client.redactor.clean(status), null, 2) + '\n');
    if (status.authentication !== 'authenticated') process.exitCode = 1;
  } finally { await close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: asError(error, 'cli-startup').toJSON() }) + '\n'); process.exitCode = 1; });
