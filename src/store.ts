import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateDir, privateWrite, type Config } from './config.js';
import { D2LError } from './errors.js';
import { Redactor } from './util.js';

export class Store {
  readonly root: string;
  private lastCleanup = 0;
  constructor(readonly config: Config, readonly redactor: Redactor) { this.root = join(config.stateDir, 'records'); }
  async init() { await privateDir(this.root); await this.cleanup(); }
  id() { return randomUUID(); }
  private path(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new D2LError('VALIDATION_REJECTED', 'Invalid result or request handle.');
    return join(this.root, `${id}.json`);
  }
  async put(value: unknown, id: string = this.id()): Promise<string> {
    if (Date.now() - this.lastCleanup > 60000) await this.cleanup();
    const path = this.path(id), temp = `${path}.${randomUUID()}.tmp`;
    await privateWrite(temp, JSON.stringify({ expiresAt: Date.now() + this.config.retentionHours * 3600000, value: this.redactor.clean(value) }));
    await rename(temp, path);
    return id;
  }
  async get<T = unknown>(id: string): Promise<T> {
    const path = this.path(id);
    let record;
    try { record = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new D2LError('NOT_FOUND', 'The local record does not exist or has expired.'); }
    if (record.expiresAt <= Date.now()) { await rm(path, { force: true }); throw new D2LError('NOT_FOUND', 'The local record has expired.'); }
    return record.value as T;
  }
  async cleanup(): Promise<void> {
    this.lastCleanup = Date.now();
    for (const name of await readdir(this.root)) {
      const path = join(this.root, name);
      if (name.endsWith('.tmp')) {
        if (Date.now() - (await stat(path)).mtimeMs > 60000) await rm(path, { force: true });
      } else if (name.endsWith('.json')) {
        try {
          const item = JSON.parse(await readFile(path, 'utf8'));
          if (item.expiresAt <= Date.now()) await rm(path, { force: true });
        } catch { /* Do not remove unfamiliar/corrupt records automatically. */ }
      }
    }
  }
  async present(data: unknown, forceExport = false): Promise<Record<string, unknown>> {
    const sanitized = this.redactor.clean(data);
    const raw = JSON.stringify(sanitized);
    if (!forceExport && Buffer.byteLength(raw) <= this.config.inlineBytes) return { data: sanitized };
    const resultHandle = await this.put({ kind: 'result', data: sanitized });
    return { resultHandle, bytes: Buffer.byteLength(raw),
      localPath: this.path(resultHandle), expiresInHours: this.config.retentionHours,
      retrieval: 'Use d2l_get_result for bounded chunks, or read the private local JSON file (data is under value.data).' };
  }
  async result(id: string, offset = 0, limit = 100): Promise<Record<string, unknown>> {
    const result = await this.get<{ kind: string; data: unknown }>(id);
    if (result.kind !== 'result') throw new D2LError('VALIDATION_REJECTED', 'This handle is not an exported result.');
    if (Array.isArray(result.data)) {
      const items: unknown[] = []; let bytes = 0;
      for (const item of result.data.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > this.config.inlineBytes) break;
        items.push(item); bytes += size;
      }
      if (!items.length && offset < result.data.length) return { resultHandle: id, localPath: this.path(id), itemTooLarge: true, nextOffset: offset };
      return { data: items, totalItems: result.data.length, nextOffset: offset + items.length < result.data.length ? offset + items.length : null };
    }
    const raw = JSON.stringify(result.data);
    // Bounded character chunks, with conservative UTF-8 byte budget; concatenate before parsing.
    const size = Math.max(1, Math.min(limit, Math.floor(this.config.inlineBytes / 6)));
    return { encoding: 'json-text', chunk: raw.slice(offset, offset + size), totalCharacters: raw.length,
      nextOffset: offset + size < raw.length ? offset + size : null };
  }
}
