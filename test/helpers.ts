import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { createClient } from '../src/runtime.js';
import type { AuthProvider, WireRequest, WireResponse } from '../src/auth.js';

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): WireResponse => ({
  status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(data))
});
export class FakeAuth implements AuthProvider {
  kind = 'fixture';
  calls: Array<{ url: URL; request: WireRequest }> = [];
  handler: (url: URL, request: WireRequest) => WireResponse | Promise<WireResponse> = () => json({});
  async send(url: URL, request: WireRequest) {
    this.calls.push({ url, request });
    if (url.pathname.endsWith('/users/whoami')) return json({ Identifier: '42', FirstName: 'Fixture', UniqueName: 'fixture' });
    if (url.pathname === '/d2l/api/versions/') return json([
      { ProductCode: 'lp', LatestVersion: '1.100', SupportedVersions: ['1.49', '1.52', '1.59', '1.98', '1.100'] },
      { ProductCode: 'le', LatestVersion: '1.100', SupportedVersions: ['1.82', '1.92', '1.98', '1.100'] }
    ]);
    return this.handler(url, request);
  }
  async close() {}
}
export async function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'd2l-mcp-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = normalizeConfig({ origin: 'https://tenant.example.edu', stateDir, auth: { provider: 'bearer' }, readRetries: 0, ...overrides });
  const auth = new FakeAuth(), client = await createClient(config, auth);
  t.after(() => client.close());
  return { client, auth, config, stateDir };
}
