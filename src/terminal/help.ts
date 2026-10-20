import type { Services } from '../app/services';
import type { OptionSpec } from './args';
import type { Registry } from './registry';
import { targetLabel, type CommandSpec, type ExecutionTarget } from './types';
import { parseArgs } from './args';

export function formatTable(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (!all.length) return '';
  const widths: number[] = [];
  for (const row of all) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  const line = (row: string[]) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  const out = all.map(line);
  if (headers) out.splice(1, 0, widths.map((w, i) => '-'.repeat(i === widths.length - 1 ? Math.min(w, headers[i]!.length || w) : w)).join('  '));
  return out.join('\n');
}

function optionSignature(o: OptionSpec): string {
  const names = [o.short ? `-${o.short}` : null, `--${o.name}`].filter(Boolean).join(', ');
  if (o.type === 'boolean') return names;
  const value = o.type === 'enum' && o.values ? o.values.join('|') : (o.valueName ?? o.name);
  return `${names} <${value}>`;
}

export function staticTarget(spec: CommandSpec, services: Services | undefined): ExecutionTarget | null {
  if (typeof spec.target !== 'function') return spec.target;
  if (!services) return null;
  try {
    return spec.target(parseArgs([], [], []), services);
  } catch {
    return null;
  }
}

export function commandHelp(spec: CommandSpec, path: string[], services?: Services): string {
  const lines: string[] = [];
  lines.push(`${path.join(' ')} — ${spec.summary}`);
  const target = staticTarget(spec, services);
  if (spec.run && target) lines.push(`Runs on: ${targetLabel(target)}`);
  if (spec.aliases?.length) lines.push(`Aliases: ${spec.aliases.join(', ')}`);
  if (spec.description) lines.push('', ...spec.description.split('\n'));
  if (spec.usage?.length || spec.run) {
    lines.push('', 'Usage:');
    const usage = spec.usage?.length
      ? spec.usage
      : [
          [
            path.join(' '),
            ...(spec.options?.length ? ['[options]'] : []),
            ...(spec.positionals ?? []).map((p) => (p.required ? `<${p.name}${p.variadic ? '...' : ''}>` : `[${p.name}${p.variadic ? '...' : ''}]`)),
          ].join(' '),
        ];
    for (const u of usage) lines.push(`  ${u}`);
  }
  if (spec.positionals?.length) {
    lines.push('', 'Arguments:');
    lines.push(
      formatTable(spec.positionals.map((p) => [`  ${p.name}`, p.description + (p.values ? ` (${p.values.join(', ')})` : '')]))
        .split('\n')
        .join('\n'),
    );
  }
  if (spec.options?.length) {
    lines.push('', 'Options:');
    lines.push(formatTable(spec.options.map((o) => [`  ${optionSignature(o)}`, o.description])));
  }
  const subs = spec.subcommands?.filter((s) => !s.hidden) ?? [];
  if (subs.length) {
    lines.push('', 'Commands:');
    lines.push(formatTable(subs.map((s) => [`  ${s.name}`, s.summary])));
    lines.push('', `Run '${path.join(' ')} <command> --help' for details.`);
  }
  if (spec.examples?.length) {
    lines.push('', 'Examples:');
    for (const e of spec.examples) lines.push(`  ${e}`);
  }
  return lines.join('\n');
}

const GROUP_ORDER = ['Terminia', 'Files', 'Text', 'Session', 'Remote'];

export function overviewHelp(registry: Registry): string {
  const groups = new Map<string, CommandSpec[]>();
  for (const spec of registry.all()) {
    if (spec.hidden) continue;
    const group = spec.group ?? 'Other';
    groups.set(group, [...(groups.get(group) ?? []), spec]);
  }
  const lines = [
    'Terminia — developer terminal for iPad',
    '',
    'Local commands run on this iPad inside Terminia\'s own folders. They are not PowerShell.',
    'Real PowerShell runs on a remote host you connect (remote connect <profile>).',
    'Builds run on GitHub Actions runners (macOS for iOS, Linux for Android).',
  ];
  const ordered = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
  for (const group of ordered) {
    lines.push('', `${group}:`);
    const specs = groups.get(group)!.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(formatTable(specs.map((s) => [`  ${[s.name, ...(s.aliases ?? [])].join(', ')}`, s.summary])));
  }
  lines.push('', "Run 'help <command>' or '<command> --help' for details, and 'terminia help' for the Terminia CLI.");
  return lines.join('\n');
}
