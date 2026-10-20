import { TerminiaError } from '../core/errors';
import { sha256Hex } from '../core/hash';
import { basename, dirname, safeJoin } from '../core/paths';
import { listZip } from '../core/zip';
import { unzipSync } from 'fflate';
import type { FsBackend } from '../fs/backend';
import { fromNative } from '../fs/native-backend';
import { TerminiaFiles, type NativeFolderInfo, type RootId, type TerminiaFilesPlugin } from './plugins';

/**
 * Apple document-picker features (open folder, import, Save As / export to
 * Files) and large-file operations on downloaded artifacts.
 */

export interface ImportResult {
  imported: { name: string; path: string; size: number }[];
  failed: { name: string; error: string }[];
}

export interface DocumentService {
  /** Whether folders can be opened in place (iPad app only). */
  readonly supportsFolders: boolean;
  pickFolder(): Promise<{ id: string; name: string; path: string } | null>;
  listFolders(): Promise<NativeFolderInfo[]>;
  openFolder(id: string): Promise<{ id: string; name: string; path: string; stale: boolean }>;
  closeFolder(id: string): Promise<void>;
  forgetFolder(id: string): Promise<void>;
  importFiles(root: RootId, destination: string, options?: { multiple?: boolean; kind?: 'any' | 'zip' }): Promise<ImportResult | null>;
  importFolder(root: RootId, destination: string): Promise<{ name: string; path: string; files: number } | null>;
  /** Presents "Save to Files"; resolves false when the user cancels. */
  exportFile(root: RootId, path: string): Promise<boolean>;
}

export interface FileOps {
  zipEntries(root: RootId, path: string): Promise<{ name: string; size: number; compressedSize: number }[]>;
  zipExtract(root: RootId, path: string, entry: string, toRoot: RootId, to: string): Promise<number>;
  sha256(root: RootId, path: string): Promise<{ sha256: string; size: number }>;
  transfer(fromRoot: RootId, from: string, toRoot: RootId, to: string, move: boolean): Promise<void>;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw fromNative(error);
  }
}

export class NativeDocumentService implements DocumentService, FileOps {
  readonly supportsFolders = true;

  constructor(private readonly plugin: TerminiaFilesPlugin = TerminiaFiles) {}

  async pickFolder() {
    const result = await call(() => this.plugin.pickFolder());
    if (result.cancelled || !result.id) return null;
    return { id: result.id, name: result.name ?? 'Folder', path: result.path ?? '' };
  }

  async listFolders() {
    return (await call(() => this.plugin.listFolders())).folders;
  }

  async openFolder(id: string) {
    return call(() => this.plugin.openFolder({ id }));
  }

  async closeFolder(id: string) {
    await call(() => this.plugin.closeFolder({ id }));
  }

  async forgetFolder(id: string) {
    await call(() => this.plugin.forgetFolder({ id }));
  }

  async importFiles(root: RootId, destination: string, options: { multiple?: boolean; kind?: 'any' | 'zip' } = {}) {
    const result = await call(() => this.plugin.importFiles({ root, destination, multiple: options.multiple ?? true, kind: options.kind ?? 'any' }));
    return result.cancelled ? null : { imported: result.imported, failed: result.failed ?? [] };
  }

  async importFolder(root: RootId, destination: string) {
    const result = await call(() => this.plugin.importFolder({ root, destination }));
    return result.cancelled || !result.path ? null : { name: result.name ?? basename(result.path), path: result.path, files: result.files ?? 0 };
  }

  async exportFile(root: RootId, path: string) {
    const result = await call(() => this.plugin.exportFile({ root, path }));
    return !result.cancelled && result.exported;
  }

  async zipEntries(root: RootId, path: string) {
    return (await call(() => this.plugin.zipEntries({ root, path }))).entries;
  }

  async zipExtract(root: RootId, path: string, entry: string, toRoot: RootId, to: string) {
    return (await call(() => this.plugin.zipExtract({ root, path, entry, toRoot, to }))).size;
  }

  async sha256(root: RootId, path: string) {
    return call(() => this.plugin.sha256({ root, path }));
  }

  async transfer(fromRoot: RootId, from: string, toRoot: RootId, to: string, move: boolean) {
    await call(() => this.plugin.transfer({ fromRoot, from, toRoot, to, move }));
  }
}

/**
 * Browser-preview implementation: <input type=file> for imports and a
 * download link for exports. Folders cannot be opened in place in a browser.
 */
export class WebDocumentService implements DocumentService {
  readonly supportsFolders = false;

  constructor(private readonly roots: Partial<Record<string, FsBackend>>) {}

  private backend(root: RootId): FsBackend {
    const backend = this.roots[root];
    if (!backend) throw new TerminiaError('UNAVAILABLE', `Storage root '${root}' is not available in the browser preview.`);
    return backend;
  }

  private unavailable(): never {
    throw new TerminiaError('UNAVAILABLE', 'Opening folders in place needs the iPad app.', {
      hint: 'In the browser preview, import files or a zip archive into the workspace instead.',
    });
  }

  async pickFolder(): Promise<null> {
    this.unavailable();
  }

  async listFolders(): Promise<NativeFolderInfo[]> {
    return [];
  }

  async openFolder(): Promise<never> {
    this.unavailable();
  }

  async closeFolder(): Promise<void> {}

  async forgetFolder(): Promise<void> {}

  async importFiles(root: RootId, destination: string, options: { multiple?: boolean; kind?: 'any' | 'zip' } = {}): Promise<ImportResult | null> {
    const files = await pickBrowserFiles(options.multiple ?? true, options.kind === 'zip' ? '.zip,application/zip' : '');
    if (!files.length) return null;
    const backend = this.backend(root);
    const result: ImportResult = { imported: [], failed: [] };
    for (const file of files) {
      try {
        const path = safeJoin(destination, file.name);
        await backend.writeBytes(path, new Uint8Array(await file.arrayBuffer()), { overwrite: false });
        result.imported.push({ name: file.name, path, size: file.size });
      } catch (error) {
        result.failed.push({ name: file.name, error: (error as Error).message });
      }
    }
    return result;
  }

  async importFolder(): Promise<null> {
    throw new TerminiaError('UNAVAILABLE', 'Importing a folder needs the iPad app.', { hint: 'Import a zip archive of the folder instead.' });
  }

  async exportFile(root: RootId, path: string): Promise<boolean> {
    const data = await this.backend(root).readBytes(path, 500 * 1024 * 1024);
    const url = URL.createObjectURL(new Blob([data as BlobPart]));
    const link = document.createElement('a');
    link.href = url;
    link.download = basename(path);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  }
}

function pickBrowserFiles(multiple: boolean, accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** FileOps over JS backends (browser preview and tests), using fflate and Web Crypto. */
export class BackendFileOps implements FileOps {
  constructor(private readonly roots: Partial<Record<string, FsBackend>>) {}

  private backend(root: RootId): FsBackend {
    const backend = this.roots[root];
    if (!backend) throw new TerminiaError('UNAVAILABLE', `Storage root '${root}' is not available.`);
    return backend;
  }

  async zipEntries(root: RootId, path: string) {
    const data = await this.backend(root).readBytes(path, 1024 * 1024 * 1024);
    return listZip(data).map((e) => ({ name: e.name, size: e.size, compressedSize: e.compressedSize }));
  }

  async zipExtract(root: RootId, path: string, entry: string, toRoot: RootId, to: string) {
    const data = await this.backend(root).readBytes(path, 1024 * 1024 * 1024);
    const files = unzipSync(data, { filter: (f) => f.name === entry });
    const content = files[entry];
    if (!content) throw new TerminiaError('NOT_FOUND', `'${entry}' is not in the archive.`);
    await this.backend(toRoot).writeBytes(to, content);
    return content.byteLength;
  }

  async sha256(root: RootId, path: string) {
    const data = await this.backend(root).readBytes(path, 1024 * 1024 * 1024);
    return { sha256: await sha256Hex(data), size: data.byteLength };
  }

  async transfer(fromRoot: RootId, from: string, toRoot: RootId, to: string, move: boolean) {
    const source = this.backend(fromRoot);
    const target = this.backend(toRoot);
    if (dirname(to)) await target.mkdir(dirname(to), { recursive: true });
    await target.writeBytes(to, await source.readBytes(from, 1024 * 1024 * 1024));
    if (move) await source.remove(from);
  }
}

