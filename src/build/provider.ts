import { TerminiaError, sleep as defaultSleep } from '../core/errors';
import { redact } from '../core/redact';
import type { GitHubClient } from '../github/client';
import {
  annotationListSchema,
  artifactListSchema,
  dispatchResultSchema,
  jobListSchema,
  runListSchema,
  runSchema,
  workflowSchema,
  type GitHubArtifact,
  type GitHubJob,
  type GitHubRun,
  type GitHubWorkflow,
} from '../github/schemas';
import type { DownloadResult, HttpClient } from '../net/http';
import type { RootId } from '../platform/plugins';
import type { Annotation, ArtifactInfo, JobInfo, RunRef } from './types';

/**
 * Provider-independent cloud build operations. GitHub Actions is the first
 * implementation; another CI service can be added by implementing this
 * interface, without touching the UI or commands.
 */
export interface DispatchRequest {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  inputs: Record<string, string | boolean>;
  buildId: string;
}

export interface ProviderRun {
  id: number;
  number: number;
  attempt: number;
  url: string;
  status: string | null;
  conclusion: string | null;
  headSha: string;
  branch: string | null;
  title: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  event: string;
}

export interface BuildProvider {
  readonly id: string;
  readonly label: string;
  findWorkflow(owner: string, repo: string, workflow: string, signal?: AbortSignal): Promise<GitHubWorkflow | null>;
  dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<{ runId?: number }>;
  findRun(request: DispatchRequest & { since: number }, signal?: AbortSignal): Promise<ProviderRun | null>;
  getRun(ref: RunRef, signal?: AbortSignal): Promise<ProviderRun>;
  listRuns(owner: string, repo: string, workflow: string, options?: { perPage?: number; signal?: AbortSignal }): Promise<ProviderRun[]>;
  listJobs(ref: RunRef, signal?: AbortSignal): Promise<JobInfo[]>;
  jobLog(ref: RunRef, jobId: number, signal?: AbortSignal): Promise<string>;
  annotations(ref: RunRef, jobId: number, signal?: AbortSignal): Promise<Annotation[]>;
  cancel(ref: RunRef, signal?: AbortSignal): Promise<void>;
  listArtifacts(ref: RunRef, signal?: AbortSignal): Promise<ArtifactInfo[]>;
  downloadArtifact(
    ref: RunRef,
    artifact: ArtifactInfo,
    destination: { root: RootId; path: string },
    options: { onProgress?: (received: number, total: number) => void; signal?: AbortSignal; maxBytes?: number },
  ): Promise<DownloadResult>;
}

function toRun(run: GitHubRun): ProviderRun {
  return {
    id: run.id,
    number: run.run_number,
    attempt: run.run_attempt,
    url: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    branch: run.head_branch,
    title: run.display_title || run.name || '',
    createdAt: run.created_at,
    startedAt: run.run_started_at,
    updatedAt: run.updated_at,
    event: run.event,
  };
}

function toJob(job: GitHubJob): JobInfo {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
    runnerName: job.runner_name,
    steps: job.steps.map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      startedAt: s.started_at,
      completedAt: s.completed_at,
    })),
  };
}

function toArtifact(a: GitHubArtifact): ArtifactInfo {
  return {
    id: a.id,
    name: a.name,
    sizeBytes: a.size_in_bytes,
    expired: a.expired,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
    digest: a.digest ?? null,
  };
}

export class GitHubActionsProvider implements BuildProvider {
  readonly id = 'github-actions';
  readonly label = 'GitHub Actions';
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly gh: GitHubClient,
    private readonly http: HttpClient,
    private readonly credentialId: string,
    options: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  private base(owner: string, repo: string): string {
    return `/repos/${owner}/${repo}`;
  }

  async findWorkflow(owner: string, repo: string, workflow: string, signal?: AbortSignal): Promise<GitHubWorkflow | null> {
    try {
      return await this.gh.get(`${this.base(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}`, workflowSchema, { signal, retries: 1 });
    } catch (error) {
      if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * Dispatches the workflow. GitHub returns the run id when the API supports
   * `return_run_details`; otherwise the run is found by its run-name, which
   * Terminia's templates set to include the build id.
   */
  async dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<{ runId?: number }> {
    const path = `${this.base(request.owner, request.repo)}/actions/workflows/${encodeURIComponent(request.workflow)}/dispatches`;
    const body = { ref: request.ref, inputs: stringifyInputs(request.inputs) };
    const send = async (withDetails: boolean) =>
      this.gh.request('POST', path, {
        body: withDetails ? { ...body, return_run_details: true } : body,
        expect: [200, 204],
        signal,
      });
    let response;
    try {
      try {
        response = await this.withWorkflowRegistrationRetry(() => send(true), signal);
      } catch (error) {
        if (!(error instanceof TerminiaError && error.code === 'VALIDATION' && /return_run_details/i.test(error.message))) throw error;
        response = await this.withWorkflowRegistrationRetry(() => send(false), signal);
      }
    } catch (error) {
      throw explainDispatchError(error, request);
    }
    if (response.status === 200 && response.text) {
      try {
        const details = dispatchResultSchema(JSON.parse(response.text), '');
        if (details.workflow_run_id) return { runId: details.workflow_run_id };
      } catch {
        // fall back to matching the run by name
      }
    }
    return {};
  }

  /** A workflow pushed moments ago can take a few seconds before GitHub accepts dispatches for it. */
  private async withWorkflowRegistrationRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof TerminiaError) || error.code !== 'NOT_FOUND' || attempt >= 5) throw error;
        await this.sleep(3000, signal);
      }
    }
  }

  async findRun(request: DispatchRequest & { since: number }, signal?: AbortSignal): Promise<ProviderRun | null> {
    const created = new Date(request.since - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const page = await this.gh.get(
      `${this.base(request.owner, request.repo)}/actions/workflows/${encodeURIComponent(request.workflow)}/runs`,
      runListSchema,
      { query: { event: 'workflow_dispatch', branch: request.ref, created: `>=${created}`, per_page: 30 }, signal },
    );
    const match = page.workflow_runs.find((run) => (run.display_title ?? '').includes(request.buildId) || (run.name ?? '').includes(request.buildId));
    return match ? toRun(match) : null;
  }

  async getRun(ref: RunRef, signal?: AbortSignal): Promise<ProviderRun> {
    return toRun(await this.gh.get(`${this.base(ref.owner, ref.repo)}/actions/runs/${ref.runId}`, runSchema, { signal }));
  }

  async listRuns(owner: string, repo: string, workflow: string, options: { perPage?: number; signal?: AbortSignal } = {}): Promise<ProviderRun[]> {
    const page = await this.gh.get(`${this.base(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`, runListSchema, {
      query: { per_page: options.perPage ?? 20 },
      signal: options.signal,
    });
    return page.workflow_runs.map(toRun);
  }

  async listJobs(ref: RunRef, signal?: AbortSignal): Promise<JobInfo[]> {
    const page = await this.gh.get(`${this.base(ref.owner, ref.repo)}/actions/runs/${ref.runId}/jobs`, jobListSchema, {
      query: { filter: 'latest', per_page: 100 },
      signal,
    });
    return page.jobs.map(toJob);
  }

  /** Full log of a finished job (GitHub redirects to short-lived log storage). */
  async jobLog(ref: RunRef, jobId: number, signal?: AbortSignal): Promise<string> {
    const response = await this.gh.request('GET', `${this.base(ref.owner, ref.repo)}/actions/jobs/${jobId}/logs`, {
      accept: 'application/vnd.github+json',
      signal,
      maxBytes: 24 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    return redact(response.text);
  }

  async annotations(ref: RunRef, jobId: number, signal?: AbortSignal): Promise<Annotation[]> {
    const list = await this.gh.get(`${this.base(ref.owner, ref.repo)}/check-runs/${jobId}/annotations`, annotationListSchema, { query: { per_page: 50 }, signal });
    return list.map((a) => ({
      level: a.annotation_level,
      title: a.title ?? '',
      message: redact(a.message),
      path: a.path || undefined,
      line: a.start_line || undefined,
      jobId,
    }));
  }

  async cancel(ref: RunRef, signal?: AbortSignal): Promise<void> {
    try {
      await this.gh.request('POST', `${this.base(ref.owner, ref.repo)}/actions/runs/${ref.runId}/cancel`, { expect: [202], signal });
    } catch (error) {
      if (error instanceof TerminiaError && error.code === 'CONFLICT') {
        throw new TerminiaError('CONFLICT', 'GitHub cannot cancel this run: it has already finished.');
      }
      throw error;
    }
  }

  async listArtifacts(ref: RunRef, signal?: AbortSignal): Promise<ArtifactInfo[]> {
    const page = await this.gh.get(`${this.base(ref.owner, ref.repo)}/actions/runs/${ref.runId}/artifacts`, artifactListSchema, { query: { per_page: 100 }, signal });
    return page.artifacts.map(toArtifact);
  }

  async downloadArtifact(
    ref: RunRef,
    artifact: ArtifactInfo,
    destination: { root: RootId; path: string },
    options: { onProgress?: (received: number, total: number) => void; signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<DownloadResult> {
    if (artifact.expired) {
      throw new TerminiaError('EXPIRED', `The artifact '${artifact.name}' has expired on GitHub.`, { hint: 'Run the build again to produce a new one.' });
    }
    const result = await this.http.download({
      url: this.gh.url(`${this.base(ref.owner, ref.repo)}/actions/artifacts/${artifact.id}/zip`),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      credentialId: this.credentialId,
      root: destination.root,
      path: destination.path,
      maxBytes: options.maxBytes,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (result.status === 410) throw new TerminiaError('EXPIRED', `The artifact '${artifact.name}' has expired.`, { hint: 'Run the build again.' });
    if (result.status === 401) throw new TerminiaError('AUTH_FAILED', 'GitHub rejected the credential while downloading.', { hint: 'Reconnect GitHub in Settings.' });
    if (result.status === 403 || result.status === 404) {
      throw new TerminiaError('PERMISSION_DENIED', `GitHub refused the artifact download (${result.status}).`, { hint: 'The token needs Actions read access to this repository.' });
    }
    if (result.status >= 400) throw new TerminiaError('PROVIDER', `Artifact download failed with HTTP ${result.status}.`, { retryable: result.status >= 500 });
    return result;
  }
}

function stringifyInputs(inputs: Record<string, string | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) out[key] = String(value);
  return out;
}

function explainDispatchError(error: unknown, request: DispatchRequest): unknown {
  if (!(error instanceof TerminiaError)) return error;
  if (error.code === 'VALIDATION' && /workflow_dispatch/i.test(error.message)) {
    return new TerminiaError('CONFIG_REQUIRED', `${request.workflow} on '${request.ref}' cannot be started from Terminia (no workflow_dispatch trigger).`, {
      hint: 'Update the workflow: `terminia ci install`, then `terminia git sync`.',
    });
  }
  if (error.code === 'VALIDATION' && /unexpected inputs|input/i.test(error.message)) {
    return new TerminiaError('CONFIG_REQUIRED', `${request.workflow} on '${request.ref}' does not accept Terminia's inputs: ${error.message}`, {
      hint: 'The workflow is outdated or edited. Run `terminia ci status` and `terminia ci install`.',
    });
  }
  if (error.code === 'VALIDATION' && /No ref found/i.test(error.message)) {
    return new TerminiaError('NOT_FOUND', `Branch '${request.ref}' does not exist in ${request.owner}/${request.repo}.`, { hint: 'Sync the project first (`terminia git sync`).' });
  }
  if (error.code === 'NOT_FOUND') {
    return new TerminiaError('CONFIG_REQUIRED', `GitHub does not know the workflow ${request.workflow} in ${request.owner}/${request.repo}.`, {
      hint: 'Workflows can only be started after they are on the default branch: run `terminia github prepare`.',
    });
  }
  return error;
}

