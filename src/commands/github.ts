import { TerminiaError } from '../core/errors';
import { unifiedDiff } from '../core/diff';
import { base64ToBytes, fromUtf8, gitBlobSha, utf8 } from '../core/hash';
import { GITIGNORE_TEMPLATE } from '../core/ignore';
import { joinPath } from '../core/paths';
import { formatDateTime } from '../core/util';
import { blobSchema, commitListSchema, gitTreeSchema } from '../github/schemas';
import { describePlan, executeSync, planSync } from '../github/sync';
import { TEMPLATE_FILES, installTemplates, templateStatus } from '../github/workflows';
import { parseRepoSlug } from '../projects/config';
import { bool, num, str } from '../terminal/args';
import type { CommandContext, CommandSpec } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { GITHUB_API, YES, abs, confirm } from './common';

async function repoConfig(ctx: CommandContext) {
  const project = ctx.services.projects.requireCurrent();
  const config = await ctx.services.projects.config(project);
  if (!config.github.owner || !config.github.repo) {
    throw new TerminiaError('CONFIG_REQUIRED', 'No GitHub repository is set for this project.', { hint: 'terminia github use <owner>/<repo>' });
  }
  return { project, config, owner: config.github.owner, repo: config.github.repo };
}

const login: CommandSpec = {
  name: 'login',
  summary: 'Connect GitHub (device sign-in or a personal access token, stored in the iOS Keychain)',
  description:
    'Device sign-in shows a code to enter at github.com/login/device; it needs the client id of your GitHub OAuth App or GitHub App (Settings › Build Providers › GitHub). A fine-grained token needs Actions, Contents and Workflows (read & write) and Metadata (read). Either way, the token is stored natively and is only sent to api.github.com.',
  target: { kind: 'network', service: 'github.com' },
  options: [
    { name: 'token', type: 'boolean', description: 'Enter a personal access token' },
    { name: 'device', type: 'boolean', description: 'Use the OAuth device flow (default when a client id is configured)' },
  ],
  async run(ctx) {
    const { github, settings, ui, platform } = ctx.services;
    const useDevice = bool(ctx.args, 'device') || (!bool(ctx.args, 'token') && !!settings.get().githubClientId && platform.isNative);
    let status;
    if (useDevice) {
      let dialog: { close(): void } | null = null;
      try {
        status = await github.loginWithDevice((code) => {
          ctx.out.info(`Open ${code.verificationUri} and enter the code ${code.userCode} (valid for ${Math.round(code.expiresIn / 60)} minutes).`);
          ctx.out.action('Open github.com/login/device', () => platform.openUrl(code.verificationUri));
          dialog = ui.showDeviceCode(code);
        }, ctx.signal);
      } finally {
        (dialog as { close(): void } | null)?.close();
      }
    } else {
      if (!platform.isNative) ctx.out.warn('Browser preview: the token is kept in memory for this tab only (there is no Keychain here).');
      status = await github.loginWithToken();
    }
    ctx.out.success(`Connected to GitHub as ${status.user?.login}${status.scopes?.length ? ` (scopes: ${status.scopes.join(', ')})` : ''}.`);
  },
};

const logout: CommandSpec = {
  name: 'logout',
  summary: 'Remove the GitHub credential from this iPad',
  target: LOCAL,
  async run(ctx) {
    await ctx.services.github.logout();
    ctx.out.success('GitHub credential removed. Revoke the token on github.com too if you no longer need it.');
  },
};

const status: CommandSpec = {
  name: 'status',
  summary: 'Show the GitHub connection',
  target: GITHUB_API,
  async run(ctx) {
    const s = await ctx.services.github.status(ctx.signal);
    if (!s.credential) {
      ctx.out.info('Not connected. Run `terminia github login`.');
      return 1;
    }
    if (!s.connected) {
      ctx.out.error(`Stored credential did not work: ${s.error}`);
      return 1;
    }
    ctx.out.writeln(`Connected as ${s.user!.login}${s.user!.name ? ` (${s.user!.name})` : ''}`);
    ctx.out.writeln(`  Credential: ${s.credential.kind} · stored in ${ctx.services.platform.vault.storage === 'keychain' ? 'the iOS Keychain' : 'memory (browser preview)'} · only sent to ${s.credential.allowedOrigins.join(', ')}`);
    if (s.scopes) ctx.out.writeln(`  Scopes: ${s.scopes.join(', ') || '(fine-grained permissions)'}`);
    const limit = ctx.services.github.client().lastRateLimit;
    if (limit) ctx.out.writeln(`  API rate limit: ${limit.remaining}/${limit.limit}, resets ${formatDateTime(limit.resetAt)}`);
    return 0;
  },
};

const repos: CommandSpec = {
  name: 'repos',
  summary: 'List repositories you can access',
  target: GITHUB_API,
  positionals: [{ name: 'filter', description: 'Text to filter names' }],
  async run(ctx) {
    const filter = ctx.args.positionals[0]?.toLowerCase();
    const list = (await ctx.services.github.repos(ctx.signal)).filter((r) => !filter || r.full_name.toLowerCase().includes(filter));
    ctx.out.table(list.map((r) => [r.full_name, r.private ? 'private' : 'public', r.default_branch, r.permissions?.push ? 'write' : 'read', r.pushed_at ? formatDateTime(r.pushed_at) : '']), ['Repository', 'Visibility', 'Default branch', 'Access', 'Last push']);
  },
};

const use: CommandSpec = {
  name: 'use',
  summary: 'Set the GitHub repository (and branch) this project builds in',
  target: GITHUB_API,
  options: [
    { name: 'branch', short: 'b', type: 'string', description: 'Branch to sync and build (default: the repository default branch)' },
    { name: 'path', type: 'string', description: 'Folder of the project inside the repository (default .)' },
  ],
  positionals: [{ name: 'repository', description: 'owner/name', required: true }],
  async run(ctx) {
    const { owner, repo } = parseRepoSlug(ctx.args.positionals[0]!);
    const info = await ctx.services.github.repo(owner, repo, ctx.signal);
    await ctx.services.projects.updateConfig((c) => {
      c.github.owner = info.owner.login;
      c.github.repo = info.name;
      if (str(ctx.args, 'branch') !== undefined) c.github.branch = str(ctx.args, 'branch')!;
      if (str(ctx.args, 'path') !== undefined) c.github.projectPath = str(ctx.args, 'path')!;
    });
    ctx.out.success(`This project now builds in ${info.full_name} (${info.private ? 'private' : 'public'}, default branch ${info.default_branch}).`);
    if (!info.permissions?.push) ctx.out.warn('You have read-only access: syncing will fail. Use --sync none to build existing commits.');
    ctx.out.info('Saved in .terminia/config.json. Next: `terminia ci install`, then `terminia github prepare`.');
  },
};

const branches: CommandSpec = {
  name: 'branches',
  summary: 'List branches of the project repository',
  target: GITHUB_API,
  async run(ctx) {
    const { owner, repo } = await repoConfig(ctx);
    ctx.out.writeln((await ctx.services.github.branches(owner, repo, ctx.signal)).join('\n'));
  },
};

const workflows: CommandSpec = {
  name: 'workflows',
  summary: 'List the workflows GitHub knows for the repository',
  target: GITHUB_API,
  async run(ctx) {
    const { owner, repo } = await repoConfig(ctx);
    const list = await ctx.services.github.workflows(owner, repo, ctx.signal);
    ctx.out.table(list.map((w) => [w.path, w.name, w.state]), ['File', 'Name', 'State']);
  },
};

const prepare: CommandSpec = {
  name: 'prepare',
  summary: "Put Terminia's workflows on the repository's default branch (needed before the first build)",
  description: 'GitHub only starts workflows that exist on the default branch. This commits .github/workflows/terminia-*.yml and .terminia/ci/* there - nothing else - after showing you the files.',
  target: GITHUB_API,
  options: [YES],
  async run(ctx) {
    const { project, config, owner, repo } = await repoConfig(ctx);
    const installed = await installTemplates(ctx.services.vfs, project.path);
    if (installed.written.length) ctx.out.info(`Installed CI files in the project: ${installed.written.join(', ')}`);
    const info = await ctx.services.github.repo(owner, repo, ctx.signal);
    const gh = ctx.services.github.client();
    const plan = await planSync(gh, ctx.services.vfs, project.path, {
      owner,
      repo,
      branch: info.default_branch,
      projectPath: config.github.projectPath,
      include: (p) => p.startsWith('.github/workflows/terminia-') || p.startsWith('.terminia/ci/'),
      signal: ctx.signal,
    });
    if (!plan.changes.length && !plan.emptyRepository) {
      ctx.out.success(`${info.default_branch} already has the current Terminia workflows.`);
      return;
    }
    const lines = describePlan(plan);
    for (const l of lines) ctx.out.writeln(l);
    if (!(await confirm(ctx, { title: `Add workflows to ${info.default_branch}?`, message: `Commit Terminia's CI files to ${owner}/${repo} on the default branch ${info.default_branch}.`, details: lines, confirmLabel: 'Commit' }))) {
      ctx.out.warn('Nothing was changed.');
      return 1;
    }
    const result = await executeSync(gh, ctx.services.vfs, project.path, plan, { message: 'Add Terminia build workflows', signal: ctx.signal });
    ctx.out.success(`Committed ${result.commitSha.slice(0, 7)} to ${info.default_branch}: ${result.commitUrl}`);
    return 0;
  },
};

export const githubGroup: CommandSpec = {
  name: 'github',
  aliases: ['gh'],
  summary: 'GitHub connection and build repository',
  target: LOCAL,
  subcommands: [login, logout, status, repos, use, branches, workflows, prepare],
};

// ------------------------------------------------------------------ git

const gitStatus: CommandSpec = {
  name: 'status',
  summary: 'Compare the project with its GitHub branch (nothing is uploaded)',
  target: GITHUB_API,
  options: [{ name: 'branch', short: 'b', type: 'string', description: 'Branch (default: configured)' }],
  async run(ctx) {
    const { project, config, owner, repo } = await repoConfig(ctx);
    const plan = await planSync(ctx.services.github.client(), ctx.services.vfs, project.path, {
      owner,
      repo,
      branch: str(ctx.args, 'branch') ?? config.github.branch,
      projectPath: config.github.projectPath,
      deleteRemoved: config.github.deleteRemoved,
      signal: ctx.signal,
    });
    for (const line of describePlan(plan)) ctx.out.writeln(line);
    if (!plan.changes.length) ctx.out.success('Up to date.');
  },
};

const gitDiff: CommandSpec = {
  name: 'diff',
  summary: 'Show line changes between local files and the GitHub branch',
  target: GITHUB_API,
  options: [{ name: 'branch', short: 'b', type: 'string', description: 'Branch (default: configured)' }],
  positionals: [{ name: 'path', description: 'Files (default: all changed text files)', variadic: true, complete: 'file' }],
  async run(ctx) {
    const { project, config, owner, repo } = await repoConfig(ctx);
    const gh = ctx.services.github.client();
    const plan = await planSync(gh, ctx.services.vfs, project.path, {
      owner,
      repo,
      branch: str(ctx.args, 'branch') ?? config.github.branch,
      projectPath: config.github.projectPath,
      deleteRemoved: true,
      signal: ctx.signal,
    });
    const wanted = ctx.args.positionals.map((p) => ctx.services.projects.relativeToProject(abs(ctx, p)) ?? p);
    const changes = plan.changes.filter((c) => !wanted.length || wanted.includes(c.localPath) || wanted.includes(c.repoPath));
    if (!changes.length) {
      ctx.out.success('No differences.');
      return;
    }
    const tree = plan.baseTreeSha ? await gh.get(`/repos/${owner}/${repo}/git/trees/${plan.baseTreeSha}`, gitTreeSchema, { query: { recursive: 1 }, signal: ctx.signal }) : null;
    for (const change of changes) {
      const remoteSha = tree?.tree.find((e) => e.path === change.repoPath)?.sha;
      let oldText = '';
      if (remoteSha) {
        const blob = await gh.get(`/repos/${owner}/${repo}/git/blobs/${remoteSha}`, blobSchema, { signal: ctx.signal });
        oldText = fromUtf8(base64ToBytes(blob.content));
      }
      const newText = change.status === 'deleted' ? '' : (await ctx.services.vfs.readText(joinPath(project.path, change.localPath))).text;
      if (/\0/.test(oldText) || /\0/.test(newText)) {
        ctx.out.writeln(`Binary file ${change.repoPath} differs`);
        continue;
      }
      try {
        const diff = unifiedDiff(oldText, newText, `a/${change.repoPath}`, change.status === 'deleted' ? '/dev/null' : `b/${change.repoPath}`);
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) ctx.out.success(line);
          else if (line.startsWith('-') && !line.startsWith('---')) ctx.out.error(line);
          else if (line.startsWith('@@')) ctx.out.info(line);
          else ctx.out.writeln(line);
        }
      } catch (error) {
        ctx.out.warn(`${change.repoPath}: ${(error as Error).message}`);
      }
    }
  },
};

const gitSync: CommandSpec = {
  name: 'sync',
  aliases: ['push'],
  summary: 'Commit the project to its GitHub branch (preview, secret check and confirmation first)',
  target: GITHUB_API,
  options: [
    { name: 'message', short: 'm', type: 'string', description: 'Commit message' },
    { name: 'branch', short: 'b', type: 'string', description: 'Branch (default: configured; created if missing)' },
    { name: 'delete', type: 'boolean', description: 'Also delete files on GitHub that are not in the project' },
    YES,
  ],
  async run(ctx) {
    const { project, config, owner, repo } = await repoConfig(ctx);
    const gh = ctx.services.github.client();
    const plan = await planSync(gh, ctx.services.vfs, project.path, {
      owner,
      repo,
      branch: str(ctx.args, 'branch') ?? config.github.branch,
      projectPath: config.github.projectPath,
      deleteRemoved: bool(ctx.args, 'delete') || config.github.deleteRemoved,
      signal: ctx.signal,
    });
    const lines = describePlan(plan);
    for (const l of lines) ctx.out.writeln(l);
    if (!plan.changes.length && !plan.createsBranch) {
      ctx.out.success('Nothing to sync.');
      return;
    }
    if (!(await confirm(ctx, { title: `Commit to ${owner}/${repo}?`, message: `Upload ${plan.changes.length} change(s) to ${plan.branch}.`, details: lines, confirmLabel: 'Commit' }))) {
      ctx.out.warn('Nothing was uploaded.');
      return 1;
    }
    const result = await executeSync(gh, ctx.services.vfs, project.path, plan, {
      message: str(ctx.args, 'message') ?? `Update ${project.name} from Terminia`,
      signal: ctx.signal,
      onProgress: (done, total) => (done === total || done % 10 === 0 ? ctx.out.muted(`Uploaded ${done}/${total}`) : undefined),
    });
    ctx.out.success(`Committed ${result.commitSha.slice(0, 7)} to ${result.branch}: ${result.commitUrl}`);
    return 0;
  },
};

const gitLog: CommandSpec = {
  name: 'log',
  summary: 'Recent commits on the GitHub branch',
  target: GITHUB_API,
  options: [{ name: 'limit', short: 'n', type: 'number', description: 'Number of commits (default 15)' }, { name: 'branch', short: 'b', type: 'string', description: 'Branch' }],
  async run(ctx) {
    const { config, owner, repo } = await repoConfig(ctx);
    const commits = await ctx.services.github.client().get(`/repos/${owner}/${repo}/commits`, commitListSchema, {
      query: { sha: str(ctx.args, 'branch') ?? (config.github.branch || undefined), per_page: Math.min(100, num(ctx.args, 'limit') ?? 15) },
      signal: ctx.signal,
    });
    for (const c of commits) ctx.out.writeln(`${c.sha.slice(0, 7)}  ${(c.commit.author?.date ?? '').slice(0, 10)}  ${c.commit.author?.name ?? ''}  ${c.commit.message.split('\n')[0]}`);
  },
};

export const gitGroup: CommandSpec = {
  name: 'git',
  summary: 'Repository sync through the GitHub API (status, diff, sync, log)',
  description: 'There is no git client on iPad. Terminia compares and commits files through the GitHub Git Data API, never force-pushes, and blocks detected secrets.',
  target: LOCAL,
  subcommands: [gitStatus, gitDiff, gitSync, gitLog],
};

// ------------------------------------------------------------------- ci

const ciInstall: CommandSpec = {
  name: 'install',
  summary: "Add Terminia's GitHub Actions workflows and CI scripts to the project",
  target: LOCAL,
  options: [{ name: 'force', short: 'f', type: 'boolean', description: 'Replace files you edited (and same-named files not from Terminia)' }],
  async run(ctx) {
    const project = ctx.services.projects.requireCurrent();
    const result = await installTemplates(ctx.services.vfs, project.path, { force: bool(ctx.args, 'force') });
    for (const p of result.written) ctx.out.success(`wrote ${p}`);
    for (const s of result.skipped) ctx.out.warn(`kept ${s.path} (${s.state === 'modified' ? 'edited locally' : 'not a Terminia file'}; --force replaces it)`);
    if (result.unchanged.length) ctx.out.muted(`${result.unchanged.length} file(s) already current.`);
    const gitignore = joinPath(project.path, '.gitignore');
    if (!(await ctx.services.vfs.exists(gitignore))) {
      await ctx.services.vfs.writeText(gitignore, GITIGNORE_TEMPLATE);
      ctx.out.success('wrote .gitignore (keeps build output and signing files out of the repository)');
    }
    ctx.out.info('Next: `terminia github prepare` puts the workflows on the default branch so GitHub can start them.');
  },
};

const ciStatus: CommandSpec = {
  name: 'status',
  summary: 'Compare the CI files in the project (and on GitHub) with this version of Terminia',
  target: (args) => (args.options.local ? LOCAL : GITHUB_API),
  options: [{ name: 'local', type: 'boolean', description: 'Only check the project, not GitHub' }],
  async run(ctx) {
    const project = ctx.services.projects.requireCurrent();
    const statuses = await templateStatus(ctx.services.vfs, project.path);
    let remote: Map<string, string | null> | null = null;
    const config = await ctx.services.projects.config(project);
    if (!bool(ctx.args, 'local') && config.github.owner && (await ctx.services.github.credential())) {
      const info = await ctx.services.github.repo(config.github.owner, config.github.repo, ctx.signal);
      remote = new Map();
      const prefix = config.github.projectPath.replace(/^\.\/?/, '').replace(/\/+$/, '');
      for (const t of TEMPLATE_FILES) {
        const sha = await ctx.services.github.fileSha(config.github.owner, config.github.repo, prefix ? `${prefix}/${t.path}` : t.path, info.default_branch, ctx.signal);
        remote.set(t.path, sha === null ? 'missing' : sha === (await gitBlobSha(utf8(t.content))) ? 'current' : 'different');
      }
    }
    ctx.out.table(
      statuses.map((s) => [s.path, s.state, `v${s.bundledVersion}`, ...(remote ? [remote.get(s.path) ?? '?'] : [])]),
      ['File', 'In project', 'Bundled', ...(remote ? ['On default branch'] : [])],
    );
  },
};

export const ciGroup: CommandSpec = {
  name: 'ci',
  summary: 'Install and check the GitHub Actions workflows Terminia uses',
  target: LOCAL,
  subcommands: [ciInstall, ciStatus],
};

