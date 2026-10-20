import type { CommandSpec } from './types';

export interface Resolved {
  spec: CommandSpec;
  /** Canonical names, e.g. ['terminia', 'ios', 'build']. */
  path: string[];
  /** Words left after the command path. */
  rest: string[];
}

function matches(spec: CommandSpec, word: string): boolean {
  const w = word.toLowerCase();
  return spec.name.toLowerCase() === w || (spec.aliases ?? []).some((a) => a.toLowerCase() === w);
}

/** The command table. Names and aliases are case-insensitive, like PowerShell. */
export class Registry {
  private commands: CommandSpec[] = [];

  register(...specs: CommandSpec[]): this {
    for (const spec of specs) {
      const clash = this.commands.find((c) => [spec.name, ...(spec.aliases ?? [])].some((n) => matches(c, n)));
      if (clash) throw new Error(`Command '${spec.name}' clashes with '${clash.name}'.`);
      this.commands.push(spec);
    }
    return this;
  }

  all(): CommandSpec[] {
    return [...this.commands];
  }

  find(name: string): CommandSpec | undefined {
    return this.commands.find((c) => matches(c, name));
  }

  /** Walks subcommands as far as the words allow. */
  resolve(argv: string[]): Resolved | undefined {
    const [first, ...rest] = argv;
    if (!first) return undefined;
    let spec = this.find(first);
    if (!spec) return undefined;
    const path = [spec.name];
    let remaining = rest;
    while (spec.subcommands?.length && remaining.length) {
      const sub: CommandSpec | undefined = spec.subcommands.find((s) => matches(s, remaining[0]!));
      if (!sub) break;
      spec = sub;
      path.push(sub.name);
      remaining = remaining.slice(1);
    }
    return { spec, path, rest: remaining };
  }

  names(): string[] {
    return this.commands.filter((c) => !c.hidden).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  }
}
