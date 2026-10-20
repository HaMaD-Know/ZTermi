import { describe, expect, it } from 'vitest';
import { parseArgs, type OptionSpec } from '../../src/terminal/args';
import { needsContinuation, parseScript, quoteArg, tokenize } from '../../src/terminal/tokenizer';
import { CommandHistory } from '../../src/terminal/history';
import { isTerminiaError } from '../../src/core/errors';

function words(input: string): string[] {
  return tokenize(input)
    .tokens.filter((t) => t.kind === 'word')
    .map((t) => (t as { value: string }).value);
}

describe('tokenizer', () => {
  it('splits words and keeps quoted spaces', () => {
    expect(words(`cat 'my file.txt' "other file" plain`)).toEqual(['cat', 'my file.txt', 'other file', 'plain']);
  });

  it('applies PowerShell quoting rules', () => {
    expect(words(`echo 'it''s' "say ""hi""" a\`ny`)).toEqual(['echo', "it's", 'say "hi"', 'any']);
    expect(words('echo "tab`there"')).toEqual(['echo', 'tab\there']);
  });

  it('recognises operators and redirections', () => {
    const ops = tokenize('a | b && c || d ; e > f >> g 2> h 2>&1').tokens.filter((t) => t.kind === 'op').map((t) => (t as { op: string }).op);
    expect(ops).toEqual(['|', '&&', '||', ';', '>', '>>', '2>', '2>&1']);
  });

  it('treats # at a word start as a comment', () => {
    expect(words('ls # list files')).toEqual(['ls']);
    expect(words('echo a#b')).toEqual(['echo', 'a#b']);
  });

  it('detects incomplete input for continuation lines', () => {
    expect(needsContinuation(`echo 'unterminated`)).toBe(true);
    expect(needsContinuation('ls |')).toBe(true);
    expect(needsContinuation('echo ok `')).toBe(true);
    expect(needsContinuation('echo ok')).toBe(false);
  });

  it.each([
    ['$x = 1', 'variables ($name)'],
    ['echo $(Get-Date)', 'subexpression $( )'],
    ['ls | ForEach-Object { $_ }', 'script blocks { }'],
    ['echo "hi $name"', 'variable expansion in double quotes'],
    ['@(1,2)', 'array subexpression @( )'],
    ['notepad &', 'call/background operator &'],
  ])('reports PowerShell-only syntax instead of half-running it: %s', (input, feature) => {
    expect(tokenize(input).unsupported.map((u) => u.feature)).toContain(feature);
    let error: unknown;
    try {
      parseScript(input);
    } catch (e) {
      error = e;
    }
    expect(isTerminiaError(error, 'UNSUPPORTED')).toBe(true);
  });

  it('allows a literal $ that is not a variable', () => {
    expect(words('echo 5$')).toEqual(['echo', '5$']);
    expect(words("echo '$literal'")).toEqual(['echo', '$literal']);
  });

  it('parses sequences, pipelines and redirects', () => {
    const script = parseScript('cat a.txt | grep x > out.txt && echo done; ls');
    expect(script.items).toHaveLength(3);
    expect(script.items[0]!.pipeline.commands.map((c) => c.argv[0])).toEqual(['cat', 'grep']);
    expect(script.items[0]!.pipeline.commands[1]!.redirects).toEqual([{ op: '>', target: 'out.txt' }]);
    expect(script.items[1]!.connector).toBe('&&');
    expect(script.items[2]!.connector).toBe(';');
  });

  it('rejects malformed operators', () => {
    expect(() => parseScript('| ls')).toThrow(/before '\|'/);
    expect(() => parseScript('echo >')).toThrow(/incomplete|Missing file name/);
  });

  it('quotes arguments so they round-trip', () => {
    for (const value of ['plain', 'with space', "it's", '']) expect(words(`x ${quoteArg(value)}`)[1] ?? '').toBe(value);
  });
});

describe('argument parsing', () => {
  const options: OptionSpec[] = [
    { name: 'configuration', short: 'c', type: 'enum', values: ['debug', 'release'], description: '' },
    { name: 'force', short: 'f', aliases: ['Force'], type: 'boolean', description: '' },
    { name: 'recursive', short: 'r', aliases: ['Recurse'], type: 'boolean', description: '' },
    { name: 'lines', short: 'n', type: 'number', description: '' },
    { name: 'follow', type: 'boolean', description: '' },
    { name: 'tag', type: 'string', repeatable: true, description: '' },
  ];

  it('accepts GNU and PowerShell styles, case-insensitively', () => {
    expect(parseArgs(['--configuration', 'release'], options).options.configuration).toBe('release');
    expect(parseArgs(['--configuration=debug'], options).options.configuration).toBe('debug');
    expect(parseArgs(['-Configuration', 'Release'], options).options.configuration).toBe('release');
    expect(parseArgs(['-c', 'DEBUG'], options).options.configuration).toBe('debug');
    expect(parseArgs(['-Recurse', '-Force'], options).options).toMatchObject({ recursive: true, force: true });
    expect(parseArgs(['-rf'], options).options).toMatchObject({ recursive: true, force: true });
    expect(parseArgs(['-n5'], options).options.lines).toBe(5);
    expect(parseArgs(['--no-follow'], options).options.follow).toBe(false);
    expect(parseArgs(['--tag', 'a', '--tag', 'b'], options).options.tag).toEqual(['a', 'b']);
  });

  it('keeps arguments after -- untouched', () => {
    const parsed = parseArgs(['host', '--', 'Get-Process', '-Name', 'x'], options, [{ name: 'host', description: '' }]);
    expect(parsed.positionals).toEqual(['host']);
    expect(parsed.rest).toEqual(['Get-Process', '-Name', 'x']);
  });

  it('explains invalid input', () => {
    expect(() => parseArgs(['--configuraton', 'release'], options)).toThrow(/Did you mean '--configuration'/);
    expect(() => parseArgs(['--configuration', 'beta'], options)).toThrow(/must be one of: debug, release/);
    expect(() => parseArgs(['--configuration'], options)).toThrow(/needs a value/);
    expect(() => parseArgs(['--lines', 'many'], options)).toThrow(/expects a number/);
    expect(() => parseArgs([], options, [{ name: 'name', description: '', required: true }])).toThrow(/Missing required argument <name>/);
    expect(() => parseArgs(['a', 'b'], options, [{ name: 'one', description: '' }])).toThrow(/Unexpected argument 'b'/);
  });

  it('treats negative numbers as positionals', () => {
    expect(parseArgs(['-5'], options, [{ name: 'n', description: '' }]).positionals).toEqual(['-5']);
  });
});

describe('command history', () => {
  it('navigates like a shell and keeps the draft', () => {
    const h = new CommandHistory();
    h.add('ls');
    h.add('cd src');
    h.add('cd src');
    expect(h.all()).toEqual(['ls', 'cd src']);
    expect(h.previous('draft')).toBe('cd src');
    expect(h.previous('draft')).toBe('ls');
    expect(h.previous('draft')).toBeNull();
    expect(h.next()).toBe('cd src');
    expect(h.next()).toBe('draft');
  });

  it('never stores secrets or lines starting with a space', () => {
    const h = new CommandHistory();
    h.add(' secret-command');
    h.add(`echo ${'ghp_' + 'a'.repeat(36)}`);
    expect(h.all()).toEqual(['echo [REDACTED]']);
  });

  it('filters by prefix and searches', () => {
    const h = new CommandHistory(['terminia ios build', 'ls', 'terminia android build']);
    expect(h.previous('', 'terminia')).toBe('terminia android build');
    expect(h.search('ios')).toEqual(['terminia ios build']);
  });
});
