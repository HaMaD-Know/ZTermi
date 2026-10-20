import { TerminiaError } from '../core/errors';
import type { BuildStatus } from './types';

/**
 * Build status transitions. Terminal states never change again; provider
 * updates can skip ahead (a fast run may go from dispatching straight to
 * succeeded) but never go backwards.
 */
const NEXT: Record<BuildStatus, readonly BuildStatus[]> = {
  ready: ['waiting_for_signing', 'syncing', 'dispatching', 'failed', 'cancelled'],
  waiting_for_signing: [],
  syncing: ['dispatching', 'failed', 'cancelled'],
  dispatching: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
  queued: ['running', 'succeeded', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: BuildStatus): boolean {
  return NEXT[status].length === 0;
}

export function isActive(status: BuildStatus): boolean {
  return status === 'syncing' || status === 'dispatching' || status === 'queued' || status === 'running';
}

export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

export function transition(from: BuildStatus, to: BuildStatus): BuildStatus {
  if (!canTransition(from, to)) throw new TerminiaError('INTERNAL', `Invalid build status change: ${from} -> ${to}.`);
  return to;
}

export interface ProviderState {
  status: BuildStatus;
  detail?: string;
}

/** Maps a GitHub Actions run (status, conclusion) to a Terminia status. */
export function fromGitHubRun(status: string | null, conclusion: string | null): ProviderState {
  switch (status) {
    case 'queued':
      return { status: 'queued' };
    case 'requested':
    case 'pending':
      return { status: 'queued', detail: 'pending' };
    case 'waiting':
      return { status: 'queued', detail: 'waiting for a deployment approval' };
    case 'action_required':
      return { status: 'queued', detail: 'action required on GitHub' };
    case 'in_progress':
      return { status: 'running' };
    case 'completed':
      switch (conclusion) {
        case 'success':
          return { status: 'succeeded' };
        case 'cancelled':
          return { status: 'cancelled' };
        case 'timed_out':
          return { status: 'failed', detail: 'timed out' };
        case 'startup_failure':
          return { status: 'failed', detail: 'the workflow could not start (startup failure)' };
        case 'action_required':
          return { status: 'failed', detail: 'action required' };
        case 'skipped':
        case 'neutral':
          return { status: 'failed', detail: `finished as ${conclusion}` };
        default:
          return { status: 'failed', detail: conclusion ?? undefined };
      }
    default:
      return { status: 'queued', detail: status ?? undefined };
  }
}
