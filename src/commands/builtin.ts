import { sleep } from '../core/errors';
import { bool, num } from '../terminal/args';
import { commandHelp, overviewHelp, staticTarget } from '../terminal/help';
import type { Registry } from '../terminal/registry';
import type { CommandSpec } from '../terminal/types';
import { LOCAL, targetLabel } from '../terminal/types';

const GROUP = 'Session';

export function builtinCommands(registry: Registry): CommandSpec[] {
  const help: CommandSpec = {
    name: 'help',
    aliases: ['Get-Help', 'man'],
    group: GROUP,
    summary: 'List commands, or show help for one',
    target: LOCAL,
    positionals: [{ name: 'command', description: 'Command (and subcommands), e.g. terminia ios build', variadic: true }],
    async run(ctx) {
      if (!ctx.args.positionals.length) {
        ctx.out.writeln(overviewHelp(registry));
        return;
      }
      const resolved = registry.resolve(ctx.args.positionals);
      if (!resolved) {
        ctx.out.error(`No help for '${ctx.args.positionals.join(' ')}': unknown command.`);
        return 1;
      }
      ctx.out.writeln(commandHelp(resolved.spec, resolved.path, ctx.services));
      return 0;
    },
  };

  const clear: CommandSpec = {
    name: 'clear',
    aliases: ['cls', 'Clear-Host'],
    group: GROUP,
    summary: 'Clear the terminal',
    target: LOCAL,
    async run(ctx) {
      ctx.session.clearScreen();
    },
  };

  const echo: CommandSpec = {
    name: 'echo',
    aliases: ['Write-Output', 'write'],
    group: 'Text',
    summary: 'Print arguments',
    target: LOCAL,
    options: [{ name: 'no-newline', short: 'n', aliases: ['NoNewline'], type: 'boolean', description: 'No trailing newline' }],
    positionals: [{ name: 'text', description: 'Words to print', variadic: true }],
    async run(ctx) {
      const text = ctx.args.positionals.join(' ');
      if (bool(ctx.args, 'no-newline')) ctx.out.write(text);
      else ctx.out.writeln(text);
    },
  };

  const history: CommandSpec = {
    name: 'history',
    aliases: ['h', 'Get-History'],
    group: GROUP,
    summary: 'Show command history (secrets are redacted before saving)',
    target: LOCAL,
    options: [{ name: 'count', short: 'n', aliases: ['Count'], type: 'number', description: 'Number of entries (default 50)' }],
    async run(ctx) {
      const items = ctx.session.history();
      const count = num(ctx.args, 'count') ?? 50;
      const start = Math.max(0, items.length - count);
      ctx.out.writeln(items.slice(start).map((line, i) => `${String(start + i + 1).padStart(5)}  ${line}`).join('\n'));
    },
  };

  const date: CommandSpec = {
    name: 'date',
    aliases: ['Get-Date'],
    group: 'Text',
    summary: 'Print the date and time',
    target: LOCAL,
    options: [{ name: 'iso', type: 'boolean', description: 'ISO 8601 (UTC)' }],
    async run(ctx) {
      const now = new Date();
      ctx.out.writeln(bool(ctx.args, 'iso') ? now.toISOString() : now.toString());
    },
  };

  const sleepCommand: CommandSpec = {
    name: 'sleep',
    aliases: ['Start-Sleep'],
    group: GROUP,
    summary: 'Wait for a number of seconds (Ctrl+C stops it)',
    target: LOCAL,
    options: [{ name: 'Seconds', short: 's', type: 'number', description: 'Seconds' }],
    positionals: [{ name: 'seconds', description: 'Seconds to wait' }],
    async run(ctx) {
      const seconds = num(ctx.args, 'Seconds') ?? Number(ctx.args.positionals[0] ?? 1);
      await sleep(Math.max(0, Math.min(3600, seconds)) * 1000, ctx.signal);
    },
  };

  const which: CommandSpec = {
    name: 'which',
    aliases: ['where', 'Get-Command', 'gcm'],
    group: GROUP,
    summary: 'Show what a command is and where it runs',
    target: LOCAL,
    positionals: [{ name: 'command', description: 'Command names', required: true, variadic: true }],
    async run(ctx) {
      let status = 0;
      for (const name of ctx.args.positionals) {
        const resolved = registry.resolve([name]);
        if (resolved) {
          const target = staticTarget(resolved.spec, ctx.services);
          ctx.out.writeln(`${name}: Terminia built-in (${resolved.spec.name})${target ? ` — runs on ${targetLabel(target)}` : ''}`);
        } else {
          status = 1;
          ctx.out.writeln(`${name}: not a Terminia command. It is not available on the iPad; run it on a remote host (remote connect) or in a build workflow.`);
        }
      }
      return status;
    },
  };

  const exit: CommandSpec = {
    name: 'exit',
    aliases: ['Exit-PSSession'],
    group: GROUP,
    summary: 'Leave remote mode (in local mode there is nothing to exit)',
    target: LOCAL,
    async run(ctx) {
      if (ctx.session.remoteProfile()) {
        await ctx.session.exitRemote();
        ctx.out.info('Back to local commands.');
      } else ctx.out.info('Already running local commands.');
    },
  };

  const SCREENS = ['projects', 'files', 'deps', 'builds', 'artifacts', 'settings'] as const;
  const open: CommandSpec = {
    name: 'screen',
    aliases: ['show'],
    group: GROUP,
    summary: 'Open a full screen: projects, files, deps, builds, artifacts or settings (Esc returns here)',
    target: LOCAL,
    positionals: [{ name: 'screen', description: SCREENS.join(', '), required: true }],
    async run(ctx) {
      const name = ctx.args.positionals[0]!.toLowerCase();
      const screen = SCREENS.find((s) => s === name);
      if (!screen) {
        ctx.out.error(`Unknown screen '${name}'. Choose one of: ${SCREENS.join(', ')}.`);
        return 2;
      }
      ctx.services.ui.openView(screen);
      return 0;
    },
  };

  return [help, clear, echo, history, date, sleepCommand, which, exit, open];
}
