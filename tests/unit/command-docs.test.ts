// @vitest-environment node
/**
 * docs/COMMANDS.md is generated from the command registry, so the reference
 * can never drift from what the terminal actually accepts.
 * Regenerate with: UPDATE_DOCS=1 npx vitest run tests/unit/command-docs.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry } from '../../src/commands';
import { commandHelp } from '../../src/terminal/help';
import type { CommandSpec } from '../../src/terminal/types';
import { createHarness } from '../support/harness';

function collect(spec: CommandSpec, pathParts: string[], out: { path: string[]; spec: CommandSpec }[]): void {
  if (spec.hidden) return;
  out.push({ path: pathParts, spec });
  for (const sub of spec.subcommands ?? []) collect(sub, [...pathParts, sub.name], out);
}

function generate(): string {
  const { services } = createHarness();
  const registry = createRegistry();
  const all: { path: string[]; spec: CommandSpec }[] = [];
  for (const spec of registry.all().sort((a, b) => (a.name === 'terminia' ? -1 : b.name === 'terminia' ? 1 : a.name.localeCompare(b.name)))) {
    collect(spec, [spec.name], all);
  }
  const lines = [
    '# Terminia command reference',
    '',
    'Generated from the command registry by `tests/unit/command-docs.test.ts` - do not edit by hand.',
    'Every command shows where it runs ("Runs on"). Local commands run on the iPad and are not PowerShell;',
    'real PowerShell runs on a remote host (`remote connect`).',
    '',
  ];
  for (const { path: p, spec } of all) {
    lines.push(`## \`${p.join(' ')}\``, '', '```text', commandHelp(spec, p, services), '```', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

describe('command reference', () => {
  it('docs/COMMANDS.md matches the registry', () => {
    const file = path.join(__dirname, '..', '..', 'docs', 'COMMANDS.md');
    const generated = generate();
    if (process.env.UPDATE_DOCS) writeFileSync(file, generated);
    expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
  });

  it('documents every required Terminia build command', () => {
    const text = generate();
    for (const command of [
      'terminia ios configure', 'terminia ios build', 'terminia ios status', 'terminia ios logs', 'terminia ios artifacts', 'terminia ios download', 'terminia ios cancel', 'terminia ios history',
      'terminia android configure', 'terminia android build', 'terminia android status', 'terminia android logs', 'terminia android artifacts', 'terminia android download', 'terminia android cancel',
      'terminia deps list', 'terminia deps add', 'terminia deps remove', 'terminia deps install', 'terminia deps update', 'terminia help',
    ]) {
      expect(text, command).toContain(`## \`${command}\``);
    }
  });
});
