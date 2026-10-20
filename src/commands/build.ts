import { installNote } from '../artifacts/artifacts';
import type { BuildOverrides } from '../build/plan';
import { isTerminal } from '../build/state';
import type { BuildPlatform, BuildRecord } from '../build/types';
import { STATUS_LABELS } from '../build/types';
import { TerminiaError } from '../core/errors';
import { displayPath } from '../core/paths';
import { formatBytes, formatDateTime, relativeTime } from '../core/util';
import { ANDROID_OUTPUTS, IOS_EXPORT_METHODS, WEB_KINDS, parseRepoSlug, type ProjectConfig } from '../projects/config';
import { bool, num, str, type OptionSpec } from '../terminal/args';
import type { CommandContext, CommandSpec, ExecutionTarget } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { GITHUB_API, YES, buildTitle, confirm, followBuild, printBuild, printChecks, printJobs, progressPrinter } from './common';

const LABEL: Record<BuildPlatform, string> = { ios: 'iOS', android: 'Android', web: 'Web' };

function cloud(platform: BuildPlatform, runner?: string): ExecutionTarget {
  if (platform === 'ios') return { kind: 'cloud', provider: 'GitHub Actions', runner: 'macOS', purpose: 'Xcode build' };
  if (platform === 'android') return { kind: 'cloud', provider: 'GitHub Actions', runner: 'Linux', purpose: 'Gradle build' };
  return { kind: 'cloud', provider: 'GitHub Actions', runner: runner === 'macos' ? 'macOS' : 'Linux', purpose: 'web build' };
}

const COMMON_BUILD_OPTIONS: OptionSpec[] = [
  { name: 'branch', short: 'b', type: 'string', description: 'Branch to build (default: the configured branch, else the default branch)' },
  { name: 'sync', type: 'enum', values: ['commit', 'none'], description: 'commit = upload the project first (default); none = build what is on GitHub' },
  { name: 'delete', type: 'boolean', description: 'When syncing, also delete files on GitHub that are not in the project' },
  { name: 'follow', type: 'boolean', description: 'Follow progress until the build finishes (default; --no-follow to return at once)' },
  YES,
];

const PLATFORM_OPTIONS: Record<BuildPlatform, OptionSpec[]> = {
  ios: [
    { name: 'configuration', short: 'c', type: 'enum', values: ['debug', 'release'], description: 'Xcode build configuration' },
    { name: 'export', short: 'e', aliases: ['export-method'], type: 'enum', values: IOS_EXPORT_METHODS, description: 'unsigned, or a signed export method (needs signing secrets)' },
    { name: 'scheme', type: 'string', description: 'Xcode scheme (default: App, or the first shared scheme)' },
  ],
  android: [
    { name: 'variant', short: 'v', type: 'enum', values: ['debug', 'release'], description: 'Build variant (release needs signing secrets)' },
    { name: 'output', short: 'o', type: 'enum', values: ANDROID_OUTPUTS, description: 'apk, aab or both' },
    { name: 'module', type: 'string', description: 'Gradle application module (default app)' },
  ],
  web: [
    { name: 'kind', type: 'enum', values: WEB_KINDS, description: 'web, node, python or custom' },
    { name: 'command', type: 'string', description: 'Build command to run on the runner (shown before starting)' },
    { name: 'output-path', type: 'string', description: 'Output folder or file, relative to the project' },
    { name: 'runner', type: 'enum', values: ['linux', 'macos'], description: 'Runner operating system' },
    { name: 'profile', short: 'p', type: 'string', description: 'Custom build profile from .terminia/config.json' },
  ],
};

function overridesFrom(ctx: CommandContext, platform: BuildPlatform): BuildOverrides {
  const a = ctx.args;
  const o: BuildOverrides = {
    branch: str(a, 'branch'),
    sync: str(a, 'sync') as BuildOverrides['sync'],
    deleteRemoved: a.options.delete === true ? true : undefined,
  };
  if (platform === 'ios') {
    o.configuration = str(a, 'configuration') as BuildOverrides['configuration'];
    o.exportMethod = str(a, 'export') as BuildOverrides['exportMethod'];
    o.scheme = str(a, 'scheme');
  } else if (platform === 'android') {
    o.variant = str(a, 'variant') as BuildOverrides['variant'];
    o.output = str(a, 'output') as BuildOverrides['output'];
    o.module = str(a, 'module');
  } else {
    o.kind = str(a, 'kind') as BuildOverrides['kind'];
    o.command = str(a, 'command');
    o.outputPath = str(a, 'output-path');
    o.runner = str(a, 'runner') as BuildOverrides['runner'];
    o.profile = str(a, 'profile');
  }
  for (const key of Object.keys(o) as (keyof BuildOverrides)[]) if (o[key] === undefined) delete o[key];
  return o;
}

export async function runBuild(ctx: CommandContext, platform: BuildPlatform, overrides: BuildOverrides): Promise<number> {
  const out = ctx.out;
  const { builds, ui } = ctx.services;
  out.muted(`Checking the ${LABEL[platform]} build configuration…`);
  const plan = await builds.prepare({ kind: 'build', platform, overrides }, ctx.signal);
  out.writeln(`${LABEL[platform]} build of ${plan.project.name} · ${plan.summary}`);
  out.writeln(`  Repository: ${plan.repo.owner ? `${plan.repo.owner}/${plan.repo.repo}` : '(not set)'} · branch ${plan.branch} · workflow ${plan.workflow}`);
  out.writeln(`  Runs on:    GitHub Actions ${plan.runner} runner — ${plan.sync === 'commit' ? 'the project is uploaded (committed) first' : 'builds what is already on GitHub'}`);
  printChecks(out, plan.checks);

  const record = await builds.start(
    plan,
    {
      confirmSync: async (sync, lines) => {
        for (const line of lines) out.writeln(line);
        return confirm(ctx, {
          title: `Upload to ${sync.owner}/${sync.repo}?`,
          message: `Terminia will commit the listed changes to the branch ${sync.branch} and then start the build. Detected secrets are never uploaded.`,
          details: lines,
          confirmLabel: 'Upload & build',
        });
      },
      confirmCommand: (command, runner) =>
        confirm(ctx, {
          title: 'Run this build command?',
          message: `The project's build command runs on a temporary GitHub Actions ${runner} runner (not on this iPad):`,
          details: [command],
          confirmLabel: 'Run on runner',
        }),
      progress: (message) => out.muted(message),
    },
    ctx.signal,
  );

  if (record.status === 'waiting_for_signing') {
    out.warn(`${STATUS_LABELS[record.status]}: ${record.error?.message ?? ''}`);
    if (record.error?.hint) out.info(record.error.hint);
    return 1;
  }
  if (record.status === 'cancelled') {
    out.warn(record.error?.message ?? 'Cancelled.');
    return 130;
  }
  if (record.status === 'failed' && !record.runId) {
    printBuild(out, record);
    return 1;
  }
  out.success(`Started ${buildTitle(record)}${record.runUrl ? ` — ${record.runUrl}` : ''}`);
  out.action('Open in Builds', () => ui.openView('builds', { id: record.id }));
  if (ctx.args.options.follow === false) {
    out.info(`Check progress with \`terminia ${platform} status\` or in the Builds view.`);
    return 0;
  }
  const final = await followBuild(ctx, record, platform);
  if (final.status === 'succeeded') {
    const packages = final.artifacts.filter((a) => !/-logs(-\d+)?$/.test(a.name));
    out.success(`Build succeeded${packages.length ? `: ${packages.map((a) => a.name).join(', ')}` : ''}.`);
    if (packages.length) {
      out.info(`Download with \`terminia ${platform} download\`.`);
      out.action('Download', () => ui.openView('artifacts', { build: final.id }));
    }
    return 0;
  }
  return isTerminal(final.status) ? 1 : 0;
}

function configureCommand(platform: BuildPlatform): CommandSpec {
  const options: OptionSpec[] = [
    { name: 'repo', type: 'string', description: 'GitHub repository (owner/name)' },
    { name: 'branch', type: 'string', description: 'Branch builds use (default: repository default branch)' },
    { name: 'project-path', type: 'string', description: 'Folder of the project inside the repository (default .)' },
    { name: 'sync', type: 'enum', values: ['commit', 'none'], description: 'Default sync strategy' },
    { name: 'workflow', type: 'string', description: 'Workflow file name' },
  ];
  if (platform === 'ios') {
    options.push(
      { name: 'configuration', type: 'enum', values: ['debug', 'release'], description: 'Default configuration' },
      { name: 'export', type: 'enum', values: IOS_EXPORT_METHODS, description: 'Default export method' },
      { name: 'scheme', type: 'string', description: 'Xcode scheme' },
      { name: 'xcode', type: 'string', description: 'Xcode version on the runner (e.g. 26.5)' },
      { name: 'generate-native', type: 'boolean', description: 'Run `npx cap add ios` when ios/ is missing' },
    );
  } else if (platform === 'android') {
    options.push(
      { name: 'variant', type: 'enum', values: ['debug', 'release'], description: 'Default variant' },
      { name: 'output', type: 'enum', values: ANDROID_OUTPUTS, description: 'Default package format' },
      { name: 'module', type: 'string', description: 'Gradle application module' },
      { name: 'java', type: 'string', description: 'JDK major version (e.g. 21)' },
      { name: 'generate-native', type: 'boolean', description: 'Run `npx cap add android` when android/ is missing' },
    );
  } else {
    options.push(
      { name: 'kind', type: 'enum', values: WEB_KINDS, description: 'Default build kind' },
      { name: 'command', type: 'string', description: 'Default build command' },
      { name: 'output-path', type: 'string', description: 'Default output folder' },
      { name: 'node', type: 'string', description: 'Node.js version on the runner' },
      { name: 'python', type: 'string', description: 'Python version on the runner' },
    );
  }
  return {
    name: 'configure',
    summary: `Show or change the ${LABEL[platform]} build settings`,
    description: 'Without options: shows the settings and runs the preflight checks (nothing is changed). With options: saves them in .terminia/config.json.',
    target: LOCAL,
    options,
    examples: platform === 'ios' ? ['terminia ios configure', 'terminia ios configure --repo me/myapp --export ad-hoc'] : platform === 'android' ? ['terminia android configure --variant release --output both'] : ['terminia web configure --kind node --command "npm run build" --output-path dist'],
    async run(ctx) {
      const a = ctx.args;
      const { projects, github } = ctx.services;
      const changes = Object.keys(a.options).filter((k) => a.options[k] !== undefined);
      if (!changes.length) {
        const project = projects.requireCurrent();
        const config = await projects.config(project);
        ctx.out.writeln(`${LABEL[platform]} build settings for ${project.name} (.terminia/config.json)`);
        printConfig(ctx, platform, config);
        ctx.out.muted('Preflight checks:');
        const plan = await ctx.services.builds.prepare({ kind: 'build', platform }, ctx.signal);
        printChecks(ctx.out, plan.checks);
        return;
      }
      let repoInfo: { owner: string; repo: string } | null = null;
      if (str(a, 'repo')) {
        repoInfo = parseRepoSlug(str(a, 'repo')!);
        if (await github.credential()) {
          const repo = await github.repo(repoInfo.owner, repoInfo.repo, ctx.signal);
          ctx.out.muted(`Found ${repo.full_name} (${repo.private ? 'private' : 'public'}, default branch ${repo.default_branch}).`);
        } else ctx.out.warn('GitHub is not connected, so the repository was not verified.');
      }
      const config = await projects.updateConfig((c) => {
        if (repoInfo) {
          c.github.owner = repoInfo.owner;
          c.github.repo = repoInfo.repo;
        }
        if (str(a, 'branch') !== undefined) c.github.branch = str(a, 'branch')!;
        if (str(a, 'project-path') !== undefined) c.github.projectPath = str(a, 'project-path')!;
        if (str(a, 'sync')) c.github.sync = str(a, 'sync') as 'commit' | 'none';
        if (platform === 'ios') {
          if (str(a, 'workflow')) c.ios.workflow = str(a, 'workflow')!;
          if (str(a, 'configuration')) c.ios.configuration = str(a, 'configuration') as 'debug' | 'release';
          if (str(a, 'export')) c.ios.exportMethod = str(a, 'export') as ProjectConfig['ios']['exportMethod'];
          if (str(a, 'scheme') !== undefined) c.ios.scheme = str(a, 'scheme')!;
          if (str(a, 'xcode')) c.ios.xcodeVersion = str(a, 'xcode')!;
          if (a.options['generate-native'] !== undefined) c.ios.generateNative = bool(a, 'generate-native');
        } else if (platform === 'android') {
          if (str(a, 'workflow')) c.android.workflow = str(a, 'workflow')!;
          if (str(a, 'variant')) c.android.variant = str(a, 'variant') as 'debug' | 'release';
          if (str(a, 'output')) c.android.output = str(a, 'output') as ProjectConfig['android']['output'];
          if (str(a, 'module')) c.android.module = str(a, 'module')!;
          if (str(a, 'java')) c.android.javaVersion = str(a, 'java')!;
          if (a.options['generate-native'] !== undefined) c.android.generateNative = bool(a, 'generate-native');
        } else {
          if (str(a, 'workflow')) c.web.workflow = str(a, 'workflow')!;
          if (str(a, 'kind')) c.web.kind = str(a, 'kind') as ProjectConfig['web']['kind'];
          if (str(a, 'command') !== undefined) c.web.command = str(a, 'command')!;
          if (str(a, 'output-path') !== undefined) c.web.output = str(a, 'output-path')!;
          if (str(a, 'node')) c.web.nodeVersion = str(a, 'node')!;
          if (str(a, 'python')) c.web.pythonVersion = str(a, 'python')!;
        }
      });
      ctx.out.success('Saved .terminia/config.json');
      printConfig(ctx, platform, config);
    },
  };
}

function printConfig(ctx: CommandContext, platform: BuildPlatform, c: ProjectConfig): void {
  const rows: string[][] = [
    ['Repository', c.github.owner && c.github.repo ? `${c.github.owner}/${c.github.repo}` : '(not set)'],
    ['Branch', c.github.branch || '(repository default)'],
    ['Project folder in repo', c.github.projectPath],
    ['Sync', c.github.sync === 'commit' ? 'commit project before building' : 'build what is on GitHub'],
  ];
  if (platform === 'ios') {
    rows.push(['Workflow', c.ios.workflow], ['Configuration', c.ios.configuration], ['Export', c.ios.exportMethod], ['Scheme', c.ios.scheme || '(auto)'], ['Xcode', c.ios.xcodeVersion], ['Generate ios/', String(c.ios.generateNative)]);
  } else if (platform === 'android') {
    rows.push(['Workflow', c.android.workflow], ['Variant', c.android.variant], ['Output', c.android.output], ['Module', c.android.module], ['JDK', c.android.javaVersion], ['Generate android/', String(c.android.generateNative)]);
  } else {
    rows.push(['Workflow', c.web.workflow], ['Kind', c.web.kind], ['Command', c.web.command || '(npm run build / python -m build)'], ['Output', c.web.output || '(default)'], ['Node.js', c.web.nodeVersion], ['Python', c.web.pythonVersion]);
    for (const p of c.profiles) rows.push([`Profile ${p.name}`, `${p.target} · ${p.runner} · ${p.command || '(default command)'}`]);
  }
  ctx.out.table(rows.map(([k, v]) => [`  ${k}`, v!]));
}

function recordFor(ctx: CommandContext, platform: BuildPlatform): BuildRecord {
  return ctx.services.builds.require(ctx.args.positionals[0] ?? str(ctx.args, 'build'), platform);
}

const BUILD_ARG = { name: 'build', description: 'Build id (default: the latest)', complete: 'build' as const };

function cleanLogLine(line: string, keepTimestamps: boolean): { stream: 'stdout' | 'stderr' | 'warn' | 'muted'; text: string } | null {
  let text = keepTimestamps ? line : line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z\s?/, '');
  if (text.startsWith('##[group]')) return { stream: 'muted', text: `▸ ${text.slice(9)}` };
  if (text.startsWith('##[endgroup]')) return null;
  if (text.startsWith('##[error]')) return { stream: 'stderr', text: text.slice(9) };
  if (text.startsWith('##[warning]')) return { stream: 'warn', text: text.slice(11) };
  if (text.startsWith('##[')) text = text.replace(/^##\[[a-z]+\]/, '');
  return { stream: 'stdout', text };
}

export function platformGroup(platform: BuildPlatform): CommandSpec {
  const name = platform;
  const build: CommandSpec = {
    name: 'build',
    summary: platform === 'ios' ? 'Build an iOS IPA on a GitHub Actions macOS runner' : platform === 'android' ? 'Build an Android APK/AAB on a GitHub Actions Linux runner' : 'Build a web, Node.js, Python or custom project on GitHub Actions',
    description:
      platform === 'ios'
        ? 'Syncs the project to GitHub (after showing exactly what will be uploaded), starts the Terminia iOS workflow and follows it. An unsigned IPA must be signed before it can be installed; signed exports need signing secrets in the repository (docs/SIGNING.md).'
        : platform === 'android'
          ? 'Syncs the project, starts the Terminia Android workflow and follows it. APKs are Android packages: they cannot be installed on an iPad.'
          : 'Syncs the project and runs its build on a temporary runner; the output folder is uploaded as an artifact.',
    target: (args) => cloud(platform, str(args, 'runner')),
    options: [...PLATFORM_OPTIONS[platform], ...COMMON_BUILD_OPTIONS],
    examples:
      platform === 'ios'
        ? ['terminia ios build', 'terminia ios build --configuration release', 'terminia ios build --export ad-hoc', 'terminia ios build --sync none --branch main']
        : platform === 'android'
          ? ['terminia android build --variant debug', 'terminia android build --variant release --output both']
          : ['terminia web build', 'terminia web build --kind python', 'terminia web build --profile docs'],
    run: (ctx) => runBuild(ctx, platform, overridesFrom(ctx, platform)),
  };

  const status: CommandSpec = {
    name: 'status',
    summary: `Show the status of the latest (or a given) ${LABEL[platform]} build`,
    target: GITHUB_API,
    positionals: [BUILD_ARG],
    async run(ctx) {
      let record = recordFor(ctx, platform);
      if (record.runId && !isTerminal(record.status)) record = await ctx.services.builds.refresh(record.id, ctx.signal);
      printBuild(ctx.out, record);
      ctx.out.action('Open in Builds', () => ctx.services.ui.openView('builds', { id: record.id }));
    },
  };

  const logs: CommandSpec = {
    name: 'logs',
    summary: 'Show the real job logs from GitHub Actions',
    description: 'Finished jobs show their full log; running jobs show live step status (GitHub publishes the log text when a job finishes).',
    target: GITHUB_API,
    options: [
      { name: 'job', short: 'j', type: 'string', description: 'Only jobs whose name contains this text' },
      { name: 'lines', short: 'n', type: 'number', description: 'Last N lines per job (default 400)' },
      { name: 'all', short: 'a', type: 'boolean', description: 'Print the whole log' },
      { name: 'timestamps', short: 't', type: 'boolean', description: 'Keep GitHub timestamps' },
      { name: 'build', type: 'string', description: 'Build id', complete: 'build' },
    ],
    positionals: [BUILD_ARG],
    async run(ctx) {
      const record = recordFor(ctx, platform);
      if (!record.runId) {
        printBuild(ctx.out, record);
        return 1;
      }
      const jobLogs = await ctx.services.builds.logs(record.id, { job: str(ctx.args, 'job'), signal: ctx.signal });
      if (!jobLogs.length) ctx.out.info('No jobs yet - the run may still be queued.');
      const limit = bool(ctx.args, 'all') ? Infinity : (num(ctx.args, 'lines') ?? 400);
      for (const entry of jobLogs) {
        ctx.out.writeln(`━━ ${entry.job.name} (${entry.job.status}${entry.job.conclusion ? `, ${entry.job.conclusion}` : ''})`);
        if (!entry.log) {
          printJobs(ctx.out, [entry.job]);
          if (entry.pending) ctx.out.info(entry.pending);
          continue;
        }
        const all = entry.log.split(/\r?\n/);
        const shown = all.length > limit ? all.slice(all.length - limit) : all;
        if (shown.length < all.length) ctx.out.muted(`… ${all.length - shown.length} earlier lines (use --all)`);
        let buffer = '';
        for (const raw of shown) {
          const line = cleanLogLine(raw, bool(ctx.args, 'timestamps'));
          if (!line) continue;
          if (line.stream === 'stdout') buffer += `${line.text}\n`;
          else {
            if (buffer) ctx.out.write(buffer);
            buffer = '';
            if (line.stream === 'stderr') ctx.out.error(line.text);
            else if (line.stream === 'warn') ctx.out.warn(line.text);
            else ctx.out.muted(line.text);
          }
        }
        if (buffer) ctx.out.write(buffer);
      }
      if (record.annotations.length) {
        ctx.out.writeln('━━ Annotations');
        for (const a of record.annotations) (a.level === 'failure' ? ctx.out.error : ctx.out.warn).call(ctx.out, `${a.title ? `${a.title}: ` : ''}${a.message}`);
      }
      return 0;
    },
  };

  const artifacts: CommandSpec = {
    name: 'artifacts',
    summary: 'List the artifacts a build produced',
    target: GITHUB_API,
    positionals: [BUILD_ARG],
    async run(ctx) {
      const record = recordFor(ctx, platform);
      const list = await ctx.services.builds.artifacts(record.id, ctx.signal);
      if (!list.length) {
        ctx.out.info(`${buildTitle(record)} has no artifacts (${STATUS_LABELS[record.status]}).`);
        return;
      }
      ctx.out.table(
        list.map((a) => [a.name, formatBytes(a.sizeBytes), a.expired ? 'expired' : a.expiresAt ? relativeTime(a.expiresAt) : '-', ctx.services.artifacts.downloaded(a.id) ? 'yes' : 'no']),
        ['Name', 'Size', 'Expires', 'Downloaded'],
      );
    },
  };

  const download: CommandSpec = {
    name: 'download',
    summary: 'Download a build artifact to Terminia › Artifacts (and optionally Save to Files)',
    target: { kind: 'network', service: 'GitHub artifact storage' },
    options: [
      { name: 'build', type: 'string', description: 'Build id (default: the latest)', complete: 'build' },
      { name: 'save', short: 's', type: 'boolean', description: 'Then show "Save to Files" to choose a location' },
    ],
    positionals: [{ name: 'artifact', description: 'Artifact name or id (default: the build package)' }],
    async run(ctx) {
      const record = ctx.services.builds.require(str(ctx.args, 'build'), platform);
      if (!isTerminal(record.status)) throw new TerminiaError('CONFLICT', `${buildTitle(record)} is ${STATUS_LABELS[record.status].toLowerCase()}; artifacts appear when it finishes.`);
      const artifact = await ctx.services.artifacts.resolve(record, ctx.args.positionals[0], ctx.signal);
      ctx.out.info(`Downloading ${artifact.name} (${formatBytes(artifact.sizeBytes)}) from GitHub…`);
      const printer = progressPrinter(ctx.out, artifact.name);
      const item = await ctx.services.artifacts.download(record, artifact, { signal: ctx.signal, onProgress: (d) => printer(d.received, d.total) });
      ctx.out.success(`Saved ${displayPath(item.file)} (${formatBytes(item.size)})`);
      ctx.out.writeln(`  SHA-256: ${item.sha256}${item.digestVerified ? '  (matches GitHub\'s digest)' : ''}`);
      const note = installNote(item.kind, record);
      if (note) ctx.out.info(note);
      ctx.out.info('The file is in the Files app under On My iPad › Terminia › Artifacts.');
      ctx.out.action('Save to Files…', async () => void (await ctx.services.artifacts.saveToFiles(item)));
      if (bool(ctx.args, 'save')) {
        const saved = await ctx.services.artifacts.saveToFiles(item);
        ctx.out.info(saved ? 'Saved to the chosen location.' : 'Save to Files was cancelled; the file is still in Terminia › Artifacts.');
      }
    },
  };

  const cancel: CommandSpec = {
    name: 'cancel',
    summary: 'Ask GitHub to cancel a running build',
    target: GITHUB_API,
    positionals: [BUILD_ARG],
    async run(ctx) {
      const record = await ctx.services.builds.cancel(recordFor(ctx, platform).id);
      ctx.out.success(`Cancellation requested for ${buildTitle(record)}. GitHub reports the final status shortly.`);
    },
  };

  const history: CommandSpec = {
    name: 'history',
    summary: `List ${LABEL[platform]} builds`,
    target: (args) => (args.options.remote ? GITHUB_API : LOCAL),
    options: [
      { name: 'limit', short: 'n', type: 'number', description: 'Number of builds (default 20)' },
      { name: 'remote', short: 'r', type: 'boolean', description: 'List runs on GitHub, including ones not started from Terminia' },
    ],
    async run(ctx) {
      const limit = num(ctx.args, 'limit') ?? 20;
      if (bool(ctx.args, 'remote')) {
        const config = await ctx.services.projects.config();
        if (!config.github.owner) throw new TerminiaError('CONFIG_REQUIRED', 'No repository configured.', { hint: 'terminia github use <owner>/<repo>' });
        const workflow = platform === 'ios' ? config.ios.workflow : platform === 'android' ? config.android.workflow : config.web.workflow;
        const runs = await ctx.services.builds.remoteRuns(config.github.owner, config.github.repo, workflow, ctx.signal);
        ctx.out.table(
          runs.slice(0, limit).map((r) => [`#${r.number}`, r.conclusion ?? r.status ?? '', r.event, r.branch ?? '', formatDateTime(r.createdAt), r.title.slice(0, 60)]),
          ['Run', 'Result', 'Event', 'Branch', 'Created', 'Title'],
        );
        return;
      }
      const records = (await ctx.services.builds.history()).filter((r) => r.platform === platform && r.kind === 'build').slice(0, limit);
      if (!records.length) {
        ctx.out.info(`No ${LABEL[platform]} builds started from Terminia yet. Start one with \`terminia ${name} build\`.`);
        return;
      }
      ctx.out.table(
        records.map((r) => [r.id, STATUS_LABELS[r.status], r.runNumber ? `#${r.runNumber}` : '-', r.summary, r.project.name, formatDateTime(r.createdAt)]),
        ['Build', 'Status', 'Run', 'Settings', 'Project', 'Started'],
      );
    },
  };

  return {
    name,
    summary: platform === 'ios' ? 'Build iOS apps (IPA) on macOS runners' : platform === 'android' ? 'Build Android apps (APK/AAB) on Linux runners' : 'Build web, Node.js, Python and custom projects',
    target: LOCAL,
    subcommands: [configureCommand(platform), build, status, logs, artifacts, download, cancel, history],
  };
}

/** `terminia build [target]`: picks the target from project detection, or insists on an explicit one. */
export const buildAny: CommandSpec = {
  name: 'build',
  summary: 'Build the current project for a target (ios, android, web, node, python, custom)',
  target: (args) => {
    const t = args.positionals[0]?.toLowerCase();
    return t === 'ios' ? cloud('ios') : t === 'android' ? cloud('android') : t ? cloud('web', str(args, 'runner')) : { kind: 'cloud', provider: 'GitHub Actions', runner: 'macOS or Linux' };
  },
  positionals: [{ name: 'target', description: 'ios, android, web, node, python or custom (required when several are possible)', values: ['ios', 'android', 'web', 'node', 'python', 'custom'] }],
  options: [...PLATFORM_OPTIONS.ios, ...PLATFORM_OPTIONS.android, ...PLATFORM_OPTIONS.web.filter((o) => o.name !== 'kind'), ...COMMON_BUILD_OPTIONS],
  async run(ctx) {
    let target = ctx.args.positionals[0]?.toLowerCase();
    if (!target) {
      const detection = await ctx.services.projects.detect();
      const viable = detection.targets.filter((t) => t.viable).map((t) => t.platform);
      if (viable.length === 1) {
        target = viable[0];
        ctx.out.info(`Detected target: ${target}`);
      } else if (!viable.length) {
        throw new TerminiaError('CONFIG_REQUIRED', 'No build target fits this project.', { hint: detection.targets.map((t) => `${t.platform}: ${t.reason}`).join('\n') });
      } else {
        throw new TerminiaError('INVALID_ARGUMENT', `This project can be built for several targets (${viable.join(', ')}). Choose one: terminia build ${viable.join('|')}`);
      }
    }
    const platform: BuildPlatform = target === 'ios' || target === 'android' ? target : 'web';
    const overrides = overridesFrom(ctx, platform);
    if (platform === 'web' && target !== 'web') overrides.kind = target as BuildOverrides['kind'];
    return runBuild(ctx, platform, overrides);
  },
};
