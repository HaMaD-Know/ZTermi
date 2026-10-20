/**
 * The browser preview's storage: the real @capacitor/filesystem web
 * implementation (IndexedDB, provided here by fake-indexeddb) behind
 * CapacitorFsBackend, used through the VFS like the app does.
 */
import { describe, expect, it } from 'vitest';
import { CapacitorFsBackend, Directory } from '../../src/fs/capacitor-backend';
import { Vfs } from '../../src/fs/vfs';
import { isTerminiaError } from '../../src/core/errors';

function vfs(prefix: string) {
  const backend = new CapacitorFsBackend('workspace', Directory.Documents, prefix);
  return new Vfs([{ path: '/workspace', backend, label: 'w', kind: 'workspace' }]);
}

describe('browser preview storage (Capacitor Filesystem web implementation)', () => {
  it('reads text files as bytes and binary files as bytes, consistently', async () => {
    const fs = vfs('t1');
    await fs.writeText('/workspace/app/index.html', '<title>Ünïcode ✓</title>\n');
    expect((await fs.readText('/workspace/app/index.html')).text).toBe('<title>Ünïcode ✓</title>\n');
    expect(new TextDecoder().decode(await fs.readBytes('/workspace/app/index.html'))).toBe('<title>Ünïcode ✓</title>\n');
    const binary = new Uint8Array([0, 255, 1, 254, 80, 75]);
    await fs.writeBytes('/workspace/app/bin.dat', binary);
    expect(await fs.readBytes('/workspace/app/bin.dat')).toEqual(binary);
  });

  it('lists, renames, copies and removes like the native backend', async () => {
    const fs = vfs('t2');
    await fs.writeText('/workspace/p/a.txt', 'a');
    await fs.mkdir('/workspace/p/sub', { recursive: true });
    expect((await fs.list('/workspace/p')).map((e) => `${e.name}:${e.type}`)).toEqual(['a.txt:file', 'sub:directory']);
    await fs.move('/workspace/p/a.txt', '/workspace/p/sub/b.txt');
    await fs.copy('/workspace/p/sub', '/workspace/p/copy');
    expect((await fs.readText('/workspace/p/copy/b.txt')).text).toBe('a');
    await fs.remove('/workspace/p/sub', { recursive: true });
    expect(await fs.exists('/workspace/p/sub')).toBe(false);
  });

  it('detects conflicting writes and refuses to overwrite when asked not to', async () => {
    const fs = vfs('t3');
    const { mtime } = await fs.writeText('/workspace/f.txt', 'one');
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeText('/workspace/f.txt', 'two');
    const conflict = await fs.writeText('/workspace/f.txt', 'three', { expectedMtime: mtime }).catch((e: unknown) => e);
    expect(isTerminiaError(conflict, 'CONFLICT')).toBe(true);
    const exists = await fs.writeText('/workspace/f.txt', 'x', { overwrite: false }).catch((e: unknown) => e);
    expect(isTerminiaError(exists, 'EXISTS')).toBe(true);
    const missing = await fs.readText('/workspace/nope.txt').catch((e: unknown) => e);
    expect(isTerminiaError(missing, 'NOT_FOUND')).toBe(true);
  });
});
