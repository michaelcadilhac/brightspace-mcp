#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { configPath, initConfig, loadConfig } from './config.js';
import { connectSession, finishLogin, SessionTransport, startSession } from './session.js';
import { Catalog } from './catalog.js';
import { Store } from './store.js';
import { Redactor } from './util.js';
import { asError, D2LError } from './errors.js';
import { authenticationError } from './auth-errors.js';

process.umask(0o077);
const help = `brightspace-mcp — Linux, Node.js 24 or 26\n\nCommands:\n  init --origin https://tenant.example.edu [--config PATH]\n  status [--config PATH]\n  login [--config PATH]       Open the shared session browser for manual SSO/MFA\n  serve [--config PATH]       MCP over stdio; connections share one session owner\n  diagnostics REQUEST_ID [--config PATH]\n  catalog-check [--config PATH]\n\nThe d2l-mcp command remains an alias.\nConfig defaults to $XDG_CONFIG_HOME/d2l-mcp/config.json (or ~/.config/...).\nD2L_MCP_CONFIG may select an alternate file. No course changes occur during setup.\n`;

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
  if (command === 'session-daemon') {
    const { close } = await startSession(config);
    const shutdown = async () => { await close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    process.send?.({ ready: true }); process.disconnect?.();
    return;
  }
  if (!['serve', 'status', 'login'].includes(command)) throw new D2LError('VALIDATION_REJECTED', 'Unknown command. Run --help.');
  if (command === 'login' && !process.stdin.isTTY) throw new D2LError('VALIDATION_REJECTED', 'Run login from an interactive terminal with a graphical display.');
  const { socket } = await connectSession(config, path, command === 'login' ? 'login' : 'mcp');
  const confirmation = new AbortController();
  socket.once('close', () => confirmation.abort());
  const disconnect = () => { confirmation.abort(); socket.destroy(); process.stdin.pause(); };
  process.once('SIGINT', disconnect); process.once('SIGTERM', disconnect);
  if (command === 'serve') {
    socket.once('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
    process.stdin.on('error', disconnect); process.stdout.on('error', disconnect);
    process.stdin.pipe(socket); socket.pipe(process.stdout, { end: false });
    process.stderr.write('brightspace-mcp ready (stdio, shared session); authentication is checked on API use.\n');
    return;
  }
  try {
    if (command === 'login') {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { await rl.question('Complete sign-in manually in the dedicated browser, then press Enter here. ', { signal: confirmation.signal }); }
      catch (error) { throw authenticationError(error, 'login-confirmation'); }
      finally { rl.close(); }
      const { status, warning } = await finishLogin(socket);
      if (warning) process.stderr.write(JSON.stringify({ warning, stage: 'observe-tenant-csrf' }) + '\n');
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      if (status?.authentication !== 'authenticated') process.exitCode = 1;
      return;
    }
    const mcp = new Client({ name: 'brightspace-cli', version: '0.1.0' });
    try {
      await mcp.connect(new SessionTransport(socket));
      const result = await mcp.callTool({ name: 'd2l_session_status', arguments: {} });
      const status = result.structuredContent as Record<string, unknown>;
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      if (result.isError || status.authentication !== 'authenticated') process.exitCode = 1;
    } finally { await mcp.close(); }
  } finally { socket.destroy(); }
}
main().catch(error => {
  const result = { error: asError(error, 'cli-startup').toJSON() };
  process.send?.(result); if (process.connected) process.disconnect();
  process.stderr.write(JSON.stringify(result) + '\n'); process.exitCode = 1;
});
