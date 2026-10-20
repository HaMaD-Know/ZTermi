import { unzipSync, zipSync, type Zippable } from 'fflate';
import { TerminiaError } from './errors';
import { extname, safeJoin } from './paths';

/**
 * Zip archives for project import/export and small build results. Extraction
 * is defensive: every entry name is validated (no absolute paths, no "..",
 * Windows separators normalised), and entry count, per-entry size, total size
 * and compression ratio are limited to stop zip bombs.
 */

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

export interface ExtractLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Largest allowed ratio of uncompressed to compressed size for big entries. */
  maxRatio: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxRatio: 200,
};

export interface ExtractedFile {
  path: string;
  data: Uint8Array;
}

export function isZip(data: Uint8Array): boolean {
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06);
}

export function listZip(data: Uint8Array): ZipEntryInfo[] {
  if (!isZip(data)) throw new TerminiaError('VALIDATION', 'The file is not a zip archive.');
  const entries: ZipEntryInfo[] = [];
  try {
    unzipSync(data, {
      filter(file) {
        entries.push({
          name: file.name,
          size: file.originalSize,
          compressedSize: file.size,
          isDirectory: file.name.endsWith('/'),
        });
        return false;
      },
    });
  } catch (error) {
    throw new TerminiaError('VALIDATION', `Could not read the zip archive: ${(error as Error).message}`);
  }
  return entries;
}

/**
 * Extracts every file entry. With `stripRoot`, a single top-level folder that
 * contains everything (as produced by "Compress folder") is removed.
 */
export function extractZip(data: Uint8Array, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS, { stripRoot = false } = {}): ExtractedFile[] {
  const entries = listZip(data);
  const files = entries.filter((e) => !e.isDirectory && !isJunk(e.name));
  if (files.length > limits.maxEntries) {
    throw new TerminiaError('TOO_LARGE', `The archive has ${files.length} files; the limit is ${limits.maxEntries}.`);
  }
  let total = 0;
  for (const entry of files) {
    safeJoin('', entry.name);
    if (entry.size > limits.maxEntryBytes) {
      throw new TerminiaError('TOO_LARGE', `'${entry.name}' is larger than ${Math.round(limits.maxEntryBytes / 1048576)} MB.`);
    }
    if (entry.size > 10 * 1024 * 1024 && entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxRatio) {
      throw new TerminiaError('TOO_LARGE', `'${entry.name}' has a suspicious compression ratio; extraction refused.`);
    }
    total += entry.size;
  }
  if (total > limits.maxTotalBytes) {
    throw new TerminiaError('TOO_LARGE', `The archive expands to ${Math.round(total / 1048576)} MB; the limit is ${Math.round(limits.maxTotalBytes / 1048576)} MB.`);
  }

  const wanted = new Set(files.map((f) => f.name));
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(data, { filter: (file) => wanted.has(file.name) });
  } catch (error) {
    throw new TerminiaError('VALIDATION', `Could not extract the zip archive: ${(error as Error).message}`);
  }

  let actualTotal = 0;
  const out: ExtractedFile[] = [];
  for (const [name, content] of Object.entries(raw)) {
    actualTotal += content.byteLength;
    if (content.byteLength > limits.maxEntryBytes || actualTotal > limits.maxTotalBytes) {
      throw new TerminiaError('TOO_LARGE', 'The archive contents exceed the size limit.');
    }
    out.push({ path: safeJoin('', name), data: content });
  }

  if (stripRoot) {
    const roots = new Set(out.map((f) => f.path.split('/')[0]));
    if (roots.size === 1 && out.every((f) => f.path.includes('/'))) {
      return out.map((f) => ({ path: f.path.slice(f.path.indexOf('/') + 1), data: f.data }));
    }
  }
  return out;
}

const STORED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.gz', '.jar', '.apk', '.ipa', '.aab', '.woff2', '.mp4']);

export function createZip(files: { path: string; data: Uint8Array; mtime?: number }[]): Uint8Array {
  const tree: Zippable = {};
  for (const file of files) {
    const path = safeJoin('', file.path);
    const level = STORED_EXTENSIONS.has(extname(path)) ? 0 : 6;
    tree[path] = [file.data, { level, mtime: file.mtime ? new Date(file.mtime) : undefined }];
  }
  return zipSync(tree, { level: 6 });
}

/** macOS resource-fork folders and Finder metadata that should never be imported. */
function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name === '.DS_Store';
}

/** What a downloaded build artifact contains, judged by its zip entries. */
export type PackageKind = 'ipa' | 'apk' | 'aab' | 'wrapper' | 'zip';

/**
 * Classifies zip contents: IPAs contain Payload/<App>.app/, APKs contain
 * AndroidManifest.xml and classes.dex at the root, AABs contain
 * base/manifest/AndroidManifest.xml. Anything else that has exactly one
 * package-like file is a "wrapper" (the zip GitHub puts around artifacts).
 */
export function classifyZipEntries(names: string[]): { kind: PackageKind; inner?: string } {
  if (names.some((n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n)) || names.some((n) => /^Payload\/[^/]+\.app\//.test(n))) {
    return { kind: 'ipa' };
  }
  if (names.includes('AndroidManifest.xml') && names.some((n) => /^classes\d*\.dex$/.test(n))) return { kind: 'apk' };
  if (names.includes('base/manifest/AndroidManifest.xml') || names.includes('BundleConfig.pb')) return { kind: 'aab' };
  const files = names.filter((n) => !n.endsWith('/'));
  const packages = files.filter((n) => /\.(ipa|apk|aab)$/i.test(n));
  if (packages.length === 1) return { kind: 'wrapper', inner: packages[0] };
  if (files.length === 1) return { kind: 'wrapper', inner: files[0] };
  return { kind: 'zip' };
}
