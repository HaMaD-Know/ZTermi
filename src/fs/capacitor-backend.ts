import { Directory, Filesystem } from '@capacitor/filesystem';
import { TerminiaError } from '../core/errors';
import { base64ToBytes, bytesToBase64, fromUtf8, utf8 } from '../core/hash';
import { basename, validateRelativePath } from '../core/paths';
import { DEFAULT_MAX_READ_BYTES, type DirEntry, type FileStat, type FsBackend, type WriteOptions } from './backend';

/**
 * Backend for the browser preview, built on @capacitor/filesystem (IndexedDB
 * in a browser). On iOS the native TerminiaFiles plugin is used instead.
 */
export class CapacitorFsBackend implements FsBackend {
  readonly id: string;

  constructor(
    id: string,
    private readonly directory: Directory,
    private readonly prefix = 'Terminia',
  ) {
    this.id = id;
  }

  private p(path: string, allowEmpty = true): string {
    const rel = validateRelativePath(path, { allowEmpty });
    return rel ? `${this.prefix}/${rel}` : this.prefix;
  }

  private async wrap<T>(fn: () => Promise<T>, path: string): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (/does not exist|not exist|ENOENT|not found/i.test(message)) {
        throw new TerminiaError('NOT_FOUND', `No such file or directory: ${path || '/'}`);
      }
      if (/already exists|EEXIST/i.test(message)) throw new TerminiaError('EXISTS', `'${basename(path)}' already exists.`);
      throw new TerminiaError('IO_ERROR', message, { cause: error });
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      await Filesystem.mkdir({ path: this.prefix, directory: this.directory, recursive: true });
    } catch {
      // already exists
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    if (!path) await this.ensureRoot();
    const result = await this.wrap(() => Filesystem.readdir({ path: this.p(path), directory: this.directory }), path);
    return result.files
      .map((f) => ({ name: f.name, type: f.type, size: f.size ?? 0, mtime: Number(f.mtime ?? 0) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat> {
    if (!path) await this.ensureRoot();
    const s = await this.wrap(() => Filesystem.stat({ path: this.p(path), directory: this.directory }), path);
    return { type: s.type === 'directory' ? 'directory' : 'file', size: s.size ?? 0, mtime: Number(s.mtime ?? 0) };
  }

  /**
   * Everything is stored base64-encoded (text goes through UTF-8 bytes), so
   * text and binary reads of the same file always agree. Content stored as
   * plain text by older builds is still read correctly.
   */
  async readText(path: string): Promise<{ text: string; mtime: number }> {
    const s = await this.stat(path);
    if (s.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${path}`);
    return { text: fromUtf8(await this.readBytes(path)), mtime: s.mtime };
  }

  async readBytes(path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<Uint8Array> {
    const s = await this.stat(path);
    if (s.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${path}`);
    if (s.size > maxBytes) throw new TerminiaError('TOO_LARGE', `${basename(path)} is too large to read.`);
    const result = await this.wrap(() => Filesystem.readFile({ path: this.p(path, false), directory: this.directory }), path);
    if (typeof result.data !== 'string') return new Uint8Array(await (result.data as Blob).arrayBuffer());
    try {
      return base64ToBytes(result.data);
    } catch {
      return utf8(result.data);
    }
  }

  private async checkWrite(path: string, options: WriteOptions): Promise<void> {
    let current: FileStat | null = null;
    try {
      current = await this.stat(path);
    } catch (error) {
      if (!(error instanceof TerminiaError && error.code === 'NOT_FOUND')) throw error;
    }
    if (!current) return;
    if (current.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `Is a directory: ${path}`);
    if (options.overwrite === false) throw new TerminiaError('EXISTS', `'${basename(path)}' already exists.`);
    if (options.expectedMtime !== undefined && Math.abs(current.mtime - options.expectedMtime) > 1) {
      throw new TerminiaError('CONFLICT', `'${basename(path)}' was changed since it was opened.`, { details: { currentMtime: current.mtime } });
    }
  }

  async writeText(path: string, text: string, options: WriteOptions = {}): Promise<{ mtime: number }> {
    return this.writeBytes(path, utf8(text), options);
  }

  async writeBytes(path: string, data: Uint8Array, options: WriteOptions = {}): Promise<{ mtime: number }> {
    await this.checkWrite(path, options);
    await this.wrap(
      () => Filesystem.writeFile({ path: this.p(path, false), directory: this.directory, data: bytesToBase64(data), recursive: true }),
      path,
    );
    return { mtime: (await this.stat(path)).mtime };
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (options.recursive) {
      try {
        if ((await this.stat(path)).type === 'directory') return;
      } catch (error) {
        if (!(error instanceof TerminiaError && error.code === 'NOT_FOUND')) throw error;
      }
    }
    await this.wrap(() => Filesystem.mkdir({ path: this.p(path, false), directory: this.directory, recursive: options.recursive ?? false }), path);
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const s = await this.stat(path);
    if (s.type === 'directory') {
      await this.wrap(() => Filesystem.rmdir({ path: this.p(path, false), directory: this.directory, recursive: options.recursive ?? false }), path);
    } else {
      await this.wrap(() => Filesystem.deleteFile({ path: this.p(path, false), directory: this.directory }), path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureAbsent(to);
    await this.wrap(
      () => Filesystem.rename({ from: this.p(from, false), to: this.p(to, false), directory: this.directory, toDirectory: this.directory }),
      from,
    );
  }

  async copy(from: string, to: string): Promise<void> {
    await this.ensureAbsent(to);
    await this.wrap(
      () => Filesystem.copy({ from: this.p(from, false), to: this.p(to, false), directory: this.directory, toDirectory: this.directory }),
      from,
    );
  }

  private async ensureAbsent(path: string): Promise<void> {
    try {
      await this.stat(path);
    } catch (error) {
      if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return;
      throw error;
    }
    throw new TerminiaError('EXISTS', `'${basename(path)}' already exists.`);
  }
}

export { Directory };
