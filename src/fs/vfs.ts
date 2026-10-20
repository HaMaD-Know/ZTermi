import { TerminiaError, throwIfAborted } from '../core/errors';
import { basename, dirname, isInside, joinPath, normalizeAbsolute, relativeTo } from '../core/paths';
import type { DirEntry, FileStat, FsBackend, WriteOptions } from './backend';

/**
 * Terminia's virtual filesystem: one namespace over the storage roots the app
 * is allowed to use.
 *
 *   /                      (virtual, read-only)
 *   /workspace             Terminia's own folder (On My iPad › Terminia in Files)
 *   /folders/<name>        folders the user opened through the document picker
 *
 * Nothing else on the iPad is reachable: iOS only grants access to the app's
 * container and to locations the user explicitly selects.
 */

export type MountKind = 'workspace' | 'folder';

export interface Mount {
  path: string;
  backend: FsBackend;
  label: string;
  kind: MountKind;
  /** Bookmark id for folders opened through the document picker. */
  folderId?: string;
}

export interface VfsEntry extends DirEntry {
  path: string;
}

export interface WalkFile {
  /** Path relative to the walked directory. */
  path: string;
  size: number;
  mtime: number;
}

export interface WalkOptions {
  /** Return true to skip a path (relative to the walked directory). */
  ignore?: (path: string, isDir: boolean) => boolean;
  maxFiles?: number;
  signal?: AbortSignal;
  /** Called for each directory before it is listed (used to load nested .gitignore files). */
  onDirectory?: (path: string) => Promise<void>;
}

export const WORKSPACE = '/workspace';
export const FOLDERS = '/folders';

export class Vfs {
  readonly home = WORKSPACE;
  private table: Mount[] = [];

  constructor(mounts: Mount[] = []) {
    for (const m of mounts) this.mount(m);
  }

  mount(mount: Mount): Mount {
    const path = normalizeAbsolute(mount.path);
    if (this.table.some((m) => m.path === path)) throw new TerminiaError('EXISTS', `${path} is already mounted.`);
    const entry = { ...mount, path };
    this.table.push(entry);
    this.table.sort((a, b) => b.path.length - a.path.length);
    return entry;
  }

  unmount(path: string): void {
    this.table = this.table.filter((m) => m.path !== normalizeAbsolute(path));
  }

  mounts(): Mount[] {
    return [...this.table].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** A free mount path under /folders for a folder named `name`. */
  folderMountPath(name: string): string {
    // eslint-disable-next-line no-control-regex
    const clean = name.replace(/[/\\:\u0000-\u001f]/g, '_').trim() || 'Folder';
    let candidate = `${FOLDERS}/${clean}`;
    for (let n = 2; this.table.some((m) => m.path === candidate); n++) candidate = `${FOLDERS}/${clean} (${n})`;
    return candidate;
  }

  mountFor(path: string): Mount | undefined {
    const p = normalizeAbsolute(path);
    return this.table.find((m) => isInside(p, m.path));
  }

  private isVirtual(path: string): boolean {
    const p = normalizeAbsolute(path);
    if (p === '/') return true;
    if (p === FOLDERS) return true;
    return false;
  }

  resolve(path: string): { mount: Mount; rel: string } {
    const p = normalizeAbsolute(path);
    const mount = this.mountFor(p);
    if (!mount) {
      if (this.isVirtual(p)) throw new TerminiaError('PERMISSION_DENIED', `${p} is a read-only Terminia directory.`);
      if (isInside(p, FOLDERS)) {
        throw new TerminiaError('NOT_FOUND', `No open folder at ${p}.`, {
          hint: 'Open a folder from Projects › Open Folder (iOS asks you to choose it).',
        });
      }
      throw new TerminiaError('NOT_FOUND', `No such file or directory: ${p}`, {
        hint: 'Terminia can only access /workspace and folders you open with the document picker.',
      });
    }
    return { mount, rel: relativeTo(mount.path, p) };
  }

  async list(path: string): Promise<VfsEntry[]> {
    const p = normalizeAbsolute(path);
    if (p === '/') {
      const out: VfsEntry[] = [];
      if (this.mountFor(WORKSPACE)) out.push({ name: 'workspace', path: WORKSPACE, type: 'directory', size: 0, mtime: 0 });
      out.push({ name: 'folders', path: FOLDERS, type: 'directory', size: 0, mtime: 0 });
      return out;
    }
    if (p === FOLDERS) {
      return this.table
        .filter((m) => m.kind === 'folder')
        .map((m) => ({ name: basename(m.path), path: m.path, type: 'directory' as const, size: 0, mtime: 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const { mount, rel } = this.resolve(p);
    const entries = await mount.backend.list(rel);
    return entries.map((e) => ({ ...e, path: joinPath(p, e.name) }));
  }

  async stat(path: string): Promise<FileStat> {
    if (this.isVirtual(path)) return { type: 'directory', size: 0, mtime: 0 };
    const { mount, rel } = this.resolve(path);
    return mount.backend.stat(rel);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof TerminiaError && (error.code === 'NOT_FOUND' || error.code === 'NOT_A_DIRECTORY')) return false;
      throw error;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.stat(path)).type === 'directory';
    } catch (error) {
      if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  async readText(path: string): Promise<{ text: string; mtime: number }> {
    const { mount, rel } = this.resolve(path);
    return mount.backend.readText(rel);
  }

  async readBytes(path: string, maxBytes?: number): Promise<Uint8Array> {
    const { mount, rel } = this.resolve(path);
    return mount.backend.readBytes(rel, maxBytes);
  }

  async writeText(path: string, text: string, options?: WriteOptions): Promise<{ mtime: number }> {
    const { mount, rel } = this.writable(path);
    return mount.backend.writeText(rel, text, options);
  }

  async writeBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<{ mtime: number }> {
    const { mount, rel } = this.writable(path);
    return mount.backend.writeBytes(rel, data, options);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { mount, rel } = this.writable(path);
    await mount.backend.mkdir(rel, options);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { mount, rel } = this.writable(path, 'remove');
    await mount.backend.remove(rel, options);
  }

  /** Moves or renames; across storage roots the data is copied, then the source removed. */
  async move(from: string, to: string): Promise<void> {
    const src = this.writable(from, 'move');
    const dst = this.writable(to);
    if (isInside(to, from)) throw new TerminiaError('INVALID_ARGUMENT', 'Cannot move a folder into itself.');
    if (src.mount === dst.mount) {
      await src.mount.backend.rename(src.rel, dst.rel);
      return;
    }
    await this.crossCopy(from, to);
    await src.mount.backend.remove(src.rel, { recursive: true });
  }

  async copy(from: string, to: string): Promise<void> {
    const src = this.resolve(from);
    const dst = this.writable(to);
    if (isInside(to, from)) throw new TerminiaError('INVALID_ARGUMENT', 'Cannot copy a folder into itself.');
    if (src.mount === dst.mount) {
      await src.mount.backend.copy(src.rel, dst.rel);
      return;
    }
    await this.crossCopy(from, to);
  }

  private async crossCopy(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new TerminiaError('EXISTS', `'${basename(to)}' already exists.`);
    const s = await this.stat(from);
    if (s.type === 'file') {
      await this.writeBytes(to, await this.readBytes(from), { overwrite: false });
      return;
    }
    await this.mkdir(to, { recursive: true });
    for (const entry of await this.list(from)) await this.crossCopy(entry.path, joinPath(to, entry.name));
  }

  /**
   * Resolves a path for modification. Deleting or moving a mount root itself
   * (the workspace, or the root of a folder the user opened) is refused.
   */
  private writable(path: string, operation: 'write' | 'remove' | 'move' = 'write'): { mount: Mount; rel: string } {
    const resolved = this.resolve(path);
    if (resolved.rel === '' && operation !== 'write') {
      throw new TerminiaError('PERMISSION_DENIED', `Refusing to ${operation === 'remove' ? 'delete' : 'move'} ${resolved.mount.path} itself.`, {
        hint: resolved.mount.kind === 'folder' ? 'Use Projects › Folders › Forget to stop using this folder.' : undefined,
      });
    }
    return resolved;
  }

  /** Lists all files below `root` (depth-first), honouring the ignore callback. */
  async walk(root: string, options: WalkOptions = {}): Promise<WalkFile[]> {
    const max = options.maxFiles ?? 50_000;
    const out: WalkFile[] = [];
    const visit = async (dir: string, rel: string): Promise<void> => {
      throwIfAborted(options.signal);
      await options.onDirectory?.(rel);
      const entries = await this.list(dir);
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const isDir = entry.type === 'directory';
        if (options.ignore?.(childRel, isDir)) continue;
        if (isDir) await visit(entry.path, childRel);
        else {
          out.push({ path: childRel, size: entry.size, mtime: entry.mtime });
          if (out.length > max) {
            throw new TerminiaError('TOO_LARGE', `More than ${max} files under ${root}.`, {
              hint: 'Add large generated folders to .gitignore or .terminiaignore.',
            });
          }
        }
      }
    };
    await visit(normalizeAbsolute(root), '');
    return out;
  }
}

/** Parent of a VFS path, never above "/". */
export function parentOf(path: string): string {
  const d = dirname(normalizeAbsolute(path));
  return d === '' ? '/' : d;
}
