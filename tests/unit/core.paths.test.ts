import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  displayPath,
  extname,
  isInside,
  normalizeAbsolute,
  relativeTo,
  resolvePath,
  safeJoin,
  validateFileName,
  validateRelativePath,
} from '../../src/core/paths';
import { isTerminiaError } from '../../src/core/errors';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isTerminiaError(error) ? error.code : 'OTHER';
  }
}

describe('VFS path resolution', () => {
  it('normalises absolute paths and clamps .. at the root', () => {
    expect(normalizeAbsolute('/workspace//app/./src/../lib')).toBe('/workspace/app/lib');
    expect(normalizeAbsolute('/../../etc')).toBe('/etc');
    expect(normalizeAbsolute('')).toBe('/');
  });

  it('resolves relative input against the cwd and ~ against the workspace', () => {
    expect(resolvePath('/workspace/app', 'src/main.ts')).toBe('/workspace/app/src/main.ts');
    expect(resolvePath('/workspace/app', '..')).toBe('/workspace');
    expect(resolvePath('/workspace/app', '/folders/x')).toBe('/folders/x');
    expect(resolvePath('/folders/x', '~')).toBe('/workspace');
    expect(resolvePath('/folders/x', '~/app')).toBe('/workspace/app');
  });

  it('computes containment and relative paths', () => {
    expect(isInside('/workspace/app/a', '/workspace/app')).toBe(true);
    expect(isInside('/workspace/application', '/workspace/app')).toBe(false);
    expect(isInside('/anything', '/')).toBe(true);
    expect(relativeTo('/workspace', '/workspace/app/x.ts')).toBe('app/x.ts');
    expect(relativeTo('/workspace', '/workspace')).toBe('');
    expect(code(() => relativeTo('/workspace/app', '/workspace/other'))).toBe('INVALID_PATH');
  });

  it('formats prompt paths and file name parts', () => {
    expect(displayPath('/workspace')).toBe('~');
    expect(displayPath('/workspace/app/src')).toBe('~/app/src');
    expect(displayPath('/folders/Repo')).toBe('/folders/Repo');
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(dirname('/a/b/c.txt')).toBe('/a/b');
    expect(dirname('c.txt')).toBe('');
    expect(extname('archive.TAR.GZ')).toBe('.gz');
    expect(extname('.gitignore')).toBe('');
  });
});

describe('path traversal protection', () => {
  it('accepts normal relative paths and normalises them', () => {
    expect(validateRelativePath('app/./src//main.ts')).toBe('app/src/main.ts');
    expect(validateRelativePath('')).toBe('');
  });

  it.each([
    ['../secret', 'parent traversal'],
    ['app/../../x', 'nested traversal'],
    ['/etc/passwd', 'absolute path'],
    ['app\\..\\x', 'backslash'],
    ['bad\u0000name', 'NUL byte'],
    ['line\nbreak', 'control character'],
  ])('rejects %s (%s)', (input) => {
    expect(code(() => validateRelativePath(input))).toBe('INVALID_PATH');
  });

  it('safeJoin keeps archive entries inside the destination', () => {
    expect(safeJoin('import', 'src/a.ts')).toBe('import/src/a.ts');
    expect(code(() => safeJoin('import', '../../evil.sh'))).toBe('INVALID_PATH');
    expect(code(() => safeJoin('import', '..\\..\\evil.sh'))).toBe('INVALID_PATH');
    expect(code(() => safeJoin('import', '/abs/evil'))).toBe('INVALID_PATH');
    expect(code(() => safeJoin('import', 'C:/Windows/evil'))).toBe('INVALID_PATH');
  });

  it('validates single file names', () => {
    expect(validateFileName('  main.ts ')).toBe('main.ts');
    expect(code(() => validateFileName('a/b'))).toBe('INVALID_PATH');
    expect(code(() => validateFileName('..'))).toBe('INVALID_PATH');
    expect(code(() => validateFileName(''))).toBe('INVALID_PATH');
  });
});
