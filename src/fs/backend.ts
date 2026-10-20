import { TerminiaError } from '../core/errors';
import { basename, dirname, validateRelativePath } from '../core/paths';

/**
 * A storage root. Paths are relative to the root and validated at this
 * boundary (no "..", no absolute paths), so a backend can never be asked to
 * touch anything outside the location the user authorised.
 */
export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
}

export interface FileStat {
  type: 'file' | 'directory';
  size: number;
  mtime: number;
}

export interface WriteOptions {
  /** Reject with CONFLICT when the file's mtime differs (it changed since it was read). */
  expectedMtime?: number;
  /** Default true. When false, an existing file is an EXISTS error. */
  overwrite?: boolean;
}

export interface FsBackend {
  readonly id: string;
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  readText(path: string): Promise<{ text: string; mtime: number }>;
  readBytes(path: string, maxBytes?: number): Promise<Uint8Array>;
  writeText(path: string, text: string, options?: WriteOptions): Promise<{ mtime: number }>;
  writeBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<{ mtime: number }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

export async function exists(backend: FsBackend, path: string): Promise<boolean> {
  try {
    await backend.stat(path);
    return true;
  } catch (error) {
    if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

export const DEFAULT_MAX_READ_BYTES = 50 * 1024 * 1024;

interface MemoryNode {
  type: 'file' | 'directory';
  data: Uint8Array;
  mtime: number;
}

/**
 * In-memory backend with the same semantics as the native one (parent folders
 * are created on write, mtime conflict detection, recursive delete). Used by
 * tests and as scratch space.
 */
export class MemoryFsBackend implements FsBackend {
  readonly id: string;
  private nodes = new Map<string, MemoryNode>();
  private clock = 1_700_000_000_000;

  constructor(id = 'memory', files: Record<string, string | Uint8Array> = {}) {
    this.id = id;
    this.nodes.set('', { type: 'directory', data: new Uint8Array(), mtime: this.tick() });
    for (const [path, content] of Object.entries(files)) {
      this.putSync(path, typeof content === 'string' ? new TextEncoder().encode(content) : content);
    }
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private ensureParents(path: string): void {
    const parent = dirname(path);
    if (parent === '' || parent === '/') return;
    const node = this.nodes.get(parent);
    if (node && node.type === 'file') throw new TerminiaError('NOT_A_DIRECTORY', `${parent} is a file.`);
    if (!node) {
      this.ensureParents(parent);
      this.nodes.set(parent, { type: 'directory', data: new Uint8Array(), mtime: this.tick() });
    }
  }

  putSync(path: string, data: Uint8Array): void {
    const p = validateRelativePath(path, { allowEmpty: false });
    this.ensureParents(p);
    this.nodes.set(p, { type: 'file', data, mtime: this.tick() });
  }

  private get(path: string): MemoryNode {
    const node = this.nodes.get(validateRelativePath(path));
    if (!node) throw new TerminiaError('NOT_FOUND', `No such file or directory: ${path || '/'}`);
    return node;
  }

  async list(path: string): Promise<DirEntry[]> {
    const p = validateRelativePath(path);
    const node = this.get(p);
    if (node.type !== 'directory') throw new TerminiaError('NOT_A_DIRECTORY', `Not a directory: ${path}`);
    const prefix = p ? `${p}/` : '';
    const out: DirEntry[] = [];
    for (const [key, child] of this.nodes) {
      if (key === p || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({ name: rest, type: child.type, size: child.type === 'file' ? child.data.byteLength : 0, mtime: child.mtime });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat> {
    const node = this.get(path);
    return { type: node.type, size: node.type === 'file' ? node.data.byteLength : 0, mtime: node.mtime };
  }

  async readText(path: string): Promise<{ text: string; mtime: number }> {
    const node = this.get(path);
    if (node.type !== 'file') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${path}`);
    return { text: new TextDecoder().decode(node.data), mtime: node.mtime };
  }

  async readBytes(path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<Uint8Array> {
    const node = this.get(path);
    if (node.type !== 'file') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${path}`);
    if (node.data.byteLength > maxBytes) throw new TerminiaError('TOO_LARGE', `${basename(path)} is too large to read.`);
    return node.data.slice();
  }

  private checkWrite(p: string, options: WriteOptions): void {
    const existing = this.nodes.get(p);
    if (!existing) return;
    if (existing.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${p}`);
    if (options.overwrite === false) throw new TerminiaError('EXISTS', `'${basename(p)}' already exists.`);
    if (options.expectedMtime !== undefined && Math.abs(existing.mtime - options.expectedMtime) > 1) {
      throw new TerminiaError('CONFLICT', `'${basename(p)}' was changed by another app since it was opened.`, {
        details: { currentMtime: existing.mtime },
      });
    }
  }

  async writeText(path: string, text: string, options: WriteOptions = {}): Promise<{ mtime: number }> {
    return this.writeBytes(path, new TextEncoder().encode(text), options);
  }

  async writeBytes(path: string, data: Uint8Array, options: WriteOptions = {}): Promise<{ mtime: number }> {
    const p = validateRelativePath(path, { allowEmpty: false });
    this.checkWrite(p, options);
    this.ensureParents(p);
    const mtime = this.tick();
    this.nodes.set(p, { type: 'file', data: data.slice(), mtime });
    return { mtime };
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const p = validateRelativePath(path, { allowEmpty: false });
    const existing = this.nodes.get(p);
    if (existing) {
      if (existing.type === 'directory' && options.recursive) return;
      throw new TerminiaError('EXISTS', `'${basename(p)}' already exists.`);
    }
    const parent = dirname(p);
    if (!options.recursive && parent && !this.nodes.has(parent)) {
      throw new TerminiaError('NOT_FOUND', `Parent folder does not exist: ${parent}`);
    }
    this.ensureParents(p);
    this.nodes.set(p, { type: 'directory', data: new Uint8Array(), mtime: this.tick() });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const p = validateRelativePath(path, { allowEmpty: false });
    const node = this.get(p);
    if (node.type === 'directory') {
      const children = [...this.nodes.keys()].filter((k) => k.startsWith(`${p}/`));
      if (children.length && !options.recursive) throw new TerminiaError('INVALID_ARGUMENT', `Directory not empty: ${path}`);
      for (const child of children) this.nodes.delete(child);
    }
    this.nodes.delete(p);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = validateRelativePath(from, { allowEmpty: false });
    const dst = validateRelativePath(to, { allowEmpty: false });
    this.get(src);
    if (this.nodes.has(dst)) throw new TerminiaError('EXISTS', `'${basename(dst)}' already exists.`);
    if (dst.startsWith(`${src}/`)) throw new TerminiaError('INVALID_ARGUMENT', 'Cannot move a folder into itself.');
    this.ensureParents(dst);
    const moved: [string, MemoryNode][] = [];
    for (const [key, node] of this.nodes) {
      if (key === src || key.startsWith(`${src}/`)) moved.push([dst + key.slice(src.length), node]);
    }
    for (const [key] of [...this.nodes].filter(([k]) => k === src || k.startsWith(`${src}/`))) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(key, node);
  }

  async copy(from: string, to: string): Promise<void> {
    const src = validateRelativePath(from, { allowEmpty: false });
    const dst = validateRelativePath(to, { allowEmpty: false });
    this.get(src);
    if (this.nodes.has(dst)) throw new TerminiaError('EXISTS', `'${basename(dst)}' already exists.`);
    if (dst.startsWith(`${src}/`)) throw new TerminiaError('INVALID_ARGUMENT', 'Cannot copy a folder into itself.');
    this.ensureParents(dst);
    for (const [key, node] of [...this.nodes]) {
      if (key === src || key.startsWith(`${src}/`)) {
        this.nodes.set(dst + key.slice(src.length), { type: node.type, data: node.data.slice(), mtime: this.tick() });
      }
    }
  }
}
