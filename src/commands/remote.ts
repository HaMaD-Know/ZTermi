import type { Services } from '../app/services';
import { TerminiaError } from '../core/errors';
import { formatDateTime } from '../core/util';
import { str } from '../terminal/args';
import type { CommandSpec, ExecutionTarget } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { YES, confirm } from './common';

const GROUP = 'Remote';

function remoteTarget(name: string | undefined, services: Services): ExecutionTarget {
  const profile = name ? services.remote.find(name) : undefined;
  return { kind: 'remote', profile: profile?.name ?? name ?? '?', host: profile?.url ?? '' };
}

const profileArg = { name: 'profile', description: 'Remote host profile name', required: true, complete: 'remote-profile' as const };

const list: CommandSpec = {
  name: 'list',
  aliases: ['ls'],
  summary: 'List remote PowerShell hosts',
  target: LOCAL,
  async run(ctx) {
    const profiles = await ctx.services.remote.profiles();
    if (!profiles.length) {
      ctx.out.info('No remote hosts. Run the Terminia agent on a computer (docs/REMOTE-HOST.md), then: remote add <name> <url>');
      return;
    }
    ctx.out.table(
      profiles.map((p) => [p.name, p.url, p.pinSha256 ? 'pinned' : p.url.startsWith('https:') ? 'system trust' : 'plain HTTP', p.lastConnectedAt ? formatDateTime(p.lastConnectedAt) : 'never']),
      ['Name', 'URL', 'TLS', 'Last connected'],
    );
  },
};

const add: CommandSpec = {
  name: 'add',
  summary: 'Add a remote host (the agent token is entered in a secure field)',
  target: LOCAL,
  options: [{ name: 'fingerprint', type: 'string', description: 'SHA-256 of the agent certificate to pin (printed by the agent)' }],
  positionals: [
    { name: 'name', description: 'Short name, e.g. devbox', required: true },
    { name: 'url', description: 'Agent URL, e.g. https://devbox.tailnet.ts.net:8765', required: true },
  ],
  async run(ctx) {
    const [name, url] = ctx.args.positionals as [string, string];
    const profile = await ctx.services.remote.add(name, url, { pinSha256: str(ctx.args, 'fingerprint') });
    ctx.out.success(`Added ${profile.name} (${profile.url}). Test it with \`remote test ${profile.name}\`.`);
  },
};

const remove: CommandSpec = {
  name: 'remove',
  aliases: ['rm'],
  summary: 'Remove a remote host and its stored token',
  target: LOCAL,
  options: [YES],
  positionals: [profileArg],
  async run(ctx) {
    const profile = ctx.services.remote.require(ctx.args.positionals[0]);
    if (!(await confirm(ctx, { title: 'Remove remote host?', message: `Remove ${profile.name} and delete its token from this iPad?`, confirmLabel: 'Remove', danger: true }))) return 1;
    await ctx.services.remote.remove(profile.id);
    ctx.out.success(`Removed ${profile.name}.`);
    return 0;
  },
};

const token: CommandSpec = {
  name: 'token',
  summary: 'Enter a new agent token for a host (after `terminia-agent token`)',
  target: LOCAL,
  positionals: [profileArg],
  async run(ctx) {
    const profile = ctx.services.remote.require(ctx.args.positionals[0]);
    await ctx.services.remote.promptToken(profile);
    ctx.out.success(`Token for ${profile.name} updated.`);
  },
};

const test: CommandSpec = {
  name: 'test',
  summary: 'Check the connection and show the host\'s PowerShell',
  target: (args, services) => remoteTarget(args.positionals[0], services),
  positionals: [profileArg],
  async run(ctx) {
    const info = await ctx.services.remote.test(ctx.args.positionals[0]!, ctx.signal);
    ctx.out.success(`Connected to ${info.hostname} (${info.platform}) · PowerShell ${info.powershell.edition} ${info.powershell.version} · agent ${info.version}${info.tls ? ' · TLS' : ' · plain HTTP'}`);
    ctx.out.writeln(`  Start folders: ${info.roots.join(', ')}`);
    ctx.out.writeln(`  Programs for dependency commands: ${info.exec.join(', ')}`);
    ctx.out.writeln(`  Sessions: ${info.sessions.active}/${info.sessions.max}`);
  },
};

const connect: CommandSpec = {
  name: 'connect',
  aliases: ['enter'],
  summary: 'Switch this tab to a real PowerShell session on a remote host',
  description: "Every line you type afterwards runs REMOTELY in a persistent PowerShell session on that host (variables, functions and location persist). Type `exit` to come back to local commands. Prefix a line with ':' to run one local command, e.g. ':ls'. `terminia ...` commands always run locally.",
  target: (args, services) => remoteTarget(args.positionals[0], services),
  positionals: [profileArg],
  async run(ctx) {
    const profile = ctx.services.remote.require(ctx.args.positionals[0]);
    await ctx.session.enterRemote(profile.id);
    ctx.out.success(`Connected to ${profile.name}. Commands in this tab now run REMOTELY in PowerShell on ${new URL(profile.url).host}.`);
    ctx.out.info("Type 'exit' to return to local commands; prefix a line with ':' to run it locally.");
  },
};

const disconnect: CommandSpec = {
  name: 'disconnect',
  summary: 'Leave remote mode in this tab',
  target: LOCAL,
  async run(ctx) {
    if (!ctx.session.remoteProfile()) {
      ctx.out.info('This tab is not connected to a remote host.');
      return;
    }
    await ctx.session.exitRemote();
    ctx.out.success('Disconnected. Commands run locally again.');
  },
};

const status: CommandSpec = {
  name: 'status',
  summary: 'Show whether this tab is connected to a remote host',
  target: LOCAL,
  async run(ctx) {
    const id = ctx.session.remoteProfile();
    if (!id) {
      ctx.out.writeln('Local mode: commands run on this iPad.');
      return;
    }
    const profile = ctx.services.remote.find(id);
    ctx.out.writeln(`Remote mode: commands run in PowerShell on ${profile?.name ?? id} (${profile?.url ?? ''}).`);
  },
};

const map: CommandSpec = {
  name: 'map',
  summary: 'Tell Terminia where the current project lives on a remote host',
  target: LOCAL,
  positionals: [profileArg, { name: 'path', description: 'Folder on the host, e.g. C:\\src\\myapp', required: true }],
  async run(ctx) {
    const project = ctx.services.projects.requireCurrent();
    await ctx.services.remote.setProjectPath(ctx.args.positionals[0]!, project.name, ctx.args.positionals[1]!);
    ctx.out.success(`${project.name} is at ${ctx.args.positionals[1]} on ${ctx.args.positionals[0]}. \`terminia deps install --on remote\` runs there.`);
  },
};

const exec: CommandSpec = {
  name: 'exec',
  aliases: ['run'],
  summary: 'Run one PowerShell command on a remote host without switching the tab',
  target: (args, services) => remoteTarget(args.positionals[0], services),
  positionals: [profileArg],
  usage: ['remote exec <profile> -- <PowerShell command>'],
  examples: ["remote exec devbox -- Get-Process | Sort-Object CPU -Descending | Select-Object -First 5"],
  async run(ctx) {
    if (!ctx.args.rest.length) throw new TerminiaError('INVALID_ARGUMENT', 'Put the PowerShell command after --, e.g. remote exec devbox -- Get-Date');
    const shell = await ctx.services.remote.openShell(ctx.args.positionals[0]!);
    try {
      ctx.out.muted(`Running on ${shell.profileName} (${shell.host})…`);
      return (await shell.run(ctx.args.rest.join(' '), ctx.out, ctx.signal)).exitCode;
    } finally {
      await shell.close().catch(() => undefined);
    }
  },
};

export const remoteGroup: CommandSpec = {
  name: 'remote',
  group: GROUP,
  summary: 'Remote PowerShell hosts (real PowerShell via the Terminia agent)',
  description: 'Real PowerShell does not run on iPad. Run `node agent/terminia-agent.mjs` on a Windows, macOS or Linux computer with PowerShell, add it here, and connect. See docs/REMOTE-HOST.md.',
  target: LOCAL,
  subcommands: [list, add, remove, token, test, connect, disconnect, status, map, exec],
};
