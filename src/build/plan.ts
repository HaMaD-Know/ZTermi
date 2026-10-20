import { TerminiaError } from '../core/errors';
import { shortId } from '../core/util';
import type { Vfs } from '../fs/vfs';
import type { GitHubService } from '../github/service';
import { WORKFLOW_FILES, templateStatus } from '../github/workflows';
import type { IosExportMethod, ProjectConfig, WebKind } from '../projects/config';
import type { Detection } from '../projects/detect';
import type { ProjectInfo, ProjectService } from '../projects/projects';
import type { BuildProvider } from './provider';
import type { BuildKind, BuildPlatform } from './types';

export interface BuildOverrides {
  configuration?: 'debug' | 'release';
  exportMethod?: IosExportMethod;
  scheme?: string;
  variant?: 'debug' | 'release';
  output?: 'apk' | 'aab' | 'both';
  module?: string;
  kind?: WebKind;
  command?: string;
  outputPath?: string;
  runner?: 'linux' | 'macos';
  profile?: string;
  branch?: string;
  sync?: 'commit' | 'none';
  deleteRemoved?: boolean;
}

export interface DepsJob {
  ecosystem: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'gradle' | 'cocoapods' | 'swiftpm';
  operation: 'install' | 'add' | 'remove' | 'update' | 'list';
  packages: string[];
  dev: boolean;
}

export interface BuildRequest {
  kind: BuildKind;
  platform: BuildPlatform;
  project?: ProjectInfo;
  overrides?: BuildOverrides;
  deps?: DepsJob;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export type SigningState = 'not-needed' | 'configured' | 'missing' | 'unknown';

export interface BuildPlan {
  id: string;
  kind: BuildKind;
  platform: BuildPlatform;
  project: ProjectInfo;
  config: ProjectConfig;
  detection: Detection;
  repo: { owner: string; repo: string };
  defaultBranch: string;
  branch: string;
  workflow: string;
  inputs: Record<string, string | boolean>;
  summary: string;
  sync: 'commit' | 'none';
  deleteRemoved: boolean;
  checks: PreflightCheck[];
  signing: SigningState;
  signingSecrets: string[];
  runner: 'macOS' | 'Linux';
  /** A project-defined command that will run on the CI runner (shown before starting). */
  command?: string;
}

export const IOS_SIGNING_SECRETS = ['IOS_CERTIFICATE_P12_BASE64', 'IOS_CERTIFICATE_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64'];
export const ANDROID_SIGNING_SECRETS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS'];

export interface WorkflowInputs {
  workflow: string;
  inputs: Record<string, string | boolean>;
  summary: string;
  signingSecrets: string[];
  runner: 'macOS' | 'Linux';
  command?: string;
}

function projectPathInput(config: ProjectConfig): string {
  const p = config.github.projectPath.replace(/^\.\/?/, '').replace(/\/+$/, '');
  return p || '.';
}

/** Translates project config + overrides into the exact inputs the workflow templates declare. */
export function workflowInputs(request: BuildRequest, config: ProjectConfig, buildId: string): WorkflowInputs {
  const o = request.overrides ?? {};
  const base = { terminia_build_id: buildId, project_path: projectPathInput(config) };
  if (request.kind === 'deps') {
    const deps = request.deps;
    if (!deps) throw new TerminiaError('INTERNAL', 'Dependency job without parameters.');
    return {
      workflow: config.deps.workflow,
      inputs: { ...base, ecosystem: deps.ecosystem, operation: deps.operation, packages: deps.packages.join(' '), dev: deps.dev },
      summary: `${deps.operation} ${deps.ecosystem}${deps.packages.length ? ` ${deps.packages.join(' ')}` : ''}`,
      signingSecrets: [],
      runner: deps.ecosystem === 'cocoapods' || deps.ecosystem === 'swiftpm' ? 'macOS' : 'Linux',
    };
  }
  switch (request.platform) {
    case 'ios': {
      const configuration = o.configuration ?? config.ios.configuration;
      const exportMethod = o.exportMethod ?? config.ios.exportMethod;
      return {
        workflow: config.ios.workflow,
        inputs: {
          ...base,
          configuration,
          export_method: exportMethod,
          scheme: o.scheme ?? config.ios.scheme,
          xcode_version: config.ios.xcodeVersion,
          generate_native: config.ios.generateNative,
        },
        summary: `${configuration} · ${exportMethod}`,
        signingSecrets: exportMethod === 'unsigned' ? [] : IOS_SIGNING_SECRETS,
        runner: 'macOS',
      };
    }
    case 'android': {
      const variant = o.variant ?? config.android.variant;
      const output = o.output ?? config.android.output;
      return {
        workflow: config.android.workflow,
        inputs: {
          ...base,
          variant,
          output,
          module: o.module ?? config.android.module,
          java_version: config.android.javaVersion,
          generate_native: config.android.generateNative,
        },
        summary: `${variant} · ${output}`,
        signingSecrets: variant === 'release' ? ANDROID_SIGNING_SECRETS : [],
        runner: 'Linux',
      };
    }
    case 'web': {
      const profile = o.profile ? config.profiles.find((p) => p.name.toLowerCase() === o.profile!.toLowerCase()) : undefined;
      if (o.profile && !profile) {
        throw new TerminiaError('NOT_FOUND', `No build profile named '${o.profile}'.`, { hint: 'Profiles are defined in .terminia/config.json under "profiles".' });
      }
      const kind = o.kind ?? profile?.target ?? config.web.kind;
      const command = o.command ?? profile?.command ?? config.web.command;
      const output = o.outputPath ?? profile?.output ?? (kind === 'python' ? '' : config.web.output);
      const runner = o.runner ?? profile?.runner ?? 'linux';
      return {
        workflow: config.web.workflow,
        inputs: {
          ...base,
          kind,
          command,
          output_path: output,
          runner,
          node_version: config.web.nodeVersion,
          python_version: config.web.pythonVersion,
          env_json: JSON.stringify(profile?.env ?? {}),
        },
        summary: profile ? `profile ${profile.name}` : kind,
        signingSecrets: [],
        runner: runner === 'macos' ? 'macOS' : 'Linux',
        command: command || undefined,
      };
    }
  }
}

export interface PlanContext {
  vfs: Vfs;
  projects: ProjectService;
  github: GitHubService;
  provider: BuildProvider;
}

/**
 * Builds a plan and runs the preflight checks. Network checks use read-only
 * GitHub calls; nothing is changed until BuildManager.start().
 */
export async function prepareBuild(ctx: PlanContext, request: BuildRequest, signal?: AbortSignal): Promise<BuildPlan> {
  const project = request.project ?? ctx.projects.requireCurrent();
  const config = await ctx.projects.config(project);
  const detection = await ctx.projects.detect(project);
  const id = shortId();
  const mapped = workflowInputs(request, config, id);
  const checks: PreflightCheck[] = [];
  const add = (check: PreflightCheck) => checks.push(check);

  // Project type
  if (request.kind === 'build') {
    const assessment = detection.targets.find((t) => t.platform === request.platform);
    if (request.platform === 'web' && (request.overrides?.kind === 'custom' || request.overrides?.profile || config.web.kind === 'custom')) {
      add({ id: 'project', label: 'Project type', status: 'ok', detail: 'Custom build profile.' });
    } else if (assessment) {
      add({
        id: 'project',
        label: 'Project type',
        status: assessment.viable ? 'ok' : 'fail',
        detail: [assessment.reason, ...assessment.notes].join(' '),
        fix: assessment.viable ? undefined : request.platform === 'web' ? 'Add a build script or a custom profile.' : `This project cannot produce a${request.platform === 'ios' ? 'n iOS' : 'n Android'} build.`,
      });
    }
    if (!detection.hasLockfile && detection.packageManager) {
      add({ id: 'lockfile', label: 'Lockfile', status: 'warn', detail: 'No lockfile: the builder resolves dependency versions freshly each time.', fix: 'terminia deps install' });
    }
  }

  // GitHub connection
  const credential = await ctx.github.credential();
  const repoConfigured = !!(config.github.owner && config.github.repo);
  if (!credential) {
    add({ id: 'github', label: 'GitHub', status: 'fail', detail: 'Not connected.', fix: 'terminia github login' });
  }
  if (!repoConfigured) {
    add({ id: 'repo', label: 'Repository', status: 'fail', detail: 'No build repository is set for this project.', fix: 'terminia github use <owner>/<repo>' });
  }

  let defaultBranch = config.github.branch || 'main';
  let branch = request.overrides?.branch || config.github.branch || defaultBranch;
  const sync = request.overrides?.sync ?? config.github.sync;
  if (credential && repoConfigured) {
    try {
      const repo = await ctx.github.repo(config.github.owner, config.github.repo, signal);
      defaultBranch = repo.default_branch;
      branch = request.overrides?.branch || config.github.branch || repo.default_branch;
      const canPush = repo.permissions?.push ?? true;
      add({
        id: 'repo',
        label: 'Repository',
        status: sync === 'commit' && !canPush ? 'fail' : 'ok',
        detail: `${repo.full_name} (${repo.private ? 'private' : 'public'}), building branch ${branch}.`,
        fix: sync === 'commit' && !canPush ? 'You need write access to sync, or use --sync none.' : undefined,
      });
      const workflow = await ctx.provider.findWorkflow(config.github.owner, config.github.repo, mapped.workflow, signal);
      if (workflow && workflow.state !== 'active') {
        add({ id: 'workflow', label: 'Workflow', status: 'fail', detail: `${mapped.workflow} is ${workflow.state} on GitHub.`, fix: 'Enable it in the repository\'s Actions tab.' });
      } else if (workflow) {
        add({ id: 'workflow', label: 'Workflow', status: 'ok', detail: `${mapped.workflow} is registered on GitHub.` });
      } else if (sync === 'commit' && branch === defaultBranch) {
        add({ id: 'workflow', label: 'Workflow', status: 'warn', detail: `${mapped.workflow} is not on GitHub yet; the sync will add it to ${branch}.` });
      } else {
        add({
          id: 'workflow',
          label: 'Workflow',
          status: 'fail',
          detail: `${mapped.workflow} is not on the default branch (${defaultBranch}), so GitHub cannot start it.`,
          fix: 'terminia github prepare',
        });
      }
      if (mapped.signingSecrets.length) {
        const names = await ctx.github.secretNames(config.github.owner, config.github.repo, signal);
        if (!names) {
          add({ id: 'signing', label: 'Signing', status: 'unknown', detail: 'Your token cannot list Actions secrets; the workflow checks them and stops with a clear error if any is missing.' });
        } else {
          const missing = mapped.signingSecrets.filter((s) => !names.has(s));
          add({
            id: 'signing',
            label: 'Signing',
            status: missing.length ? 'fail' : 'ok',
            detail: missing.length ? `Missing repository secrets: ${missing.join(', ')}.` : 'Signing secrets are configured.',
            fix: missing.length ? 'See docs/SIGNING.md, or build unsigned/debug.' : undefined,
          });
        }
      }
    } catch (error) {
      const e = error instanceof TerminiaError ? error : new TerminiaError('NETWORK', String(error));
      add({ id: 'repo', label: 'Repository', status: 'fail', detail: e.message, fix: e.hint });
    }
  }

  // Local CI templates (only matter when the project is synced from the iPad)
  if (sync === 'commit') {
    const statuses = await templateStatus(ctx.vfs, project.path);
    const workflowPath = `.github/workflows/${mapped.workflow}`;
    const own = statuses.find((s) => s.path === workflowPath);
    const scripts = statuses.filter((s) => s.path.startsWith('.terminia/ci/'));
    const isTemplate = (Object.values(WORKFLOW_FILES) as string[]).includes(mapped.workflow);
    if (isTemplate && (!own || own.state === 'missing' || scripts.some((s) => s.state === 'missing'))) {
      add({ id: 'templates', label: 'CI files', status: 'fail', detail: 'Terminia\'s workflow and CI scripts are not in this project.', fix: 'terminia ci install' });
    } else if (isTemplate && [own, ...scripts].some((s) => s?.state === 'outdated')) {
      add({ id: 'templates', label: 'CI files', status: 'warn', detail: 'Some CI files are older than this version of Terminia.', fix: 'terminia ci install' });
    } else if (isTemplate) {
      add({ id: 'templates', label: 'CI files', status: 'ok', detail: own?.state === 'modified' ? 'Installed (edited locally).' : 'Installed.' });
    }
  }

  if (mapped.command) {
    add({ id: 'command', label: 'Build command', status: 'warn', detail: `Runs on the ${mapped.runner} runner: ${mapped.command}` });
  }

  const signingCheck = checks.find((c) => c.id === 'signing');
  const signing: SigningState = !mapped.signingSecrets.length
    ? 'not-needed'
    : signingCheck?.status === 'ok'
      ? 'configured'
      : signingCheck?.status === 'fail'
        ? 'missing'
        : 'unknown';

  return {
    id,
    kind: request.kind,
    platform: request.platform,
    project,
    config,
    detection,
    repo: { owner: config.github.owner, repo: config.github.repo },
    defaultBranch,
    branch,
    workflow: mapped.workflow,
    inputs: mapped.inputs,
    summary: mapped.summary,
    sync,
    deleteRemoved: request.overrides?.deleteRemoved ?? config.github.deleteRemoved,
    checks,
    signing,
    signingSecrets: mapped.signingSecrets,
    runner: mapped.runner,
    command: mapped.command,
  };
}

/** Failing checks, except signing (which turns into the "waiting for signing" state instead). */
export function blockingChecks(plan: BuildPlan): PreflightCheck[] {
  return plan.checks.filter((c) => c.status === 'fail' && c.id !== 'signing');
}
