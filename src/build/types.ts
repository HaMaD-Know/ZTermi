/** Build records, as stored in history and shown in the Builds view. */

export type BuildPlatform = 'ios' | 'android' | 'web';
export type BuildKind = 'build' | 'deps';

export type BuildStatus =
  | 'ready'
  | 'waiting_for_signing'
  | 'syncing'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const BUILD_STATUSES: readonly BuildStatus[] = [
  'ready',
  'waiting_for_signing',
  'syncing',
  'dispatching',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
];

export const STATUS_LABELS: Record<BuildStatus, string> = {
  ready: 'Ready',
  waiting_for_signing: 'Waiting for signing configuration',
  syncing: 'Syncing project',
  dispatching: 'Starting workflow',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export interface StepInfo {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  runnerName: string | null;
  steps: StepInfo[];
}

export interface ArtifactInfo {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  /** "sha256:<hex>" when GitHub reports it. */
  digest?: string | null;
}

export interface Annotation {
  level: string;
  title: string;
  message: string;
  path?: string;
  line?: number;
  jobId?: number;
}

export interface BuildError {
  code: string;
  message: string;
  hint?: string;
}

export interface BuildRecord {
  id: string;
  kind: BuildKind;
  platform: BuildPlatform;
  project: { name: string; path: string };
  repo: { owner: string; repo: string };
  branch: string;
  commitSha?: string;
  workflow: string;
  inputs: Record<string, string | boolean>;
  /** Short description, e.g. "release · unsigned". */
  summary: string;
  provider: 'github-actions';
  runId?: number;
  runNumber?: number;
  runAttempt?: number;
  runUrl?: string;
  status: BuildStatus;
  /** Provider conclusion (success, failure, timed_out, startup_failure...). */
  conclusion?: string;
  /** Extra provider state, e.g. "waiting for approval". */
  statusDetail?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: BuildError;
  jobs: JobInfo[];
  artifacts: ArtifactInfo[];
  annotations: Annotation[];
  /** Parsed "terminia-result" notice published by the workflow scripts. */
  result?: Record<string, unknown>;
  cancelRequested?: boolean;
}

export interface RunRef {
  owner: string;
  repo: string;
  runId: number;
}

export function runRef(record: BuildRecord): RunRef | null {
  return record.runId ? { owner: record.repo.owner, repo: record.repo.repo, runId: record.runId } : null;
}
