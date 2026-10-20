import { TerminiaError, isAbortError, sleep as defaultSleep, toTerminiaError } from '../core/errors';
import { v } from '../core/validate';
import { Emitter } from '../core/util';
import type { Vfs } from '../fs/vfs';
import { encodePath } from '../github/client';
import { gitRefSchema } from '../github/schemas';
import { GITHUB_CREDENTIAL, type GitHubService } from '../github/service';
import { describePlan, executeSync, planSync, type SyncPlan, type SyncResult } from '../github/sync';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import type { ProjectService } from '../projects/projects';
import type { SettingsService } from '../settings/settings';
import { blockingChecks, prepareBuild, type BuildPlan, type BuildRequest } from './plan';
import { GitHubActionsProvider, type BuildProvider, type ProviderRun } from './provider';
import { canTransition, fromGitHubRun, isActive, isTerminal } from './state';
import { runRef, type Annotation, type ArtifactInfo, type BuildPlatform, type BuildRecord, type BuildStatus, type JobInfo } from './types';

export interface StartHooks {
  /** Shows the sync preview; resolve true to upload. */
  confirmSync(plan: SyncPlan, lines: string[]): Promise<boolean>;
  /** Shows a project-defined build command that will run on the runner. */
  confirmCommand?(command: string, runner: string): Promise<boolean>;
  progress?(message: string): void;
}

export interface JobLog {
  job: JobInfo;
  log?: string;
  /** Why the full log is not available yet. */
  pending?: string;
}

const MAX_HISTORY = 150;

export interface BuildManagerDeps {
  platform: Platform;
  vfs: Vfs;
  projects: ProjectService;
  github: GitHubService;
  settings: SettingsService;
  provider?: BuildProvider;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export class BuildManager extends Emitter<{ update: BuildRecord; history: undefined }> {
  private records: BuildRecord[] = [];
  private readonly doc: JsonDocument<BuildRecord[]>;
  private readonly trackers = new Map<string, AbortController>();
  private readonly logCache = new Map<string, string>();
  private readonly providerImpl: BuildProvider;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: BuildManagerDeps) {
    super();
    this.providerImpl = deps.provider ?? new GitHubActionsProvider(deps.github.client(), deps.platform.http, GITHUB_CREDENTIAL);
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    // Records are produced by this class; the validator only guards against corrupt storage.
    this.doc = new JsonDocument(
      deps.platform.kv,
      'terminia.builds',
      v.array((value, path) => {
        const r = value as BuildRecord;
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.status !== 'string') {
          throw new TerminiaError('VALIDATION', `bad build record at ${path}`);
        }
        return { ...r, jobs: r.jobs ?? [], artifacts: r.artifacts ?? [], annotations: r.annotations ?? [] };
      }),
      () => [],
    );
  }

  provider(): BuildProvider {
    return this.providerImpl;
  }

  async init(): Promise<void> {
    this.records = await this.doc.load();
    for (const record of this.records) {
      if (record.runId && isActive(record.status)) this.track(record.id);
      // A sync or dispatch interrupted by the app closing never reached GitHub's run list.
      if (!record.runId && (record.status === 'syncing' || record.status === 'dispatching')) {
        this.patch(record, { status: 'failed', error: { code: 'INTERRUPTED', message: 'Terminia was closed before the build started.' } });
      }
    }
  }

  async history(): Promise<BuildRecord[]> {
    return [...this.records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Finds a record by id or unique id prefix. */
  get(id: string): BuildRecord | undefined {
    const exact = this.records.find((r) => r.id === id);
    if (exact) return exact;
    const matches = this.records.filter((r) => r.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  latest(platform?: BuildPlatform, kind: BuildRecord['kind'] = 'build'): BuildRecord | undefined {
    return [...this.records].filter((r) => r.kind === kind && (!platform || r.platform === platform)).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  require(id: string | undefined, platform?: BuildPlatform, kind: BuildRecord['kind'] = 'build'): BuildRecord {
    const record = id ? this.get(id) : this.latest(platform, kind);
    if (!record) {
      throw new TerminiaError('NOT_FOUND', id ? `No build '${id}'.` : `No ${platform ?? ''} build has been started from Terminia yet.`.replace('  ', ' '), {
        hint: id ? 'List builds with `terminia ios history` or `terminia android history`.' : undefined,
      });
    }
    return record;
  }

  async prepare(request: BuildRequest, signal?: AbortSignal): Promise<BuildPlan> {
    return prepareBuild({ vfs: this.deps.vfs, projects: this.deps.projects, github: this.deps.github, provider: this.providerImpl }, request, signal);
  }

  private save(): void {
    this.records.sort((a, b) => b.createdAt - a.createdAt);
    if (this.records.length > MAX_HISTORY) this.records.length = MAX_HISTORY;
    void this.doc.save(this.records).catch((error) => console.warn('Could not save build history:', error));
    this.emit('history', undefined);
  }

  private patch(record: BuildRecord, changes: Partial<BuildRecord>): BuildRecord {
    if (changes.status && !canTransition(record.status, changes.status)) {
      delete changes.status;
    }
    Object.assign(record, changes, { updatedAt: this.now() });
    if (changes.status && isTerminal(changes.status) && !record.completedAt) record.completedAt = this.now();
    this.save();
    this.emit('update', record);
    return record;
  }

  /**
   * Starts a planned build: optional sync (after confirmation), dispatch,
   * run correlation, then background tracking. Resolves once GitHub has
   * accepted the run (or with the waiting_for_signing / failed record).
   */
  async start(plan: BuildPlan, hooks: StartHooks, signal?: AbortSignal): Promise<BuildRecord> {
    const blockers = blockingChecks(plan);
    if (blockers.length) {
      throw new TerminiaError('CONFIG_REQUIRED', `Cannot start the build:\n${blockers.map((b) => `  - ${b.label}: ${b.detail}${b.fix ? ` → ${b.fix}` : ''}`).join('\n')}`);
    }
    const record: BuildRecord = {
      id: plan.id,
      kind: plan.kind,
      platform: plan.platform,
      project: { name: plan.project.name, path: plan.project.path },
      repo: plan.repo,
      branch: plan.branch,
      workflow: plan.workflow,
      inputs: plan.inputs,
      summary: plan.summary,
      provider: 'github-actions',
      status: 'ready',
      createdAt: this.now(),
      updatedAt: this.now(),
      jobs: [],
      artifacts: [],
      annotations: [],
    };

    if (plan.signing === 'missing') {
      this.records.push(record);
      const alternative = plan.platform === 'ios' ? 'an unsigned IPA (--export unsigned)' : 'a debug APK (--variant debug)';
      return this.patch(record, {
        status: 'waiting_for_signing',
        error: {
          code: 'CONFIG_REQUIRED',
          message: `Missing signing secrets: ${plan.signingSecrets.join(', ')}.`,
          hint: `Add them in the repository on GitHub (Settings › Secrets and variables › Actions) - see docs/SIGNING.md - then build again. You can still build ${alternative}.`,
        },
      });
    }

    if (plan.command && hooks.confirmCommand && !(await hooks.confirmCommand(plan.command, plan.runner))) {
      throw new TerminiaError('CANCELLED', 'Build cancelled.');
    }

    this.records.push(record);
    this.save();
    const gh = this.deps.github.client();
    try {
      if (plan.sync === 'commit') {
        this.patch(record, { status: 'syncing' });
        hooks.progress?.(`Comparing the project with ${plan.repo.owner}/${plan.repo.repo}@${plan.branch}…`);
        const syncPlan = await planSync(gh, this.deps.vfs, plan.project.path, {
          owner: plan.repo.owner,
          repo: plan.repo.repo,
          branch: plan.branch,
          projectPath: plan.config.github.projectPath,
          deleteRemoved: plan.deleteRemoved,
          signal,
        });
        let result: SyncResult;
        if (syncPlan.changes.length || syncPlan.createsBranch || syncPlan.emptyRepository) {
          if (!(await hooks.confirmSync(syncPlan, describePlan(syncPlan)))) {
            return this.patch(record, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Sync not confirmed; nothing was uploaded.' } });
          }
          result = await executeSync(gh, this.deps.vfs, plan.project.path, syncPlan, {
            message: `Terminia: ${plan.kind === 'deps' ? 'dependencies' : `${plan.platform} build`} ${plan.id}`,
            signal,
            onProgress: (done, total) => hooks.progress?.(`Uploading ${done}/${total} file(s)…`),
          });
          hooks.progress?.(`Committed ${result.commitSha.slice(0, 7)} to ${result.branch} (${result.uploaded} uploaded, ${result.deleted} deleted).`);
        } else {
          result = { commitSha: syncPlan.headSha!, branch: syncPlan.branch, uploaded: 0, deleted: 0, noChanges: true, commitUrl: '' };
          hooks.progress?.(`${syncPlan.branch} already matches the project (${syncPlan.unchanged} files).`);
        }
        this.patch(record, { commitSha: result.commitSha });
      } else {
        const ref = await gh.get(`/repos/${plan.repo.owner}/${plan.repo.repo}/git/ref/heads/${encodePath(plan.branch)}`, gitRefSchema, { signal });
        this.patch(record, { commitSha: ref.object.sha });
      }

      this.patch(record, { status: 'dispatching' });
      hooks.progress?.(`Starting ${plan.workflow} on ${plan.branch}…`);
      const request = { owner: plan.repo.owner, repo: plan.repo.repo, workflow: plan.workflow, ref: plan.branch, inputs: plan.inputs, buildId: plan.id };
      const since = this.now();
      const dispatched = await this.providerImpl.dispatch(request, signal);
      // From here on the run exists on GitHub: finding it must not be cut short by the
      // caller giving up, or the record would say "cancelled" while the build runs.
      let run: ProviderRun | null = dispatched.runId ? await this.providerImpl.getRun({ owner: plan.repo.owner, repo: plan.repo.repo, runId: dispatched.runId }) : null;
      for (let i = 0; !run && i < 20; i++) {
        await this.sleep(3000);
        run = await this.providerImpl.findRun({ ...request, since });
      }
      if (!run) {
        return this.patch(record, {
          status: 'failed',
          error: {
            code: 'PROVIDER',
            message: 'GitHub accepted the dispatch but the run did not appear within a minute.',
            hint: 'Check the repository\'s Actions tab. If the workflow was edited, its run-name must still include the build id (`terminia ci status`).',
          },
        });
      }
      this.applyRun(record, run);
      this.track(record.id);
      return record;
    } catch (error) {
      if (isAbortError(error) || (error instanceof TerminiaError && error.code === 'CANCELLED')) {
        this.patch(record, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled before the build started.' } });
        throw error;
      }
      const e = toTerminiaError(error);
      this.patch(record, { status: 'failed', error: { code: e.code, message: e.message, hint: e.hint } });
      throw e;
    }
  }

  private runChanges(record: BuildRecord, run: ProviderRun): Partial<BuildRecord> {
    const state = fromGitHubRun(run.status, run.conclusion);
    return {
      runId: run.id,
      runNumber: run.number,
      runAttempt: run.attempt,
      runUrl: run.url,
      status: state.status,
      statusDetail: state.detail,
      conclusion: run.conclusion ?? undefined,
      commitSha: record.commitSha ?? run.headSha,
      startedAt: run.startedAt ? Date.parse(run.startedAt) : record.startedAt,
    };
  }

  private applyRun(record: BuildRecord, run: ProviderRun): void {
    this.patch(record, this.runChanges(record, run));
  }

  /** Background polling until the run finishes. Survives view changes; resumed on app start. */
  track(id: string): void {
    if (this.trackers.has(id)) return;
    const controller = new AbortController();
    this.trackers.set(id, controller);
    void (async () => {
      let failures = 0;
      try {
        for (;;) {
          const record = this.get(id);
          if (!record || isTerminal(record.status)) break;
          const interval = this.deps.settings.get().pollIntervalSeconds * 1000;
          try {
            await this.refresh(id, controller.signal);
            failures = 0;
          } catch (error) {
            if (controller.signal.aborted) break;
            failures++;
            const e = toTerminiaError(error);
            if (e.code === 'AUTH_FAILED' || e.code === 'AUTH_REQUIRED') {
              this.patch(record, { statusDetail: 'paused: GitHub is not connected' });
              break;
            }
            this.patch(record, { statusDetail: `connection problem, retrying (${e.message})` });
          }
          const current = this.get(id);
          if (!current || isTerminal(current.status)) break;
          const backoff = Math.min(60_000, interval * 2 ** Math.min(failures, 4));
          await this.sleep(current.status === 'queued' ? Math.max(backoff, 5000) : backoff, controller.signal);
        }
      } catch (error) {
        if (!isAbortError(error)) console.warn('Build tracking stopped:', error);
      } finally {
        this.trackers.delete(id);
      }
    })();
  }

  stopTracking(): void {
    for (const controller of this.trackers.values()) controller.abort();
    this.trackers.clear();
  }

  /**
   * Reads the run and its jobs and - once finished - annotations, result and
   * artifacts. The terminal status is published together with the results, so
   * whoever waits for the build never sees "succeeded" without its artifacts.
   */
  async refresh(id: string, signal?: AbortSignal): Promise<BuildRecord> {
    const record = this.require(id);
    const ref = runRef(record);
    if (!ref) return record;
    const run = await this.providerImpl.getRun(ref, signal);
    const jobs = await this.providerImpl.listJobs(ref, signal);
    const changes: Partial<BuildRecord> = { ...this.runChanges(record, run), jobs };
    const status = changes.status!;
    if (isTerminal(status) && (!isTerminal(record.status) || !record.artifacts.length)) {
      Object.assign(changes, await this.collectResults(record, jobs, status, signal));
    }
    return this.patch(record, changes);
  }

  private async collectResults(record: BuildRecord, jobs: JobInfo[], status: BuildStatus, signal?: AbortSignal): Promise<Partial<BuildRecord>> {
    const ref = runRef(record);
    if (!ref) return {};
    const annotations: Annotation[] = [];
    for (const job of jobs) {
      try {
        annotations.push(...(await this.providerImpl.annotations(ref, job.id, signal)));
      } catch {
        // Annotations are best effort; logs remain available.
      }
    }
    let result: Record<string, unknown> | undefined;
    const notice = annotations.find((a) => a.title === 'terminia-result');
    if (notice) {
      try {
        result = JSON.parse(notice.message) as Record<string, unknown>;
      } catch {
        result = undefined;
      }
    }
    let artifacts: ArtifactInfo[];
    try {
      artifacts = await this.providerImpl.listArtifacts(ref, signal);
    } catch {
      artifacts = record.artifacts;
    }
    const failure = annotations.find((a) => a.level === 'failure' && a.title !== 'terminia-result');
    const changes: Partial<BuildRecord> = { annotations: annotations.filter((a) => a.title !== 'terminia-result'), artifacts, result };
    if (status === 'failed' && failure && !record.error) {
      changes.error = { code: 'BUILD_FAILED', message: failure.title ? `${failure.title}: ${failure.message}` : failure.message };
    }
    if (status === 'succeeded' && record.kind === 'build' && !artifacts.some((a) => !/-logs(-d+)?$/.test(a.name))) {
      changes.error = { code: 'NO_ARTIFACT', message: 'The run succeeded but uploaded no build artifact.' };
    }
    return changes;
  }

  async cancel(id: string): Promise<BuildRecord> {
    const record = this.require(id);
    if (isTerminal(record.status)) throw new TerminiaError('CONFLICT', `Build ${record.id} has already finished (${record.status}).`);
    const ref = runRef(record);
    if (!ref) throw new TerminiaError('CONFLICT', 'The build has not reached GitHub yet; cancel the running command instead (Ctrl+C).');
    await this.providerImpl.cancel(ref);
    this.patch(record, { cancelRequested: true, statusDetail: 'cancellation requested' });
    this.track(record.id);
    return record;
  }

  async artifacts(id: string, signal?: AbortSignal): Promise<ArtifactInfo[]> {
    const record = this.require(id);
    const ref = runRef(record);
    if (!ref) return [];
    const artifacts = await this.providerImpl.listArtifacts(ref, signal);
    this.patch(record, { artifacts });
    return artifacts;
  }

  /** Job logs: full text for finished jobs, live step status for running ones. */
  async logs(id: string, options: { job?: string; signal?: AbortSignal } = {}): Promise<JobLog[]> {
    const record = this.require(id);
    const ref = runRef(record);
    if (!ref) return [];
    if (!isTerminal(record.status)) await this.refresh(id, options.signal);
    const jobs = record.jobs.filter((j) => !options.job || j.name.toLowerCase().includes(options.job.toLowerCase()));
    const out: JobLog[] = [];
    for (const job of jobs) {
      if (job.status !== 'completed') {
        out.push({ job, pending: 'GitHub publishes the full log when the job finishes; live step status is shown instead.' });
        continue;
      }
      const key = `${record.runId}:${job.id}`;
      let log = this.logCache.get(key);
      if (log === undefined) {
        try {
          log = await this.providerImpl.jobLog(ref, job.id, options.signal);
          this.logCache.set(key, log);
        } catch (error) {
          const e = toTerminiaError(error);
          out.push({ job, pending: `Log unavailable: ${e.message}` });
          continue;
        }
      }
      out.push({ job, log });
    }
    return out;
  }

  /** Resolves when the build reaches a terminal state, calling onUpdate on every change. */
  waitFor(id: string, onUpdate: (record: BuildRecord) => void, signal?: AbortSignal): Promise<BuildRecord> {
    const record = this.require(id);
    if (isTerminal(record.status)) return Promise.resolve(record);
    this.track(id);
    return new Promise((resolve, reject) => {
      const off = this.on('update', (r) => {
        if (r.id !== record.id) return;
        onUpdate(r);
        if (isTerminal(r.status)) {
          off();
          resolve(r);
        }
      });
      signal?.addEventListener(
        'abort',
        () => {
          off();
          reject(new TerminiaError('CANCELLED', 'Stopped following.'));
        },
        { once: true },
      );
    });
  }

  /** Runs of a workflow on GitHub, including ones not started from this iPad. */
  async remoteRuns(owner: string, repo: string, workflow: string, signal?: AbortSignal): Promise<ProviderRun[]> {
    return this.providerImpl.listRuns(owner, repo, workflow, { perPage: 20, signal });
  }

  statusOf(id: string): BuildStatus | undefined {
    return this.get(id)?.status;
  }
}
