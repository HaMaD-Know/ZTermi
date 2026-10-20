import { TerminiaError, throwIfAborted } from '../core/errors';
import { basename, joinPath } from '../core/paths';
import type { SecretFinding } from '../core/secrets';
import { createZip, extractZip, type ExtractLimits, DEFAULT_EXTRACT_LIMITS } from '../core/zip';
import type { Vfs } from '../fs/vfs';
import { collectProjectFiles, scanForSecrets } from './files';

export interface ExportResult {
  zip: Uint8Array;
  included: number;
  ignored: number;
  excluded: SecretFinding[];
  tooLarge: string[];
}

const MAX_EXPORT_FILE = 100 * 1024 * 1024;

/**
 * Builds a zip of a project. Ignored files and detected secrets are left out
 * (credentials never end up in an exported archive); the result says which.
 */
export async function exportProjectArchive(
  vfs: Vfs,
  root: string,
  options: { includeIgnored?: boolean; signal?: AbortSignal } = {},
): Promise<ExportResult> {
  const { files, ignored } = await collectProjectFiles(vfs, root, options);
  const tooLarge = files.filter((f) => f.size > MAX_EXPORT_FILE).map((f) => f.path);
  const candidates = files.filter((f) => f.size <= MAX_EXPORT_FILE);
  const cache = new Map<string, Uint8Array>();
  const read = async (path: string) => {
    throwIfAborted(options.signal);
    const data = await vfs.readBytes(joinPath(root, path), MAX_EXPORT_FILE);
    cache.set(path, data);
    return data;
  };
  const { allowed, findings } = await scanForSecrets(vfs, root, candidates, read);
  const name = basename(root) || 'project';
  const entries = [];
  for (const file of allowed) {
    throwIfAborted(options.signal);
    const data = cache.get(file.path) ?? (await vfs.readBytes(joinPath(root, file.path), MAX_EXPORT_FILE));
    entries.push({ path: `${name}/${file.path}`, data, mtime: file.mtime || undefined });
  }
  return { zip: createZip(entries), included: entries.length, ignored, excluded: findings, tooLarge };
}

/** Extracts a project archive into `destination` (which must not exist yet). */
export async function importProjectArchive(
  vfs: Vfs,
  data: Uint8Array,
  destination: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<{ files: number }> {
  if (await vfs.exists(destination)) throw new TerminiaError('EXISTS', `${destination} already exists.`);
  const files = extractZip(data, limits, { stripRoot: true });
  if (!files.length) throw new TerminiaError('VALIDATION', 'The archive contains no files.');
  await vfs.mkdir(destination, { recursive: true });
  for (const file of files) {
    await vfs.writeBytes(joinPath(destination, file.path), file.data, { overwrite: false });
  }
  return { files: files.length };
}
