// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness';

describe('local shell', () => {
  it('runs built-ins and pipes stdout between commands', async () => {
    const h = createHarness();
    expect((await h.run('echo one two three | wc -w')).out).toBe('3');
    expect((await h.run("echo 'b\na\nb' | sort -u")).out).toBe('a\nb');
  });

  it('redirects to files and appends', async () => {
    const h = createHarness();
    await h.run('echo first > notes.txt');
    await h.run('echo second >> notes.txt');
    expect((await h.run('cat notes.txt')).out).toBe('first\nsecond');
    expect((await h.workspace.readText('notes.txt')).text).toBe('first\nsecond\n');
  });

  it('honours && and || by exit code', async () => {
    const h = createHarness();
    expect((await h.run('cat missing.txt && echo yes || echo no')).out).toBe('no');
    expect((await h.run('echo ok && echo yes')).out).toBe('ok\nyes');
  });

  it('explains tools that do not exist on iPad instead of pretending', async () => {
    const h = createHarness();
    const npm = await h.run('npm install');
    expect(npm.code).toBe(127);
    expect(npm.err).toContain('not available on iPad');
    expect(npm.info).toContain('terminia deps');
    const cmdlet = await h.run('Get-Process');
    expect(cmdlet.err).toContain('PowerShell cmdlet');
    expect(cmdlet.info).toContain('remote connect');
    const typo = await h.run('lss');
    expect(typo.err).toContain("Did you mean 'ls'");
  });

  it('refuses PowerShell syntax in local mode with a pointer to remote hosts', async () => {
    const h = createHarness();
    const r = await h.run('$files = ls');
    expect(r.code).toBe(126);
    expect(r.err).toContain('Not supported');
    expect(r.info).toContain('remote connect');
  });

  it('records the execution target of every command', async () => {
    const h = createHarness();
    await h.run('ls; terminia targets');
    const entry = h.session.entries[h.session.entries.length - 1]!;
    expect(entry.targets.map((t) => t.label)).toEqual(['Local iPad', 'Local iPad']);
    await h.run('terminia ios build --help');
    expect(h.session.entries[h.session.entries.length - 1]!.lines.map((l) => l.text).join('\n')).toContain('Runs on: GitHub Actions · macOS builder');
  });

  it('shows help for groups and suggests subcommands', async () => {
    const h = createHarness();
    const group = await h.run('terminia ios');
    expect(group.out).toContain('configure');
    expect(group.out).toContain('download');
    const typo = await h.run('terminia ios biuld');
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("Did you mean 'build'");
    expect((await h.run('help')).out).toContain('Local commands run on this iPad');
  });

  it('reports usage errors with exit code 2', async () => {
    const h = createHarness();
    const r = await h.run('terminia ios build --configuration beta');
    expect(r.code).toBe(2);
    expect(r.err).toContain('must be one of: debug, release');
  });

  it('cancels a running command', async () => {
    const h = createHarness();
    const running = h.run('sleep 30');
    setTimeout(() => h.session.cancel(), 30);
    const r = await running;
    expect(r.code).toBe(130);
  });

  it('which tells where a command runs', async () => {
    const h = createHarness();
    expect((await h.run('which ls npm')).out).toMatch(/ls: Terminia built-in.*Local iPad[\s\S]*npm: not a Terminia command/);
  });
});

describe('file commands', () => {
  it('creates, lists, moves, copies and removes files inside the workspace', async () => {
    const h = createHarness();
    await h.run('mkdir -p app/src');
    await h.run('cd app');
    expect((await h.run('pwd')).out).toBe('/workspace/app');
    await h.run("echo 'console.log(1)' > src/index.js");
    expect((await h.run('ls src')).out).toBe('index.js');
    await h.run('cp -r src lib');
    await h.run('mv lib/index.js lib/main.js');
    expect((await h.run('find . -name "*.js"')).out.split('\n').sort()).toEqual(['~/app/lib/main.js', '~/app/src/index.js']);
    await h.run('Remove-Item lib -Recurse -Force');
    expect(await h.services.vfs.exists('/workspace/app/lib')).toBe(false);
  });

  it('asks before deleting a non-empty folder and keeps it when declined', async () => {
    const h = createHarness({ files: { 'keep/a.txt': 'a' } });
    h.ui.autoConfirm = false;
    const r = await h.run('rm -r keep');
    expect(r.info).toContain('Kept');
    expect(h.ui.confirmations[0]?.danger).toBe(true);
    expect(await h.services.vfs.exists('/workspace/keep/a.txt')).toBe(true);
  });

  it('cannot reach outside the workspace or delete the workspace itself', async () => {
    const h = createHarness();
    const outside = await h.run('cat /etc/passwd');
    expect(outside.err).toContain('No such file');
    expect((await h.run('cd ../../..; pwd')).out).toBe('/');
    const root = await h.run('rm -rf /workspace');
    expect(root.err).toContain('Refusing to delete /workspace');
  });

  it('greps with line numbers, recursively and from pipes', async () => {
    const h = createHarness({ files: { 'p/a.ts': 'const x = 1;\n// TODO fix\n', 'p/b.ts': 'todo later\n' } });
    expect((await h.run('grep -n TODO p/a.ts')).out).toBe('2:// TODO fix');
    expect((await h.run('grep -ri todo p')).out.split('\n').sort()).toEqual(['~/p/a.ts:// TODO fix', '~/p/b.ts:todo later']);
    expect((await h.run('Select-String -Pattern TODO -Path p/b.ts')).out).toContain('todo later');
    expect((await h.run('cat p/a.ts | grep -c const')).code).toBe(2);
  });

  it('zips and unzips, refusing entries that escape the destination', async () => {
    const h = createHarness({ files: { 'site/index.html': '<h1>x</h1>', 'site/css/s.css': 'body{}' } });
    expect((await h.run('zip site.zip site')).out).toContain('2 file(s)');
    await h.run('unzip site.zip -d out');
    expect((await h.services.vfs.readText('/workspace/out/site/css/s.css')).text).toBe('body{}');
    const { zipSync } = await import('fflate');
    await h.workspace.writeBytes('evil.zip', zipSync({ '../../escape.txt': new TextEncoder().encode('x') }));
    expect((await h.run('unzip evil.zip')).err).toContain('escapes');
  });

  it('hashes files like Get-FileHash', async () => {
    const h = createHarness({ files: { 'abc.txt': 'abc' } });
    expect((await h.run('Get-FileHash abc.txt')).out).toContain('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
  });

  it('head, tail and wc read files or pipes', async () => {
    const h = createHarness({ files: { 'n.txt': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') } });
    expect((await h.run('head -n 2 n.txt')).out).toBe('line 1\nline 2');
    expect((await h.run('tail -n 1 n.txt')).out).toBe('line 30');
    expect((await h.run('cat n.txt | wc -l')).out).toBe('30');
  });
});

describe('completion', () => {
  it('completes commands, subcommands, options, values and paths', async () => {
    const h = createHarness({ files: { 'Demo/src/main.ts': '', 'Demo/package.json': '{}' } });
    const names = async (input: string) => (await h.session.complete(input, input.length)).candidates.map((c) => c.value);
    expect(await names('term')).toContain('terminia');
    expect(await names('terminia io')).toEqual(['ios']);
    expect(await names('terminia ios b')).toEqual(['build']);
    expect(await names('terminia ios build --conf')).toEqual(['--configuration']);
    expect(await names('terminia ios build --configuration ')).toEqual(['debug', 'release']);
    expect(await names('cat Demo/s')).toEqual(['Demo/src/']);
    expect(await names('cd De')).toEqual(['Demo/']);
  });
});
