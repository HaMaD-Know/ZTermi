import type { BuildRecord, JobInfo } from '../build/types';
import { STATUS_LABELS } from '../build/types';
import { isTerminal } from '../build/state';
import type { PreflightCheck } from '../build/plan';
import { resolvePath } from '../core/paths';
import { formatBytes, formatDateTime, formatDuration, relativeTime } from '../core/util';
import type { OptionSpec } from '../terminal/args';
import type { CommandContext, ConfirmRequest, ExecutionTarget, OutputSink } from '../terminal/types';

export const YES: OptionSpec = { name: 'yes', short: 'y', type: 'boolean', description: 'Skip the confirmation dialog (the details are still printed)' };

export const GITHUB_API: ExecutionTarget = { kind: 'network', service: 'GitHub API' };

export function abs(ctx: CommandContext, path: string): string {
  return resolvePath(ctx.session.cwd(), path, ctx.services.vfs.home);
}

/** Prints the request, then asks in a dialog unless --yes was given. */
export async function confirm(ctx: CommandContext, request: ConfirmRequest): Promise<boolean> {
  if (ctx.args.options.yes === true) return true;
  return ctx.services.ui.confirm(request);
}

export const MARK: Record<string, string> = { ok: '✓', warn: '!', fail: '✗', unknown: '?' };

export function printChecks(out: OutputSink, checks: PreflightCheck[]): void {
  for (const c of checks) {
    const line = `${MARK[c.status]} ${c.label}: ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`;
    if (c.status === 'ok') out.success(line);
    else if (c.status === 'fail') out.error(line);
    else out.warn(line);
  }
}

export function stepMark(status: string, conclusion: string | null): string {
  if (status !== 'completed') return status === 'in_progress' ? '●' : '○';
  if (conclusion === 'success') return '✓';
  if (conclusion === 'skipped') return '–';
  if (conclusion === 'cancelled') return '⊘';
  return '✗';
}

export function printJobs(out: OutputSink, jobs: JobInfo[]): void {
  for (const job of jobs) {
    out.writeln(`${stepMark(job.status, job.conclusion)} ${job.name}${job.runnerName ? `  (${job.runnerName})` : ''}`);
    for (const step of job.steps) {
      const took = step.startedAt && step.completedAt ? `  ${formatDuration(Date.parse(step.completedAt) - Date.parse(step.startedAt))}` : '';
      out.writeln(`    ${stepMark(step.status, step.conclusion)} ${step.name}${took}`);
    }
  }
}

export function buildTitle(record: BuildRecord): string {
  const what = record.kind === 'deps' ? 'Dependencies' : record.platform === 'ios' ? 'iOS' : record.platform === 'android' ? 'Android' : 'Web';
  return `${what} build ${record.id}${record.runNumber ? ` · run #${record.runNumber}` : ''}`;
}

export function printBuild(out: OutputSink, record: BuildRecord, options: { jobs?: boolean } = {}): void {
  const status = `${STATUS_LABELS[record.status]}${record.statusDetail ? ` (${record.statusDetail})` : ''}`;
  out.writeln(`${buildTitle(record)} — ${status}`);
  out.writeln(`  Project:  ${record.project.name}  ·  ${record.summary}`);
  out.writeln(`  GitHub:   ${record.repo.owner}/${record.repo.repo}@${record.branch}${record.commitSha ? ` (${record.commitSha.slice(0, 7)})` : ''}`);
  if (record.runUrl) out.writeln(`  Run:      ${record.runUrl}`);
  out.writeln(`  Started:  ${formatDateTime(record.createdAt)} (${relativeTime(record.createdAt)})`);
  if (record.completedAt) out.writeln(`  Duration: ${formatDuration(record.completedAt - (record.startedAt ?? record.createdAt))}`);
  if (options.jobs !== false && record.jobs.length) printJobs(out, record.jobs);
  if (record.error) {
    out.error(`  ${record.error.message}`);
    if (record.error.hint) out.info(`  ${record.error.hint}`);
  }
  for (const a of record.annotations.filter((a) => a.level === 'failure' || a.level === 'warning').slice(0, 8)) {
    const text = `  ${a.title ? `${a.title}: ` : ''}${a.message.split('\n').slice(0, 12).join('\n    ')}`;
    if (a.level === 'failure') out.error(text);
    else out.warn(text);
  }
  if (record.artifacts.length) {
    out.writeln('  Artifacts:');
    for (const a of record.artifacts) {
      out.writeln(`    ${a.name}  ${formatBytes(a.sizeBytes)}${a.expired ? '  (expired)' : a.expiresAt ? `  expires ${relativeTime(a.expiresAt)}` : ''}`);
    }
  }
}

/** Prints live progress of a build until it finishes or the user stops following. */
export async function followBuild(ctx: CommandContext, record: BuildRecord, platformCommand: string): Promise<BuildRecord> {
  const out = ctx.out;
  if (isTerminal(record.status)) return record;
  out.info(`Following ${buildTitle(record)}. Ctrl+C stops following; the build keeps running on GitHub.`);
  const seen = new Map<string, string>();
  let lastStatus = record.status;
  const report = (r: BuildRecord) => {
    if (r.status !== lastStatus) {
      lastStatus = r.status;
      out.info(`Status: ${STATUS_LABELS[r.status]}${r.statusDetail ? ` (${r.statusDetail})` : ''}`);
    }
    for (const job of r.jobs) {
      for (const step of job.steps) {
        const key = `${job.id}:${step.number}`;
        const state = `${step.status}:${step.conclusion}`;
        if (seen.get(key) === state) continue;
        seen.set(key, state);
        if (step.status === 'in_progress') out.muted(`● ${step.name}`);
        if (step.status === 'completed') {
          const line = `${stepMark(step.status, step.conclusion)} ${step.name}`;
          if (step.conclusion === 'failure') out.error(line);
          else out.writeln(line);
        }
      }
    }
  };
  report(record);
  try {
    const final = await ctx.services.builds.waitFor(record.id, report, ctx.signal);
    out.writeln('');
    printBuild(out, final, { jobs: false });
    return final;
  } catch (error) {
    if (ctx.signal.aborted) {
      out.warn(`Stopped following. The build continues on GitHub — check it with \`terminia ${platformCommand} status\`, or cancel it with \`terminia ${platformCommand} cancel\`.`);
      return ctx.services.builds.get(record.id) ?? record;
    }
    throw error;
  }
}

/** Throttled download progress printer. */
export function progressPrinter(out: OutputSink, label: string): (received: number, total: number) => void {
  let lastPrint = 0;
  let lastPercent = -10;
  return (received, total) => {
    const now = Date.now();
    const percent = total ? Math.floor((received / total) * 100) : -1;
    if ((percent >= 0 && percent - lastPercent >= 10) || now - lastPrint > 3000) {
      lastPrint = now;
      lastPercent = percent;
      out.muted(`${label}: ${formatBytes(received)}${total ? ` of ${formatBytes(total)} (${percent}%)` : ''}`);
    }
  };
}
