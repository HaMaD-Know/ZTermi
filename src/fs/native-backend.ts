import { TerminiaError, isErrorCode } from '../core/errors';
import { base64ToBytes, bytesToBase64 } from '../core/hash';
import { validateRelativePath } from '../core/paths';
import { TerminiaFiles, nativeErrorCode, type RootId, type TerminiaFilesPlugin } from '../platform/plugins';
import { DEFAULT_MAX_READ_BYTES, type DirEntry, type FileStat, type FsBackend, type WriteOptions } from './backend';

/** Maps native rejections to TerminiaError codes, with hints for the common iOS cases. */
export function fromNative(error: unknown): TerminiaError {
  if (error instanceof TerminiaError) return error;
  const code = nativeErrorCode(error);
  const message = (error as { message?: string })?.message ?? String(error);
  switch (code) {
    case 'ROOT_NOT_OPEN':
      return new TerminiaError('PERMISSION_DENIED', message, {
        hint: 'iOS ended access to this folder. Open it again from Projects › Folders.',
      });
    case 'NOT_DOWNLOADED':
      return new TerminiaError('UNAVAILABLE', message, { retryable: true });
    case 'CONFLICT':
      return new TerminiaError('CONFLICT', message, { details: (error as { data?: Record<string, unknown> }).data });
    case 'NO_SPACE':
      return new TerminiaError('IO_ERROR', message, { hint: 'The iPad is out of storage space.' });
    default:
      return new TerminiaError(isErrorCode(code) ? code : 'IO_ERROR', message, { cause: error });
  }
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw fromNative(error);
  }
}

/** A root served by the TerminiaFiles Swift plugin (Documents, Caches or a security-scoped folder). */
export class NativeFsBackend implements FsBackend {
  readonly id: string;

  constructor(
    private readonly root: RootId,
    private readonly plugin: TerminiaFilesPlugin = TerminiaFiles,
  ) {
    this.id = root;
  }

  private p(path: string, allowEmpty = true): string {
    return validateRelativePath(path, { allowEmpty });
  }

  async list(path: string): Promise<DirEntry[]> {
    const { entries } = await call(() => this.plugin.list({ root: this.root, path: this.p(path) }));
    return entries.map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }));
  }

  async stat(path: string): Promise<FileStat> {
    return call(() => this.plugin.stat({ root: this.root, path: this.p(path) }));
  }

  async readText(path: string): Promise<{ text: string; mtime: number }> {
    const result = await call(() => this.plugin.readText({ root: this.root, path: this.p(path, false) }));
    return { text: result.data, mtime: result.mtime };
  }

  async readBytes(path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<Uint8Array> {
    const result = await call(() => this.plugin.readBase64({ root: this.root, path: this.p(path, false), maxBytes }));
    return base64ToBytes(result.data);
  }

  async writeText(path: string, text: string, options: WriteOptions = {}): Promise<{ mtime: number }> {
    return call(() =>
      this.plugin.writeText({
        root: this.root,
        path: this.p(path, false),
        data: text,
        expectedMtime: options.expectedMtime,
        overwrite: options.overwrite ?? true,
      }),
    );
  }

  async writeBytes(path: string, data: Uint8Array, options: WriteOptions = {}): Promise<{ mtime: number }> {
    return call(() =>
      this.plugin.writeBase64({ root: this.root, path: this.p(path, false), data: bytesToBase64(data), overwrite: options.overwrite ?? true }),
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await call(() => this.plugin.mkdir({ root: this.root, path: this.p(path, false), recursive: options.recursive ?? false }));
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await call(() => this.plugin.remove({ root: this.root, path: this.p(path, false), recursive: options.recursive ?? false }));
  }

  async rename(from: string, to: string): Promise<void> {
    await call(() => this.plugin.rename({ root: this.root, from: this.p(from, false), to: this.p(to, false) }));
  }

  async copy(from: string, to: string): Promise<void> {
    await call(() => this.plugin.copy({ root: this.root, from: this.p(from, false), to: this.p(to, false) }));
  }
}
