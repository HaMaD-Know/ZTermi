import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORES, IgnoreRules } from '../../src/core/ignore';
import { classifyZipEntries, createZip, extractZip, isZip, listZip } from '../../src/core/zip';
import { fromUtf8, gitBlobSha, sha256Hex, utf8 } from '../../src/core/hash';
import { zipSync } from 'fflate';
import { isTerminiaError } from '../../src/core/errors';

describe('.gitignore matching', () => {
  const rules = new IgnoreRules()
    .add('', DEFAULT_IGNORES)
    .add('', ['dist/', '*.log', '!keep.log', '/root-only.txt', 'docs/**/*.tmp', '**/cache/', 'build-[0-9]'].join('\n'))
    .add('packages/web', 'generated/\n!important.log');

  it.each([
    ['node_modules/react/index.js', true],
    ['src/node_modules/x.js', true],
    ['dist/app.js', true],
    ['src/dist.ts', false],
    ['server.log', true],
    ['logs/keep.log', false],
    ['root-only.txt', true],
    ['sub/root-only.txt', false],
    ['docs/a/b/c.tmp', true],
    ['docs/c.tmp', true],
    ['a/cache/x', true],
    ['build-7', true],
    ['build-x', false],
    ['android/app/build/outputs/apk/debug/app-debug.apk', true],
    ['packages/web/generated/types.ts', true],
    ['generated/types.ts', false],
    ['packages/web/important.log', false],
    ['packages/web/other.log', true],
  ])('%s -> ignored=%s', (path, expected) => {
    expect(rules.isIgnored(path)).toBe(expected);
  });

  it('does not re-include files inside an ignored directory', () => {
    const r = new IgnoreRules().add('', 'vendor/\n!vendor/keep.js');
    expect(r.isIgnored('vendor/keep.js')).toBe(true);
  });

  it('honours directory-only patterns', () => {
    expect(rules.isIgnored('dist', true)).toBe(true);
    expect(rules.isIgnored('dist', false)).toBe(false);
    const r = new IgnoreRules().add('', 'tmp/');
    expect(r.matches('tmp', true)).toBe(true);
    expect(r.matches('tmp', false)).toBe(false);
  });
});

describe('zip archives', () => {
  it('round-trips files', () => {
    const zip = createZip([
      { path: 'a.txt', data: utf8('hello') },
      { path: 'src/b.ts', data: utf8('export {}') },
    ]);
    expect(isZip(zip)).toBe(true);
    expect(listZip(zip).map((e) => e.name).sort()).toEqual(['a.txt', 'src/b.ts']);
    const files = extractZip(zip);
    expect(files.map((f) => [f.path, fromUtf8(f.data)]).sort()).toEqual([
      ['a.txt', 'hello'],
      ['src/b.ts', 'export {}'],
    ]);
  });

  it('strips a single wrapping folder on request', () => {
    const zip = zipSync({ 'MyApp/package.json': utf8('{}'), 'MyApp/src/x.js': utf8('1') });
    expect(extractZip(zip, undefined, { stripRoot: true }).map((f) => f.path).sort()).toEqual(['package.json', 'src/x.js']);
  });

  it('rejects zip-slip entries', () => {
    const evil = zipSync({ '../../evil.sh': utf8('rm -rf /') });
    let caught: unknown;
    try {
      extractZip(evil);
    } catch (error) {
      caught = error;
    }
    expect(isTerminiaError(caught, 'INVALID_PATH')).toBe(true);
  });

  it('enforces size limits before extracting', () => {
    const zip = zipSync({ 'big.bin': new Uint8Array(4096) });
    expect(() => extractZip(zip, { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 1e9, maxRatio: 1000 })).toThrow(/larger than/);
    expect(() => extractZip(zip, { maxEntries: 0, maxEntryBytes: 1e9, maxTotalBytes: 1e9, maxRatio: 1000 })).toThrow(/limit is 0/);
  });

  it('classifies build packages by their contents', () => {
    expect(classifyZipEntries(['Payload/', 'Payload/App.app/', 'Payload/App.app/Info.plist'])).toEqual({ kind: 'ipa' });
    expect(classifyZipEntries(['AndroidManifest.xml', 'classes.dex', 'resources.arsc'])).toEqual({ kind: 'apk' });
    expect(classifyZipEntries(['base/manifest/AndroidManifest.xml', 'BundleConfig.pb'])).toEqual({ kind: 'aab' });
    expect(classifyZipEntries(['MyApp-unsigned.ipa'])).toEqual({ kind: 'wrapper', inner: 'MyApp-unsigned.ipa' });
    expect(classifyZipEntries(['app-debug.apk', 'output-metadata.json'])).toEqual({ kind: 'wrapper', inner: 'app-debug.apk' });
    expect(classifyZipEntries(['index.html', 'assets/app.js'])).toEqual({ kind: 'zip' });
  });
});

describe('hashing', () => {
  it('computes Git blob ids identical to git hash-object', async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobSha(utf8('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // empty blob
    expect(await gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('computes SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
