import type { Config } from './config.js';
import { Boundary } from './boundary.js';
import { BrowserAuth, BearerAuth, type AuthProvider } from './auth.js';
import { ApiTransport } from './transport.js';
import { Catalog } from './catalog.js';
import { D2LClient } from './client.js';
import { Store } from './store.js';
import { Redactor } from './util.js';
import { ProfileLock } from './lock.js';

export async function createClient(config: Config, provider?: AuthProvider): Promise<D2LClient> {
  const boundary = new Boundary(config), redactor = new Redactor(), catalog = new Catalog();
  const auth = provider ?? (config.auth.provider === 'browser' ? new BrowserAuth(config, redactor, boundary) : new BearerAuth(config, redactor));
  const store = new Store(config, redactor);
  await catalog.load(config.catalogFiles); await store.init();
  return new D2LClient(config, auth, new ApiTransport(config, boundary, auth, redactor), boundary, catalog, store, redactor);
}
export async function ownedClient(config: Config): Promise<{ client: D2LClient; close: () => Promise<void> }> {
  const lock = new ProfileLock(); await lock.acquire(config.stateDir);
  try {
    const client = await createClient(config);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => { try { await client.close(); } finally { await lock.release(); } })();
    return { client, close };
  } catch (e) { await lock.release(); throw e; }
}
