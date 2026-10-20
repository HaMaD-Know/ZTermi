import type { Services } from '../app/services';
import { basename, normalizeAbsolute, resolvePath } from '../core/paths';
import { findOption, type CompletionKind } from './args';
import type { Registry } from './registry';
import { quoteArg, tokenize, type WordToken } from './tokenizer';
import type { CommandSpec, SessionApi } from './types';

export interface Candidate {
  value: string;
  description?: string;
  isDirectory?: boolean;
}

export interface CompletionResult {
  /** Range of the input that a chosen candidate replaces. */
  start: number;
  end: number;
  candidates: Candidate[];
}

function prefixFilter(values: Candidate[], prefix: string): Candidate[] {
  const p = prefix.toLowerCase();
  return values.filter((c) => c.value.toLowerCase().startsWith(p));
}

/** Longest common prefix of the candidates (case-insensitive match, original case kept). */
export function commonPrefix(values: string[]): string {
  if (!values.length) return '';
  let prefix = values[0]!;
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i]!.toLowerCase() === v[i]!.toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * Completes the word at `cursor`: command names, subcommands, options, option
 * values and positional arguments (paths, projects, remote profiles...).
 */
export async function completeLocal(
  input: string,
  cursor: number,
  registry: Registry,
  services: Services,
  session: SessionApi,
): Promise<CompletionResult> {
  const before = input.slice(0, cursor);
  const { tokens } = tokenize(before);
  // Only the words of the last simple command matter.
  let lastOp = -1;
  tokens.forEach((t, i) => {
    if (t.kind === 'op') lastOp = i;
  });
  const words = tokens.slice(lastOp + 1).filter((t): t is WordToken => t.kind === 'word');
  const endsWithSpace = /\s$/.test(before) || before.length === 0;
  const current = !endsWithSpace && words.length ? words[words.length - 1]! : null;
  const prefix = current ? current.value : '';
  const start = current ? current.start : cursor;
  const completed = (current ? words.slice(0, -1) : words).map((w) => w.value);

  const result = (candidates: Candidate[]): CompletionResult => ({ start, end: cursor, candidates });

  if (completed.length === 0) {
    const names = registry
      .all()
      .filter((c) => !c.hidden)
      .flatMap((c) => [{ value: c.name, description: c.summary }, ...(c.aliases ?? []).map((a) => ({ value: a, description: c.summary }))]);
    const commands = prefixFilter(names, prefix);
    if (commands.length || !prefix.includes('/')) return result(commands);
    return result(await completePath(prefix, 'path', services, session));
  }

  const resolved = registry.resolve(completed);
  if (!resolved) return result(await completePath(prefix, 'path', services, session));
  const { spec, rest } = resolved;

  if (spec.subcommands?.length && rest.length === 0 && !prefix.startsWith('-')) {
    return result(prefixFilter(spec.subcommands.filter((s) => !s.hidden).map((s) => ({ value: s.name, description: s.summary })), prefix));
  }

  if (prefix.startsWith('-')) {
    const options = (spec.options ?? []).flatMap((o) => [{ value: `--${o.name}`, description: o.description }]);
    return result(prefixFilter([...options, { value: '--help', description: 'Show help' }], prefix));
  }

  // Value of the previous option?
  const previous = rest[rest.length - 1];
  if (previous?.startsWith('-')) {
    const option = findOption(spec.options ?? [], previous.replace(/^-+/, ''));
    if (option && option.type !== 'boolean') {
      if (option.values) return result(prefixFilter(option.values.map((v) => ({ value: v })), prefix));
      if (option.complete) return result(await completeKind(option.complete, prefix, services, session));
      return result([]);
    }
  }

  if (spec.complete) {
    const values = await spec.complete({ services, session, spec, word: prefix, previous: rest });
    return result(prefixFilter(values.map((v) => ({ value: v })), prefix));
  }

  const positionalIndex = countPositionals(rest, spec);
  const positionals = spec.positionals ?? [];
  const positional = positionals[Math.min(positionalIndex, positionals.length - 1)];
  if (positional?.values) return result(prefixFilter(positional.values.map((v) => ({ value: v })), prefix));
  if (positional?.complete) return result(await completeKind(positional.complete, prefix, services, session));
  return result(positional ? await completePath(prefix, 'path', services, session) : []);
}

function countPositionals(words: string[], spec: CommandSpec): number {
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('-')) {
      const option = findOption(spec.options ?? [], w.replace(/^-+/, '').split('=')[0]!);
      if (option && option.type !== 'boolean' && !w.includes('=')) i++;
      continue;
    }
    count++;
  }
  return count;
}

async function completeKind(kind: CompletionKind, prefix: string, services: Services, session: SessionApi): Promise<Candidate[]> {
  try {
    switch (kind) {
      case 'path':
      case 'file':
      case 'directory':
        return await completePath(prefix, kind, services, session);
      case 'project':
        return prefixFilter((await services.projects.list()).map((p) => ({ value: quoteArg(p.name), description: p.path })), prefix);
      case 'remote-profile':
        return prefixFilter((await services.remote.profiles()).map((p) => ({ value: p.name, description: p.url })), prefix);
      case 'template':
        return prefixFilter(services.projects.templates().map((t) => ({ value: t.id, description: t.description })), prefix);
      case 'build':
        return prefixFilter((await services.builds.history()).slice(0, 30).map((b) => ({ value: b.id, description: `${b.platform} · ${b.status}` })), prefix);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

async function completePath(prefix: string, kind: CompletionKind, services: Services, session: SessionApi): Promise<Candidate[]> {
  const slash = prefix.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : prefix.slice(0, slash + 1);
  const namePart = slash === -1 ? prefix : prefix.slice(slash + 1);
  const dir = dirPart ? resolvePath(session.cwd(), dirPart) : session.cwd();
  let entries;
  try {
    entries = await services.vfs.list(normalizeAbsolute(dir));
  } catch {
    return [];
  }
  return entries
    .filter((e) => (kind === 'directory' ? e.type === 'directory' : true))
    .filter((e) => e.name.toLowerCase().startsWith(namePart.toLowerCase()))
    .filter((e) => namePart.startsWith('.') || !e.name.startsWith('.') || e.name === '.github' || e.name === '.terminia')
    .map((e) => ({
      value: quoteArg(dirPart + e.name) + (e.type === 'directory' ? '/' : ''),
      description: e.type === 'directory' ? 'folder' : basename(e.path),
      isDirectory: e.type === 'directory',
    }));
}
