import { TerminiaError } from './errors';

/**
 * POSIX path helpers for Terminia's virtual filesystem.
 *
 * Two kinds of paths exist:
 *  - VFS paths are absolute ("/workspace/app/src/main.ts"). `..` above "/"
 *    clamps to "/", exactly like a shell.
 *  - Backend paths are relative to a storage root ("app/src/main.ts"). They
 *    must never escape the root, so `validateRelativePath` rejects `..`,
 *    absolute paths, NUL and control characters, and backslashes.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return '/' + out.join('/');
}

/** Resolves `input` against the current directory `cwd` (both VFS paths). `~` is the workspace. */
export function resolvePath(cwd: string, input: string, home = '/workspace'): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return normalizeAbsolute(home + input.slice(1));
  if (input.startsWith('/')) return normalizeAbsolute(input);
  return normalizeAbsolute(`${cwd}/${input}`);
}

export function joinPath(...parts: string[]): string {
  const joined = parts.filter((p) => p !== '').join('/');
  if (joined.startsWith('/')) return normalizeAbsolute(joined);
  return normalizeRelative(joined);
}

/** Normalises a relative path without allowing it to climb above its root. */
export function normalizeRelative(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new TerminiaError('INVALID_PATH', `Path escapes its root: ${path}`);
      out.pop();
    } else out.push(segment);
  }
  return out.join('/');
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index === -1) return '';
  if (index === 0) return '/';
  return trimmed.slice(0, index);
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

export function stem(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? name : name.slice(0, index);
}

/**
 * Validates a backend-relative path. Returns it normalised (no "." segments,
 * no duplicate slashes) or throws INVALID_PATH.
 */
export function validateRelativePath(path: string, { allowEmpty = true } = {}): string {
  if (typeof path !== 'string') throw new TerminiaError('INVALID_PATH', 'Path must be a string.');
  if (path.length > MAX_PATH_LENGTH) throw new TerminiaError('INVALID_PATH', 'Path is too long.');
  if (CONTROL_CHARS.test(path)) throw new TerminiaError('INVALID_PATH', 'Path contains control characters.');
  if (path.includes('\\')) throw new TerminiaError('INVALID_PATH', `Backslashes are not allowed in paths: ${path}`);
  if (path.startsWith('/')) throw new TerminiaError('INVALID_PATH', `Expected a relative path: ${path}`);
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (segment === '..') throw new TerminiaError('INVALID_PATH', `Path escapes its root: ${path}`);
    if (segment.length > MAX_SEGMENT_LENGTH) throw new TerminiaError('INVALID_PATH', 'A file name is too long.');
  }
  const normalized = segments.join('/');
  if (!allowEmpty && normalized === '') throw new TerminiaError('INVALID_PATH', 'Path is empty.');
  return normalized;
}

/** Validates a single file or folder name (no separators). */
export function validateFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new TerminiaError('INVALID_PATH', 'Name is empty.');
  if (trimmed === '.' || trimmed === '..') throw new TerminiaError('INVALID_PATH', `'${trimmed}' is not a valid name.`);
  if (/[/\\:]/.test(trimmed)) throw new TerminiaError('INVALID_PATH', 'Names cannot contain /, \\ or :.');
  if (CONTROL_CHARS.test(trimmed)) throw new TerminiaError('INVALID_PATH', 'Names cannot contain control characters.');
  if (trimmed.length > MAX_SEGMENT_LENGTH) throw new TerminiaError('INVALID_PATH', 'Name is too long.');
  return trimmed;
}

/**
 * Joins an untrusted relative path (for example a zip entry name) onto a base
 * and guarantees the result stays inside it. Windows separators are treated as
 * separators so "..\\evil" cannot slip through.
 */
export function safeJoin(base: string, untrusted: string): string {
  const unified = untrusted.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new TerminiaError('INVALID_PATH', `Absolute path not allowed: ${untrusted}`);
  }
  const relative = validateRelativePath(unified, { allowEmpty: false });
  return base ? `${base.replace(/\/+$/, '')}/${relative}` : relative;
}

/** True when `path` equals `root` or lies inside it (both VFS paths). */
export function isInside(path: string, root: string): boolean {
  const p = normalizeAbsolute(path);
  const r = normalizeAbsolute(root);
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}

/** Path of `path` relative to `root`; throws when it is outside. */
export function relativeTo(root: string, path: string): string {
  if (!isInside(path, root)) throw new TerminiaError('INVALID_PATH', `${path} is not inside ${root}`);
  const r = normalizeAbsolute(root);
  const p = normalizeAbsolute(path);
  return p === r ? '' : p.slice(r === '/' ? 1 : r.length + 1);
}

/** Shortens a VFS path for prompts: /workspace/app -> ~/app. */
export function displayPath(path: string, home = '/workspace'): string {
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
