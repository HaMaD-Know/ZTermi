import { TerminiaError } from '../core/errors';
import { fromUtf8, sha1Hex, sha256Hex, utf8 } from '../core/hash';
import { basename, displayPath, joinPath, safeJoin } from '../core/paths';
import { isProbablyBinary } from '../core/secrets';
import { formatBytes, formatDateTime } from '../core/util';
import { createZip, extractZip } from '../core/zip';
import { bool, num, str } from '../terminal/args';
import type { CommandContext, CommandSpec } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { abs, confirm, YES } from './common';

/**
 * Local file commands. They run on the iPad, inside /workspace and folders
 * opened through the document picker. PowerShell-style names are provided as
 * aliases for familiarity; these are Terminia built-ins, not PowerShell
 * cmdlets, and support only the options listed in their help.
 */

const GROUP = 'Files';
const TEXT = 'Text';

function pathArgs(ctx: CommandContext, fallback?: string): string[] {
  const fromOption = str(ctx.args, 'path');
  const list = [...(fromOption ? [fromOption] : []), ...ctx.args.positionals];
  if (!list.length && fallback !== undefined) list.push(fallback);
  return list.map((p) => abs(ctx, p));
}

async function readInput(ctx: CommandContext, files: string[]): Promise<string> {
  if (files.length) {
    const parts: string[] = [];
    for (const file of files) parts.push(await readTextFile(ctx, file));
    return parts.join('');
  }
  if (ctx.stdin !== null) return ctx.stdin;
  throw new TerminiaError('INVALID_ARGUMENT', 'No input: name a file or pipe text into this command.');
}

async function readTextFile(ctx: CommandContext, file: string): Promise<string> {
  const stat = await ctx.services.vfs.stat(file);
  if (stat.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `${displayPath(file)} is a directory.`);
  const data = await ctx.services.vfs.readBytes(file, 20 * 1024 * 1024);
  if (isProbablyBinary(file, data)) throw new TerminiaError('UNSUPPORTED', `${displayPath(file)} is a binary file.`, { hint: 'Use `sha256` or `stat` for binary files.' });
  return fromUtf8(data);
}

function lines(text: string): string[] {
  const out = text.split(/\r?\n/);
  if (out[out.length - 1] === '') out.pop();
  return out;
}

function globToRegex(glob: string, caseInsensitive = true): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, caseInsensitive ? 'i' : '');
}

function modeString(type: string): string {
  return type === 'directory' ? 'd----' : '-a---';
}

const pathOption = { name: 'path', aliases: ['LiteralPath'], type: 'string' as const, description: 'Path (PowerShell style; same as the positional argument)', complete: 'path' as const };

const ls: CommandSpec = {
  name: 'ls',
  aliases: ['dir', 'gci', 'Get-ChildItem'],
  group: GROUP,
  summary: 'List a directory',
  target: LOCAL,
  options: [
    { name: 'all', short: 'a', aliases: ['Force'], type: 'boolean', description: 'Include hidden entries (names starting with .)' },
    { name: 'long', short: 'l', type: 'boolean', description: 'Long listing (mode, size, modified time)' },
    { name: 'recurse', short: 'R', aliases: ['Recursive'], type: 'boolean', description: 'List subdirectories too' },
    { name: 'filter', aliases: ['Include'], type: 'string', description: 'Only names matching a wildcard, e.g. *.ts' },
    pathOption,
  ],
  positionals: [{ name: 'path', description: 'Directory or file (default: current directory)', variadic: true, complete: 'path' }],
  examples: ['ls', 'ls -la src', 'Get-ChildItem -Recurse -Filter *.swift'],
  async run(ctx) {
    const targets = pathArgs(ctx, ctx.session.cwd());
    const long = bool(ctx.args, 'long') || /^(dir|gci|get-childitem)$/i.test(ctx.invokedAs);
    const all = bool(ctx.args, 'all');
    const filter = str(ctx.args, 'filter');
    const re = filter ? globToRegex(filter) : null;
    const rows: string[][] = [];
    const names: string[] = [];
    const visit = async (dir: string, prefix: string, depth: number) => {
      const entries = await ctx.services.vfs.list(dir);
      for (const e of entries) {
        if (!all && e.name.startsWith('.')) continue;
        const shown = prefix + e.name + (e.type === 'directory' ? '/' : '');
        if (!re || re.test(e.name)) {
          rows.push([modeString(e.type), e.type === 'file' ? formatBytes(e.size) : '', e.mtime ? formatDateTime(e.mtime) : '', shown]);
          names.push(shown);
        }
        if (bool(ctx.args, 'recurse') && e.type === 'directory' && depth < 30 && e.name !== 'node_modules' && e.name !== '.git') await visit(e.path, `${prefix}${e.name}/`, depth + 1);
      }
    };
    for (const target of targets) {
      const s = await ctx.services.vfs.stat(target);
      if (s.type === 'file') {
        rows.push([modeString('file'), formatBytes(s.size), formatDateTime(s.mtime), basename(target)]);
        names.push(basename(target));
        continue;
      }
      if (targets.length > 1) ctx.out.writeln(`${displayPath(target)}:`);
      await visit(target, '', 0);
    }
    if (long) ctx.out.table(rows, ['Mode', 'Size', 'LastWriteTime', 'Name']);
    else if (names.length) ctx.out.writeln(names.join('\n'));
  },
};

const cd: CommandSpec = {
  name: 'cd',
  aliases: ['chdir', 'sl', 'Set-Location'],
  group: GROUP,
  summary: 'Change the current directory',
  target: LOCAL,
  options: [pathOption],
  positionals: [{ name: 'path', description: 'Directory (default: ~, the workspace)', complete: 'directory' }],
  async run(ctx) {
    const [target] = pathArgs(ctx, '~');
    if (!(await ctx.services.vfs.isDirectory(target!))) {
      throw new TerminiaError('NOT_FOUND', `${displayPath(target!)} is not a directory.`);
    }
    ctx.session.setCwd(target!);
  },
};

const pwd: CommandSpec = {
  name: 'pwd',
  aliases: ['gl', 'Get-Location'],
  group: GROUP,
  summary: 'Print the current directory',
  target: LOCAL,
  async run(ctx) {
    ctx.out.writeln(ctx.session.cwd());
  },
};

const cat: CommandSpec = {
  name: 'cat',
  aliases: ['type', 'gc', 'Get-Content'],
  group: TEXT,
  summary: 'Print text files',
  target: LOCAL,
  options: [{ name: 'number', short: 'n', type: 'boolean', description: 'Number lines' }, pathOption],
  positionals: [{ name: 'file', description: 'Files (or piped input)', variadic: true, complete: 'file' }],
  async run(ctx) {
    const text = await readInput(ctx, pathArgs(ctx));
    if (bool(ctx.args, 'number')) ctx.out.writeln(lines(text).map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n'));
    else ctx.out.write(text.endsWith('\n') || !text ? text : `${text}\n`);
  },
};

const headTail = (name: 'head' | 'tail'): CommandSpec => ({
  name,
  group: TEXT,
  summary: name === 'head' ? 'Print the first lines' : 'Print the last lines',
  target: LOCAL,
  options: [{ name: 'lines', short: 'n', aliases: [name === 'head' ? 'TotalCount' : 'Tail'], type: 'number', description: 'Number of lines (default 10)' }],
  positionals: [{ name: 'file', description: 'Files (or piped input)', variadic: true, complete: 'file' }],
  async run(ctx) {
    const count = Math.max(0, num(ctx.args, 'lines') ?? 10);
    const all = lines(await readInput(ctx, pathArgs(ctx)));
    const picked = name === 'head' ? all.slice(0, count) : all.slice(Math.max(0, all.length - count));
    if (picked.length) ctx.out.writeln(picked.join('\n'));
  },
});

const wc: CommandSpec = {
  name: 'wc',
  group: TEXT,
  summary: 'Count lines, words and bytes',
  target: LOCAL,
  options: [
    { name: 'lines', short: 'l', type: 'boolean', description: 'Lines only' },
    { name: 'words', short: 'w', type: 'boolean', description: 'Words only' },
    { name: 'bytes', short: 'c', type: 'boolean', description: 'Bytes only' },
  ],
  positionals: [{ name: 'file', description: 'Files (or piped input)', variadic: true, complete: 'file' }],
  async run(ctx) {
    const text = await readInput(ctx, pathArgs(ctx));
    const counts = { lines: lines(text).length, words: (text.match(/\S+/g) ?? []).length, bytes: utf8(text).byteLength };
    const only = (['lines', 'words', 'bytes'] as const).filter((k) => bool(ctx.args, k));
    ctx.out.writeln((only.length ? only : (['lines', 'words', 'bytes'] as const)).map((k) => String(counts[k])).join('\t'));
  },
};

const grep: CommandSpec = {
  name: 'grep',
  aliases: ['sls', 'Select-String'],
  group: TEXT,
  summary: 'Search text with a regular expression',
  description: 'grep is case-sensitive unless -i is given. The Select-String alias is case-insensitive unless -CaseSensitive is given, as in PowerShell.',
  target: LOCAL,
  options: [
    { name: 'ignore-case', short: 'i', type: 'boolean', description: 'Case-insensitive' },
    { name: 'CaseSensitive', type: 'boolean', description: 'Case-sensitive (Select-String)' },
    { name: 'line-number', short: 'n', type: 'boolean', description: 'Show line numbers' },
    { name: 'recursive', short: 'r', aliases: ['Recurse'], type: 'boolean', description: 'Search directories recursively' },
    { name: 'files-with-matches', short: 'l', aliases: ['List'], type: 'boolean', description: 'Only print file names' },
    { name: 'invert-match', short: 'v', aliases: ['NotMatch'], type: 'boolean', description: 'Print non-matching lines' },
    { name: 'fixed-strings', short: 'F', aliases: ['SimpleMatch'], type: 'boolean', description: 'Pattern is plain text, not a regex' },
    { name: 'pattern', aliases: ['Pattern'], type: 'string', description: 'Pattern (PowerShell style)' },
    pathOption,
  ],
  positionals: [{ name: 'pattern-and-files', description: 'PATTERN [FILE...] (files can be directories with -r)', variadic: true, complete: 'path' }],
  async run(ctx) {
    const positional = [...ctx.args.positionals];
    const pattern = str(ctx.args, 'pattern') ?? positional.shift();
    if (!pattern) throw new TerminiaError('INVALID_ARGUMENT', 'Missing search pattern.');
    const isSls = /^(sls|select-string)$/i.test(ctx.invokedAs);
    const insensitive = bool(ctx.args, 'ignore-case') || (isSls && !bool(ctx.args, 'CaseSensitive'));
    let re: RegExp;
    try {
      re = new RegExp(bool(ctx.args, 'fixed-strings') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, insensitive ? 'i' : '');
    } catch (error) {
      throw new TerminiaError('INVALID_ARGUMENT', `Invalid regular expression: ${(error as Error).message}`);
    }
    const invert = bool(ctx.args, 'invert-match');
    const fileOption = str(ctx.args, 'path');
    const targets = [...(fileOption ? [fileOption] : []), ...positional].map((p) => abs(ctx, p));
    let matched = 0;
    const search = (text: string, label: string | null) => {
      const all = lines(text);
      let fileMatched = false;
      all.forEach((line, i) => {
        if (re.test(line) !== invert) {
          matched++;
          fileMatched = true;
          if (!bool(ctx.args, 'files-with-matches')) {
            ctx.out.writeln(`${label ? `${label}:` : ''}${bool(ctx.args, 'line-number') || (isSls && label) ? `${i + 1}:` : ''}${line}`);
          }
        }
      });
      if (fileMatched && bool(ctx.args, 'files-with-matches') && label) ctx.out.writeln(label);
    };
    if (!targets.length) {
      if (ctx.stdin === null) throw new TerminiaError('INVALID_ARGUMENT', 'Name files to search, or pipe text into grep.');
      search(ctx.stdin, null);
    } else {
      const showNames = targets.length > 1 || bool(ctx.args, 'recursive');
      for (const target of targets) {
        if (await ctx.services.vfs.isDirectory(target)) {
          if (!bool(ctx.args, 'recursive')) {
            ctx.out.error(`grep: ${displayPath(target)} is a directory (use -r)`);
            continue;
          }
          const files = await ctx.services.vfs.walk(target, { signal: ctx.signal, ignore: (p, isDir) => isDir && (p.endsWith('node_modules') || p.endsWith('.git')) });
          for (const f of files) {
            if (f.size > 2 * 1024 * 1024 || isProbablyBinary(f.path)) continue;
            const full = joinPath(target, f.path);
            const data = await ctx.services.vfs.readBytes(full);
            if (!isProbablyBinary(f.path, data)) search(fromUtf8(data), displayPath(full));
          }
        } else search(await readTextFile(ctx, target), showNames ? displayPath(target) : null);
      }
    }
    return matched ? 0 : 1;
  },
};

const find: CommandSpec = {
  name: 'find',
  group: GROUP,
  summary: 'Find files by name',
  target: LOCAL,
  options: [
    { name: 'name', type: 'string', description: 'Wildcard on the file name, e.g. *.json' },
    { name: 'type', type: 'enum', values: ['f', 'd'], description: 'f = files, d = directories' },
  ],
  positionals: [{ name: 'dir', description: 'Where to search (default: current directory)', complete: 'directory' }],
  examples: ['find . -name "*.swift"', 'find src -type d'],
  async run(ctx) {
    const root = abs(ctx, ctx.args.positionals[0] ?? '.');
    const re = str(ctx.args, 'name') ? globToRegex(str(ctx.args, 'name')!) : null;
    const type = str(ctx.args, 'type');
    const out: string[] = [];
    const visit = async (dir: string, depth: number) => {
      for (const e of await ctx.services.vfs.list(dir)) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const okType = !type || (type === 'f' ? e.type === 'file' : e.type === 'directory');
        if (okType && (!re || re.test(e.name))) out.push(displayPath(e.path));
        if (e.type === 'directory' && depth < 40) await visit(e.path, depth + 1);
      }
    };
    await visit(root, 0);
    if (out.length) ctx.out.writeln(out.join('\n'));
  },
};

const tree: CommandSpec = {
  name: 'tree',
  group: GROUP,
  summary: 'Show a directory tree',
  target: LOCAL,
  options: [
    { name: 'level', short: 'L', type: 'number', description: 'Maximum depth (default 4)' },
    { name: 'all', short: 'a', type: 'boolean', description: 'Include hidden entries' },
  ],
  positionals: [{ name: 'dir', description: 'Directory (default: current)', complete: 'directory' }],
  async run(ctx) {
    const root = abs(ctx, ctx.args.positionals[0] ?? '.');
    const max = num(ctx.args, 'level') ?? 4;
    const out: string[] = [displayPath(root)];
    let dirs = 0;
    let files = 0;
    const visit = async (dir: string, prefix: string, depth: number) => {
      const entries = (await ctx.services.vfs.list(dir)).filter((e) => bool(ctx.args, 'all') || !e.name.startsWith('.'));
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const last = i === entries.length - 1;
        out.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.type === 'directory' ? '/' : ''}`);
        if (e.type === 'directory') {
          dirs++;
          if (depth + 1 < max && e.name !== 'node_modules' && e.name !== '.git') await visit(e.path, `${prefix}${last ? '    ' : '│   '}`, depth + 1);
        } else files++;
      }
    };
    await visit(root, '', 0);
    out.push('', `${dirs} directories, ${files} files`);
    ctx.out.writeln(out.join('\n'));
  },
};

const mkdir: CommandSpec = {
  name: 'mkdir',
  aliases: ['md'],
  group: GROUP,
  summary: 'Create directories',
  target: LOCAL,
  options: [{ name: 'parents', short: 'p', type: 'boolean', description: 'Create parent directories as needed; no error if it exists' }],
  positionals: [{ name: 'dir', description: 'Directories to create', required: true, variadic: true, complete: 'directory' }],
  async run(ctx) {
    for (const dir of pathArgs(ctx)) await ctx.services.vfs.mkdir(dir, { recursive: bool(ctx.args, 'parents') || /^md$/i.test(ctx.invokedAs) });
  },
};

const newItem: CommandSpec = {
  name: 'New-Item',
  aliases: ['ni'],
  group: GROUP,
  summary: 'Create a file or directory (PowerShell-style built-in)',
  target: LOCAL,
  options: [
    { name: 'ItemType', type: 'enum', values: ['File', 'Directory'], description: 'File (default) or Directory' },
    { name: 'Name', type: 'string', description: 'Name inside -Path' },
    { name: 'Value', type: 'string', description: 'Initial file content' },
    { name: 'Force', type: 'boolean', description: 'Overwrite an existing file / create parents' },
    pathOption,
  ],
  positionals: [{ name: 'path', description: 'Path to create', complete: 'path' }],
  async run(ctx) {
    let target = pathArgs(ctx, '.')[0]!;
    const name = str(ctx.args, 'Name');
    if (name) target = joinPath(target, name);
    if (str(ctx.args, 'ItemType') === 'Directory') await ctx.services.vfs.mkdir(target, { recursive: true });
    else await ctx.services.vfs.writeText(target, str(ctx.args, 'Value') ?? '', { overwrite: bool(ctx.args, 'Force') });
    ctx.out.writeln(displayPath(target));
  },
};

const touch: CommandSpec = {
  name: 'touch',
  group: GROUP,
  summary: 'Create empty files (existing files are left unchanged)',
  target: LOCAL,
  positionals: [{ name: 'file', description: 'Files', required: true, variadic: true, complete: 'file' }],
  async run(ctx) {
    for (const file of pathArgs(ctx)) {
      if (!(await ctx.services.vfs.exists(file))) await ctx.services.vfs.writeText(file, '');
    }
  },
};

const rm: CommandSpec = {
  name: 'rm',
  aliases: ['del', 'erase', 'rd', 'rmdir', 'ri', 'Remove-Item'],
  group: GROUP,
  summary: 'Delete files or directories (permanently - there is no trash)',
  target: LOCAL,
  options: [
    { name: 'recursive', short: 'r', aliases: ['Recurse'], type: 'boolean', description: 'Delete directories and their contents' },
    { name: 'force', short: 'f', aliases: ['Force'], type: 'boolean', description: 'No confirmation, no error for missing files' },
    pathOption,
  ],
  positionals: [{ name: 'path', description: 'Paths to delete', variadic: true, complete: 'path' }],
  async run(ctx) {
    const targets = pathArgs(ctx);
    if (!targets.length) throw new TerminiaError('INVALID_ARGUMENT', 'Name what to delete.');
    const force = bool(ctx.args, 'force');
    for (const target of targets) {
      if (!(await ctx.services.vfs.exists(target))) {
        if (force) continue;
        throw new TerminiaError('NOT_FOUND', `${displayPath(target)} does not exist.`);
      }
      const isDir = await ctx.services.vfs.isDirectory(target);
      if (isDir) {
        const entries = await ctx.services.vfs.list(target);
        if (entries.length && !bool(ctx.args, 'recursive')) throw new TerminiaError('INVALID_ARGUMENT', `${displayPath(target)} is a non-empty directory (use -r).`);
        if (entries.length && !force) {
          const ok = await ctx.services.ui.confirm({
            title: 'Delete folder?',
            message: `Permanently delete ${displayPath(target)} and everything in it (${entries.length} item(s) at the top level)? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) {
            ctx.out.warn(`Kept ${displayPath(target)}.`);
            continue;
          }
        }
      }
      await ctx.services.vfs.remove(target, { recursive: isDir });
    }
  },
};

async function destinationFor(ctx: CommandContext, source: string, dest: string): Promise<string> {
  return (await ctx.services.vfs.isDirectory(dest)) ? joinPath(dest, basename(source)) : dest;
}

const mv: CommandSpec = {
  name: 'mv',
  aliases: ['move', 'mi', 'Move-Item'],
  group: GROUP,
  summary: 'Move or rename files and directories',
  target: LOCAL,
  options: [pathOption, { name: 'destination', aliases: ['Destination'], type: 'string', description: 'Destination (PowerShell style)', complete: 'path' }],
  positionals: [{ name: 'source-and-dest', description: 'SOURCE... DEST', variadic: true, complete: 'path' }],
  async run(ctx) {
    const items = pathArgs(ctx);
    const destOption = str(ctx.args, 'destination');
    const dest = destOption ? abs(ctx, destOption) : items.pop();
    if (!dest || !items.length) throw new TerminiaError('INVALID_ARGUMENT', 'Usage: mv SOURCE... DEST');
    if (items.length > 1 && !(await ctx.services.vfs.isDirectory(dest))) throw new TerminiaError('INVALID_ARGUMENT', 'With several sources, DEST must be a directory.');
    for (const source of items) await ctx.services.vfs.move(source, await destinationFor(ctx, source, dest));
  },
};

const renameItem: CommandSpec = {
  name: 'Rename-Item',
  aliases: ['ren', 'rni'],
  group: GROUP,
  summary: 'Rename a file or directory in place',
  target: LOCAL,
  options: [pathOption, { name: 'NewName', type: 'string', description: 'New name' }],
  positionals: [{ name: 'path-and-name', description: 'PATH NEWNAME', variadic: true, complete: 'path' }],
  async run(ctx) {
    const items = [...(str(ctx.args, 'path') ? [str(ctx.args, 'path')!] : []), ...ctx.args.positionals];
    const newName = str(ctx.args, 'NewName') ?? items[1];
    if (!items[0] || !newName) throw new TerminiaError('INVALID_ARGUMENT', 'Usage: Rename-Item PATH NEWNAME');
    const source = abs(ctx, items[0]);
    const parent = source.slice(0, source.lastIndexOf('/')) || '/';
    await ctx.services.vfs.move(source, safeJoin(parent, newName.replace(/^\/+/, '')));
  },
};

const cp: CommandSpec = {
  name: 'cp',
  aliases: ['copy', 'cpi', 'Copy-Item'],
  group: GROUP,
  summary: 'Copy files and directories',
  target: LOCAL,
  options: [
    { name: 'recursive', short: 'r', aliases: ['Recurse'], type: 'boolean', description: 'Copy directories' },
    pathOption,
    { name: 'destination', aliases: ['Destination'], type: 'string', description: 'Destination (PowerShell style)', complete: 'path' },
  ],
  positionals: [{ name: 'source-and-dest', description: 'SOURCE... DEST', variadic: true, complete: 'path' }],
  async run(ctx) {
    const items = pathArgs(ctx);
    const destOption = str(ctx.args, 'destination');
    const dest = destOption ? abs(ctx, destOption) : items.pop();
    if (!dest || !items.length) throw new TerminiaError('INVALID_ARGUMENT', 'Usage: cp [-r] SOURCE... DEST');
    for (const source of items) {
      if ((await ctx.services.vfs.isDirectory(source)) && !bool(ctx.args, 'recursive')) throw new TerminiaError('INVALID_ARGUMENT', `${displayPath(source)} is a directory (use -r).`);
      await ctx.services.vfs.copy(source, await destinationFor(ctx, source, dest));
    }
  },
};

const stat: CommandSpec = {
  name: 'stat',
  group: GROUP,
  summary: 'Show file details',
  target: LOCAL,
  positionals: [{ name: 'path', description: 'Paths', required: true, variadic: true, complete: 'path' }],
  async run(ctx) {
    for (const path of pathArgs(ctx)) {
      const s = await ctx.services.vfs.stat(path);
      const mount = ctx.services.vfs.mountFor(path);
      ctx.out.writeln(`${displayPath(path)}\n  Type:     ${s.type}\n  Size:     ${s.type === 'file' ? `${formatBytes(s.size)} (${s.size} bytes)` : '-'}\n  Modified: ${s.mtime ? formatDateTime(s.mtime) : '-'}\n  Storage:  ${mount?.kind === 'folder' ? `opened folder "${mount.label}"` : 'Terminia workspace (On My iPad › Terminia)'}`);
    }
  },
};

const hash: CommandSpec = {
  name: 'sha256',
  aliases: ['Get-FileHash', 'shasum'],
  group: GROUP,
  summary: 'Compute file hashes (SHA256 or SHA1)',
  target: LOCAL,
  options: [{ name: 'Algorithm', short: 'a', type: 'enum', values: ['SHA256', 'SHA1'], description: 'Hash algorithm (default SHA256)' }, pathOption],
  positionals: [{ name: 'file', description: 'Files', variadic: true, complete: 'file' }],
  async run(ctx) {
    const files = pathArgs(ctx);
    if (!files.length) throw new TerminiaError('INVALID_ARGUMENT', 'Name a file.');
    const algorithm = str(ctx.args, 'Algorithm') ?? 'SHA256';
    const rows: string[][] = [];
    for (const file of files) {
      const data = await ctx.services.vfs.readBytes(file, 1024 * 1024 * 1024);
      rows.push([algorithm, (algorithm === 'SHA1' ? await sha1Hex(data) : await sha256Hex(data)).toUpperCase(), displayPath(file)]);
    }
    ctx.out.table(rows, ['Algorithm', 'Hash', 'Path']);
  },
};

const zip: CommandSpec = {
  name: 'zip',
  aliases: ['Compress-Archive'],
  group: GROUP,
  summary: 'Create a zip archive',
  target: LOCAL,
  options: [pathOption, { name: 'DestinationPath', type: 'string', description: 'Archive to create (PowerShell style)', complete: 'file' }, { name: 'Force', type: 'boolean', description: 'Overwrite the archive' }],
  positionals: [{ name: 'archive-and-paths', description: 'ARCHIVE.zip PATH...', variadic: true, complete: 'path' }],
  examples: ['zip site.zip index.html css', 'Compress-Archive -Path src -DestinationPath src.zip'],
  async run(ctx) {
    const positional = ctx.args.positionals.map((p) => abs(ctx, p));
    const destOption = str(ctx.args, 'DestinationPath');
    const archive = destOption ? abs(ctx, destOption) : positional.shift();
    const sources = [...(str(ctx.args, 'path') ? [abs(ctx, str(ctx.args, 'path')!)] : []), ...positional];
    if (!archive || !sources.length) throw new TerminiaError('INVALID_ARGUMENT', 'Usage: zip ARCHIVE.zip PATH...');
    const entries: { path: string; data: Uint8Array }[] = [];
    let total = 0;
    for (const source of sources) {
      if (await ctx.services.vfs.isDirectory(source)) {
        for (const f of await ctx.services.vfs.walk(source, { signal: ctx.signal, ignore: (p, isDir) => isDir && (p.endsWith('/.git') || p === '.git') })) {
          total += f.size;
          if (total > 500 * 1024 * 1024) throw new TerminiaError('TOO_LARGE', 'More than 500 MB to compress.');
          entries.push({ path: `${basename(source)}/${f.path}`, data: await ctx.services.vfs.readBytes(joinPath(source, f.path)) });
        }
      } else entries.push({ path: basename(source), data: await ctx.services.vfs.readBytes(source) });
    }
    const data = createZip(entries);
    await ctx.services.vfs.writeBytes(archive, data, { overwrite: bool(ctx.args, 'Force') || !destOption });
    ctx.out.writeln(`${displayPath(archive)}: ${entries.length} file(s), ${formatBytes(data.byteLength)}`);
  },
};

const unzip: CommandSpec = {
  name: 'unzip',
  aliases: ['Expand-Archive'],
  group: GROUP,
  summary: 'Extract a zip archive (paths are checked; nothing escapes the destination)',
  target: LOCAL,
  options: [
    { name: 'dest', short: 'd', aliases: ['DestinationPath'], type: 'string', description: 'Destination directory (default: current)', complete: 'directory' },
    { name: 'overwrite', short: 'o', aliases: ['Force'], type: 'boolean', description: 'Overwrite existing files' },
    { name: 'list', short: 'l', type: 'boolean', description: 'List the contents only' },
    pathOption,
  ],
  positionals: [{ name: 'archive', description: 'Zip file', complete: 'file' }],
  async run(ctx) {
    const archive = pathArgs(ctx)[0];
    if (!archive) throw new TerminiaError('INVALID_ARGUMENT', 'Name the archive.');
    const data = await ctx.services.vfs.readBytes(archive, 500 * 1024 * 1024);
    const files = extractZip(data);
    if (bool(ctx.args, 'list')) {
      ctx.out.table(files.map((f) => [formatBytes(f.data.byteLength), f.path]), ['Size', 'Name']);
      return;
    }
    const dest = abs(ctx, str(ctx.args, 'dest') ?? '.');
    const overwrite = bool(ctx.args, 'overwrite');
    for (const f of files) await ctx.services.vfs.writeBytes(safeJoin(dest, f.path), f.data, { overwrite });
    ctx.out.writeln(`Extracted ${files.length} file(s) to ${displayPath(dest)}`);
  },
};

const edit: CommandSpec = {
  name: 'edit',
  aliases: ['open', 'code'],
  group: GROUP,
  summary: 'Open a file in the editor (creates it if needed)',
  target: { kind: 'local', detail: 'editor' },
  positionals: [{ name: 'file', description: 'File to open', required: true, complete: 'file' }],
  async run(ctx) {
    const file = pathArgs(ctx)[0]!;
    if (await ctx.services.vfs.isDirectory(file)) {
      ctx.session.setCwd(file);
      ctx.services.ui.openView('files', { path: file });
      return;
    }
    if (!(await ctx.services.vfs.exists(file))) {
      await ctx.services.vfs.writeText(file, '');
      ctx.out.info(`Created ${displayPath(file)}`);
    }
    ctx.services.ui.openFile(file);
  },
};

const sort: CommandSpec = {
  name: 'sort',
  group: TEXT,
  summary: 'Sort lines',
  target: LOCAL,
  options: [
    { name: 'reverse', short: 'r', type: 'boolean', description: 'Reverse order' },
    { name: 'numeric', short: 'n', type: 'boolean', description: 'Numeric sort' },
    { name: 'unique', short: 'u', type: 'boolean', description: 'Drop duplicates' },
  ],
  positionals: [{ name: 'file', description: 'Files (or piped input)', variadic: true, complete: 'file' }],
  async run(ctx) {
    let out = lines(await readInput(ctx, pathArgs(ctx)));
    out.sort(bool(ctx.args, 'numeric') ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => a.localeCompare(b));
    if (bool(ctx.args, 'unique')) out = out.filter((l, i) => i === 0 || l !== out[i - 1]);
    if (bool(ctx.args, 'reverse')) out.reverse();
    if (out.length) ctx.out.writeln(out.join('\n'));
  },
};

const uniq: CommandSpec = {
  name: 'uniq',
  group: TEXT,
  summary: 'Collapse repeated adjacent lines',
  target: LOCAL,
  options: [{ name: 'count', short: 'c', type: 'boolean', description: 'Prefix lines with their count' }],
  positionals: [{ name: 'file', description: 'File (or piped input)', complete: 'file' }],
  async run(ctx) {
    const input = lines(await readInput(ctx, pathArgs(ctx)));
    const out: string[] = [];
    let count = 0;
    input.forEach((line, i) => {
      count++;
      if (input[i + 1] !== line) {
        out.push(bool(ctx.args, 'count') ? `${String(count).padStart(7)} ${line}` : line);
        count = 0;
      }
    });
    if (out.length) ctx.out.writeln(out.join('\n'));
  },
};

const du: CommandSpec = {
  name: 'du',
  group: GROUP,
  summary: 'Total size of a directory',
  target: LOCAL,
  positionals: [{ name: 'dir', description: 'Directory (default: current)', complete: 'directory' }],
  async run(ctx) {
    const root = abs(ctx, ctx.args.positionals[0] ?? '.');
    const files = await ctx.services.vfs.walk(root, { signal: ctx.signal });
    ctx.out.writeln(`${formatBytes(files.reduce((s, f) => s + f.size, 0))}\t${files.length} files\t${displayPath(root)}`);
  },
};

const writeFile: CommandSpec = {
  name: 'Set-Content',
  aliases: ['sc'],
  group: TEXT,
  summary: 'Write text to a file (from -Value or piped input)',
  target: LOCAL,
  options: [pathOption, { name: 'Value', type: 'string', description: 'Text to write' }, { name: 'NoNewline', type: 'boolean', description: 'Do not add a final newline' }, YES],
  positionals: [{ name: 'path', description: 'File', complete: 'file' }],
  async run(ctx) {
    const file = pathArgs(ctx)[0];
    if (!file) throw new TerminiaError('INVALID_ARGUMENT', 'Name the file.');
    let text = str(ctx.args, 'Value') ?? ctx.stdin;
    if (text === null) throw new TerminiaError('INVALID_ARGUMENT', 'Provide -Value or pipe text in.');
    if (!bool(ctx.args, 'NoNewline') && !text.endsWith('\n')) text += '\n';
    if ((await ctx.services.vfs.exists(file)) && !(await confirm(ctx, { title: 'Replace file?', message: `Replace the contents of ${displayPath(file)}?`, confirmLabel: 'Replace' }))) return 1;
    await ctx.services.vfs.writeText(file, text);
    return 0;
  },
};

export const FILE_COMMANDS: CommandSpec[] = [ls, cd, pwd, cat, headTail('head'), headTail('tail'), wc, grep, find, tree, mkdir, newItem, touch, rm, mv, renameItem, cp, stat, hash, zip, unzip, edit, sort, uniq, du, writeFile];
