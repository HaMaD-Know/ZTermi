import type { DepsJob } from '../build/plan';
import { TerminiaError } from '../core/errors';
import { fromUtf8 } from '../core/hash';
import { formatBytes } from '../core/util';
import type { Ecosystem } from '../deps/manifests';
import { bool, str, type OptionSpec, type ParsedArgs } from '../terminal/args';
import type { CommandContext, CommandSpec, ExecutionTarget } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { YES, buildTitle, confirm, followBuild, printBuild } from './common';
import { STATUS_LABELS } from '../build/types';

const ECOSYSTEMS = ['npm', 'pnpm', 'yarn', 'pip', 'gradle', 'cocoapods', 'swiftpm', 'powershell'] as const;
const RUNNABLE = ['npm', 'pnpm', 'yarn', 'pip', 'gradle', 'cocoapods', 'swiftpm'] as const;

const ecosystemOption: OptionSpec = { name: 'ecosystem', short: 'e', type: 'enum', values: ECOSYSTEMS, description: 'Which manifest to use when the project has several' };
const onOption: OptionSpec = { name: 'on', type: 'enum', values: ['github', 'remote'], description: 'Where the package manager runs: github (default) or remote' };
const remoteOption: OptionSpec = { name: 'remote', type: 'string', description: 'Remote host profile (with --on remote)', complete: 'remote-profile' };

function runTarget(args: ParsedArgs, services: CommandContext['services']): ExecutionTarget {
  if (str(args, 'on') === 'remote') {
    const ref = str(args, 'remote');
    const profile = ref ? services.remote.find(ref) : undefined;
    return { kind: 'remote', profile: profile?.name ?? ref ?? '(default host)', host: profile?.url ?? '' };
  }
  const eco = str(args, 'ecosystem');
  return { kind: 'cloud', provider: 'GitHub Actions', runner: eco === 'cocoapods' || eco === 'swiftpm' ? 'macOS' : 'Linux', purpose: 'package manager' };
}

async function jobFor(ctx: CommandContext, operation: DepsJob['operation'], packages: string[]): Promise<DepsJob> {
  const requested = str(ctx.args, 'ecosystem');
  if (requested === 'powershell') {
    throw new TerminiaError('UNSUPPORTED', 'PowerShell modules are installed on a remote PowerShell host.', {
      hint: 'remote connect <profile>, then Install-Module <name> -Scope CurrentUser (or Install-PSResource).',
    });
  }
  let ecosystem = requested as DepsJob['ecosystem'] | undefined;
  if (!ecosystem) {
    const manifests = (await ctx.services.deps.list()).filter((m) => (RUNNABLE as readonly string[]).includes(m.ecosystem));
    const unique = [...new Set(manifests.map((m) => m.ecosystem))];
    if (!unique.length) throw new TerminiaError('NOT_FOUND', 'No dependency manifest found in this project.');
    if (unique.length > 1) throw new TerminiaError('INVALID_ARGUMENT', `Several ecosystems found (${unique.join(', ')}). Choose one with --ecosystem.`);
    ecosystem = unique[0] as DepsJob['ecosystem'];
  }
  return ctx.services.deps.validateJob({ ecosystem, operation, packages, dev: bool(ctx.args, 'dev') });
}

async function runJob(ctx: CommandContext, job: DepsJob): Promise<number> {
  const { deps, ui } = ctx.services;
  const packageText = job.packages.length ? ` ${job.packages.join(' ')}` : '';
  if (str(ctx.args, 'on') === 'remote') {
    const { program, args } = deps.remoteCommand(job);
    const profile = ctx.services.remote.require(str(ctx.args, 'remote'));
    const project = ctx.services.projects.requireCurrent();
    const cwd = profile.projectPaths[project.name];
    ctx.out.info(`Runs on remote host ${profile.name}${cwd ? ` in ${cwd}` : ''}: ${program} ${args.join(' ')}`);
    ctx.out.info('This changes the project copy on that host; the iPad copy is not modified.');
    if (job.packages.length && !(await confirm(ctx, { title: 'Install packages on remote host?', message: `${program} will download and install${packageText} from its registry on ${profile.name}.`, details: [`${program} ${args.join(' ')}`], confirmLabel: 'Run' }))) return 1;
    const result = await deps.runOnRemote(profile.id, job, ctx.out, ctx.signal);
    if (result.exitCode === 0) ctx.out.success(`${program} finished on ${profile.name}.`);
    else ctx.out.error(`${program} exited with code ${result.exitCode} on ${profile.name}.`);
    return result.exitCode;
  }

  ctx.out.info(`Runs ${job.ecosystem} ${job.operation}${packageText} on a GitHub Actions ${job.ecosystem === 'cocoapods' || job.ecosystem === 'swiftpm' ? 'macOS' : 'Linux'} runner. Packages come from their public registry; nothing executes on this iPad.`);
  const result = await deps.runOnGitHub(
    job,
    {
      confirmSync: async (sync, lines) => {
        for (const l of lines) ctx.out.writeln(l);
        return confirm(ctx, { title: `Upload to ${sync.owner}/${sync.repo}?`, message: 'The runner needs the current manifest. Terminia commits these changes first.', details: lines, confirmLabel: 'Upload & run' });
      },
      progress: (m) => ctx.out.muted(m),
    },
    (record) => ctx.out.muted(`Status: ${STATUS_LABELS[record.status]}`),
    ctx.signal,
  ).catch(async (error) => {
    if (ctx.signal.aborted) {
      const latest = ctx.services.builds.latest(undefined, 'deps');
      if (latest) ctx.out.warn(`Stopped following ${buildTitle(latest)}; it continues on GitHub.`);
    }
    throw error;
  });
  if (result.build.status !== 'succeeded') {
    printBuild(ctx.out, result.build);
    return 1;
  }
  if (result.report) ctx.out.success(`${result.report.operation} finished: ${result.report.changed.length ? `changed ${result.report.changed.join(', ')}` : 'no manifest or lock file changed'}.`);
  const changed = result.files.filter((f) => f.changed);
  if (!changed.length) {
    ctx.out.info('The project files on the iPad already match the result.');
    return 0;
  }
  const details = changed.map((f) => `${f.current === null ? 'new' : 'update'}  ${f.path}  (${formatBytes(f.content.byteLength)}, ${fromUtf8(f.content).split('\n').length} lines)`);
  for (const d of details) ctx.out.writeln(`  ${d}`);
  if (!(await confirm(ctx, { title: 'Apply dependency changes?', message: 'Write these files from the runner into the project on this iPad?', details, confirmLabel: 'Apply' }))) {
    ctx.out.warn('Not applied. The result stays available in Terminia › Artifacts.');
    return 1;
  }
  const written = await deps.applyFiles(changed);
  ctx.out.success(`Updated ${written.join(', ')}. Sync or build to use them.`);
  ctx.out.action('Open Dependencies', () => ui.openView('deps'));
  return 0;
}

const list: CommandSpec = {
  name: 'list',
  aliases: ['ls'],
  summary: 'List declared dependencies and locked versions',
  target: LOCAL,
  options: [ecosystemOption],
  async run(ctx) {
    const eco = str(ctx.args, 'ecosystem');
    const manifests = (await ctx.services.deps.list()).filter((m) => !eco || m.ecosystem === eco);
    if (!manifests.length) {
      ctx.out.info('No dependency manifests found.');
      return;
    }
    for (const m of manifests) {
      ctx.out.writeln(`${m.ecosystem} · ${m.manifest}${m.lockfile ? ` · locked by ${m.lockfile}` : ' · no lockfile'}`);
      ctx.out.muted(`  Installs run with ${m.owner}.`);
      for (const note of m.notes) ctx.out.muted(`  ${note}`);
      if (m.dependencies.length) ctx.out.table(m.dependencies.map((d) => [`  ${d.name}`, d.spec, d.locked ?? '-', d.group]), ['  Name', 'Declared', 'Locked', 'Type']);
      else ctx.out.writeln('  (no dependencies)');
    }
  },
};

const info: CommandSpec = {
  name: 'info',
  summary: 'Look up a package in its registry (metadata only)',
  target: (args) => ({ kind: 'network', service: ['pip'].includes(str(args, 'ecosystem') ?? '') ? 'pypi.org' : 'registry.npmjs.org' }),
  options: [ecosystemOption],
  positionals: [{ name: 'package', description: 'Package name', required: true }],
  async run(ctx) {
    const eco = (str(ctx.args, 'ecosystem') ?? (await ctx.services.deps.list().then((m) => m[0]?.ecosystem ?? 'npm'))) as Ecosystem;
    const result = await ctx.services.deps.info(eco, ctx.args.positionals[0]!, ctx.signal);
    ctx.out.writeln(`${result.name} ${result.latest}  (${result.registry})`);
    if (result.description) ctx.out.writeln(`  ${result.description}`);
    ctx.out.writeln(`  ${result.versions} published versions${result.homepage ? ` · ${result.homepage}` : ''}`);
    if (result.deprecated) ctx.out.warn(`  Deprecated: ${result.deprecated}`);
  },
};

const add: CommandSpec = {
  name: 'add',
  summary: 'Declare packages in the manifest (optionally install them right away)',
  description: 'Edits package.json, requirements.txt or pyproject.toml on the iPad. Without a version, the latest is looked up in the registry. Packages are not installed until `terminia deps install` (or --install) runs the real package manager on a builder or remote host.',
  target: (args, services) => (bool(args, 'install') ? runTarget(args, services) : { kind: 'network', service: 'package registry' }),
  options: [ecosystemOption, { name: 'dev', short: 'D', type: 'boolean', description: 'Development dependency' }, { name: 'install', short: 'i', type: 'boolean', description: 'Install right away (with --on)' }, onOption, remoteOption, YES],
  positionals: [{ name: 'package', description: 'Packages, optionally with a version (lodash@^4, requests>=2.31)', required: true, variadic: true }],
  examples: ['terminia deps add lodash', 'terminia deps add --dev vitest@^3', 'terminia deps add requests --ecosystem pip', 'terminia deps add axios --install'],
  async run(ctx) {
    if (bool(ctx.args, 'install') && str(ctx.args, 'on') !== 'remote') {
      return runJob(ctx, await jobFor(ctx, 'add', ctx.args.positionals));
    }
    const result = await ctx.services.deps.add(ctx.args.positionals, { ecosystem: str(ctx.args, 'ecosystem'), dev: bool(ctx.args, 'dev'), signal: ctx.signal });
    for (const info of result.lookups) ctx.out.muted(`${info.name}: latest is ${info.latest} on ${info.registry}${info.deprecated ? ` (deprecated: ${info.deprecated})` : ''}`);
    for (const c of result.edit.changes) ctx.out.success(`${c.from ? 'updated' : 'added'} ${c.name} ${c.to}${c.from ? ` (was ${c.from})` : ''} in ${result.manifest.manifest}`);
    if (bool(ctx.args, 'install')) return runJob(ctx, await jobFor(ctx, 'install', []));
    ctx.out.info(`Declared only - not installed. Run \`terminia deps install\` to resolve${result.manifest.lockfile ? ' and update the lockfile' : ' and create a lockfile'} with ${result.manifest.ecosystem} on GitHub Actions.`);
    return 0;
  },
};

const remove: CommandSpec = {
  name: 'remove',
  aliases: ['rm', 'uninstall'],
  summary: 'Remove packages from the manifest',
  target: LOCAL,
  options: [ecosystemOption],
  positionals: [{ name: 'package', description: 'Packages', required: true, variadic: true }],
  async run(ctx) {
    const result = await ctx.services.deps.remove(ctx.args.positionals, { ecosystem: str(ctx.args, 'ecosystem') });
    for (const c of result.edit.changes) ctx.out.success(`removed ${c.name} (${c.from}) from ${result.manifest.manifest}`);
    ctx.out.info('Run `terminia deps install` to update the lockfile.');
  },
};

const install: CommandSpec = {
  name: 'install',
  summary: 'Install dependencies with the real package manager (GitHub Actions or a remote host)',
  description: 'On GitHub Actions the project is synced, the package manager runs on a clean runner, and the resulting lockfile/manifest are offered back to the project. On a remote host the command runs in that host\'s copy of the project.',
  target: runTarget,
  options: [ecosystemOption, onOption, remoteOption, YES],
  async run(ctx) {
    return runJob(ctx, await jobFor(ctx, 'install', []));
  },
};

const update: CommandSpec = {
  name: 'update',
  aliases: ['upgrade'],
  summary: 'Update dependencies (all, or the named ones) with the real package manager',
  target: runTarget,
  options: [ecosystemOption, onOption, remoteOption, YES],
  positionals: [{ name: 'package', description: 'Packages (default: all)', variadic: true }],
  async run(ctx) {
    return runJob(ctx, await jobFor(ctx, 'update', ctx.args.positionals));
  },
};

const resolve: CommandSpec = {
  name: 'resolve',
  summary: 'Resolve and report the full dependency graph on a builder (Gradle, CocoaPods, SwiftPM, npm…)',
  target: runTarget,
  options: [ecosystemOption, YES],
  async run(ctx) {
    return runJob(ctx, await jobFor(ctx, 'list', []));
  },
};

const logs: CommandSpec = {
  name: 'logs',
  summary: 'Show the latest dependency job',
  target: { kind: 'network', service: 'GitHub API' },
  async run(ctx) {
    const record = ctx.services.builds.require(undefined, undefined, 'deps');
    if (record.runId && record.status !== 'succeeded' && record.status !== 'failed' && record.status !== 'cancelled') {
      await followBuild(ctx, record, 'deps');
      return;
    }
    printBuild(ctx.out, record);
    for (const entry of await ctx.services.builds.logs(record.id, { signal: ctx.signal })) {
      ctx.out.writeln(`━━ ${entry.job.name}`);
      if (entry.log) ctx.out.write(entry.log.split(/\r?\n/).slice(-200).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')).join('\n') + '\n');
      else if (entry.pending) ctx.out.info(entry.pending);
    }
  },
};

export const depsGroup: CommandSpec = {
  name: 'deps',
  aliases: ['dependencies'],
  summary: 'Dependencies: list, add, remove, install, update',
  description: 'The iPad has no Node.js, Python or CocoaPods. Terminia reads and edits manifests locally and runs the real package managers on GitHub Actions runners or a remote host - never on the iPad.',
  target: LOCAL,
  subcommands: [list, info, add, remove, install, update, resolve, logs],
};
