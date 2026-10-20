import { STATUS_LABELS } from '../build/types';
import { displayPath } from '../core/paths';
import { formatBytes, relativeTime } from '../core/util';
import { commandHelp } from '../terminal/help';
import type { CommandSpec } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { artifactsGroup } from './artifacts';
import { buildAny, platformGroup } from './build';
import { depsGroup } from './deps';
import { ciGroup, gitGroup, githubGroup } from './github';
import { projectGroup } from './project';
import { remoteGroup } from './remote';

export const APP_VERSION = '1.0.0';

const version: CommandSpec = {
  name: 'version',
  summary: 'Show the Terminia version',
  target: LOCAL,
  async run(ctx) {
    ctx.out.writeln(`Terminia ${APP_VERSION} (${ctx.services.platform.kind === 'ios' ? 'iPad app' : 'browser preview'})`);
  },
};

const targets: CommandSpec = {
  name: 'targets',
  summary: 'Explain where commands run',
  target: LOCAL,
  async run(ctx) {
    ctx.out.table(
      [
        ['Local iPad', 'Files in /workspace and opened folders, editing, archives, project detection, text tools. Not PowerShell.'],
        ['Embedded runtime', 'None. Terminia does not embed Node.js, Python or PowerShell.'],
        ['Network', 'Read-only lookups: GitHub API, npm registry, PyPI.'],
        ['Remote PowerShell host', 'Real PowerShell on your computer through the Terminia agent (remote connect).'],
        ['GitHub Actions · macOS', 'iOS builds with Xcode, signing, CocoaPods/SwiftPM installs.'],
        ['GitHub Actions · Linux', 'Android builds with Gradle, web/Node/Python builds, npm/pip installs.'],
      ],
      ['Target', 'What runs there'],
    );
    ctx.out.info('Every command shows its target next to it in the terminal. `which <command>` tells you for a single command.');
  },
};

const status: CommandSpec = {
  name: 'status',
  summary: 'Project, connections, builds and downloads at a glance',
  target: LOCAL,
  async run(ctx) {
    const { projects, github, builds, artifacts, remote, platform } = ctx.services;
    const project = projects.current();
    ctx.out.writeln(`Project:  ${project ? `${project.name} (${displayPath(project.path)})` : '(none - terminia project open <name>)'}`);
    const credential = await github.credential();
    const gh = github.lastStatus();
    ctx.out.writeln(`GitHub:   ${credential ? (gh.connected ? `connected as ${gh.user?.login}` : 'credential stored (run `terminia github status` to verify)') : 'not connected'}`);
    ctx.out.writeln(`Secrets:  ${platform.vault.storage === 'keychain' ? 'iOS Keychain' : 'memory only (browser preview)'}`);
    const remoteId = ctx.session.remoteProfile();
    ctx.out.writeln(`This tab: ${remoteId ? `REMOTE PowerShell on ${remote.find(remoteId)?.name ?? remoteId}` : 'local commands'}`);
    ctx.out.writeln(`Remote hosts: ${(await remote.profiles()).map((p) => p.name).join(', ') || 'none'}`);
    for (const p of ['ios', 'android', 'web'] as const) {
      const latest = builds.latest(p);
      if (latest) ctx.out.writeln(`Latest ${p} build: ${latest.id} · ${STATUS_LABELS[latest.status]} · ${relativeTime(latest.createdAt)}`);
    }
    for (const d of artifacts.activeDownloads()) ctx.out.writeln(`Downloading ${d.name}: ${formatBytes(d.received)} of ${formatBytes(d.total)}`);
  },
};

const subcommands: CommandSpec[] = [
  version,
  status,
  targets,
  projectGroup,
  platformGroup('ios'),
  platformGroup('android'),
  platformGroup('web'),
  buildAny,
  depsGroup,
  githubGroup,
  gitGroup,
  ciGroup,
  artifactsGroup,
  remoteGroup,
];

const help: CommandSpec = {
  name: 'help',
  summary: 'Help for the Terminia CLI',
  target: LOCAL,
  positionals: [{ name: 'topic', description: 'Subcommand, e.g. ios or ios build', variadic: true }],
  async run(ctx) {
    let spec: CommandSpec = terminia;
    const path = ['terminia'];
    for (const word of ctx.args.positionals) {
      const next = spec.subcommands?.find((s) => s.name === word.toLowerCase() || s.aliases?.includes(word));
      if (!next) {
        ctx.out.error(`No help topic '${ctx.args.positionals.join(' ')}'.`);
        return 1;
      }
      spec = next;
      path.push(next.name);
    }
    ctx.out.writeln(commandHelp(spec, path, ctx.services));
    return 0;
  },
};

export const terminia: CommandSpec = {
  name: 'terminia',
  aliases: ['t'],
  group: 'Terminia',
  summary: 'Projects, builds, dependencies, GitHub and remote hosts',
  description: 'Run `terminia help <topic>` for details, e.g. `terminia help ios build`.',
  target: LOCAL,
  subcommands: [help, ...subcommands],
};
