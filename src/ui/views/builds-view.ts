import type { Services } from '../../app/services';
import { installNote } from '../../artifacts/artifacts';
import type { BuildOverrides, BuildPlan } from '../../build/plan';
import { isActive, isTerminal } from '../../build/state';
import type { BuildPlatform, BuildRecord } from '../../build/types';
import { toTerminiaError } from '../../core/errors';
import { formatBytes, formatDateTime, formatDuration, relativeTime } from '../../core/util';
import { IOS_EXPORT_METHODS } from '../../projects/config';
import { button, clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { checksList, emptyState, field, page, segmented, select, statusChip, targetChip } from './common';

type TargetChoice = 'ios' | 'android' | 'web' | 'custom';

const EXPORT_LABELS: Record<string, string> = {
  unsigned: 'Unsigned (no secrets needed)',
  development: 'Development (signed)',
  'ad-hoc': 'Ad hoc (signed)',
  'app-store': 'App Store (signed)',
  enterprise: 'Enterprise (signed)',
};

function stepMark(status: string, conclusion: string | null): SVGElement {
  if (status !== 'completed') return icon(status === 'in_progress' ? 'spinner' : 'pending', 14, status === 'in_progress' ? 'spin' : '');
  if (conclusion === 'success') return icon('ok', 14);
  if (conclusion === 'skipped') return icon('pending', 14);
  if (conclusion === 'cancelled') return icon('ban', 14);
  return icon('error', 14);
}

/** Builds: start iOS/Android/web builds, follow real provider status, download artifacts. */
export class BuildsView {
  readonly el: HTMLElement;
  private readonly formHost: HTMLElement;
  private readonly checksHost: HTMLElement;
  private readonly detailHost: HTMLElement;
  private readonly historyHost: HTMLElement;
  private target: TargetChoice = 'ios';
  private overrides: BuildOverrides = {};
  private plan: BuildPlan | null = null;
  private busy = false;
  private selected: string | null = null;
  private logs: { id: string; text: string } | null = null;

  constructor(private readonly services: Services) {
    this.formHost = h('div');
    this.checksHost = h('div');
    this.detailHost = h('div');
    this.historyHost = h('div');
    const left = h('div', { class: 'pane' }, page(h('h2', null, 'New build'), this.formHost, this.checksHost));
    const right = h('div', { class: 'pane' }, page(this.detailHost, h('h2', null, 'History'), this.historyHost));
    this.el = h('section', { class: 'split', attrs: { 'aria-label': 'Builds' } }, left, right);
    services.builds.on('update', (r) => {
      if (r.id === this.selected) this.renderDetail();
    });
    services.builds.on('history', () => this.renderHistory());
    services.artifacts.on('progress', () => this.renderDetail());
    services.artifacts.on('changed', () => this.renderDetail());
    services.projects.on('current', () => {
      this.plan = null;
      void this.renderForm();
    });
  }

  show(params?: Record<string, string>): void {
    if (params?.id) this.selected = params.id;
    if (!this.selected) this.selected = this.services.builds.latest()?.id ?? null;
    void this.renderForm();
    this.renderDetail();
    this.renderHistory();
  }

  private platform(): BuildPlatform {
    return this.target === 'custom' ? 'web' : this.target;
  }

  private async renderForm(): Promise<void> {
    clear(this.formHost);
    const project = this.services.projects.current();
    if (!project) {
      this.formHost.appendChild(emptyState('No project open', 'Open or create a project in Projects, then build it here.', button('Open Projects', () => this.services.ui.openView('projects'), { kind: 'primary' })));
      return;
    }
    let config;
    try {
      config = await this.services.projects.config(project);
    } catch (error) {
      this.formHost.appendChild(h('div', { class: 'note err' }, toTerminiaError(error).message));
      return;
    }
    const invalidate = () => {
      this.plan = null;
      clear(this.checksHost);
    };
    const set = <K extends keyof BuildOverrides>(key: K, value: BuildOverrides[K]) => {
      this.overrides[key] = value;
      invalidate();
    };
    const targets: { value: TargetChoice; label: string }[] = [
      { value: 'ios', label: 'iOS' },
      { value: 'android', label: 'Android' },
      { value: 'web', label: 'Web' },
      { value: 'custom', label: 'Custom' },
    ];
    const controls: HTMLElement[] = [];
    if (this.target === 'ios') {
      controls.push(
        h(
          'div',
          { class: 'field-row' },
          field('Configuration', select([{ value: 'release', label: 'Release' }, { value: 'debug', label: 'Debug' }], (this.overrides.configuration ?? config.ios.configuration) as 'release' | 'debug', (v) => set('configuration', v), 'Configuration')),
          field('Export', select(IOS_EXPORT_METHODS.map((m) => ({ value: m, label: EXPORT_LABELS[m]! })), this.overrides.exportMethod ?? config.ios.exportMethod, (v) => set('exportMethod', v), 'Export method')),
        ),
      );
    } else if (this.target === 'android') {
      controls.push(
        h(
          'div',
          { class: 'field-row' },
          field('Variant', select([{ value: 'debug', label: 'Debug (debug key)' }, { value: 'release', label: 'Release (needs keystore secrets)' }], (this.overrides.variant ?? config.android.variant) as 'debug' | 'release', (v) => set('variant', v), 'Variant')),
          field('Package', select([{ value: 'apk', label: 'APK' }, { value: 'aab', label: 'AAB' }, { value: 'both', label: 'APK and AAB' }], this.overrides.output ?? config.android.output, (v) => set('output', v), 'Package format')),
        ),
      );
    } else if (this.target === 'web') {
      controls.push(
        h(
          'div',
          { class: 'field-row' },
          field('Kind', select([{ value: 'web', label: 'Web app' }, { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python package' }] as { value: 'web' | 'node' | 'python'; label: string }[], (this.overrides.kind ?? (config.web.kind === 'custom' ? 'web' : config.web.kind)) as 'web' | 'node' | 'python', (v) => set('kind', v), 'Build kind')),
          field('Runner', select([{ value: 'linux', label: 'Linux' }, { value: 'macos', label: 'macOS' }], this.overrides.runner ?? 'linux', (v) => set('runner', v), 'Runner')),
        ),
      );
    } else {
      const profiles = config.profiles;
      if (profiles.length) {
        controls.push(field('Build profile', select(profiles.map((p) => ({ value: p.name, label: `${p.name} · ${p.command || p.target}` })), this.overrides.profile ?? profiles[0]!.name, (v) => set('profile', v), 'Build profile')));
        this.overrides.profile ??= profiles[0]!.name;
      } else {
        this.overrides.kind = 'custom';
        const command = h('input', { class: 'text-input mono', value: this.overrides.command ?? '', placeholder: 'npm run build:docs', onInput: () => set('command', command.value) });
        const output = h('input', { class: 'text-input mono', value: this.overrides.outputPath ?? '', placeholder: 'dist', onInput: () => set('outputPath', output.value) });
        controls.push(field('Build command', command, 'Runs on a temporary GitHub Actions runner, never on the iPad. You confirm it before the build starts.'), field('Output folder', output));
      }
    }
    const branch = h('input', { class: 'text-input', value: this.overrides.branch ?? '', placeholder: config.github.branch || 'default branch', onInput: () => set('branch', branch.value || undefined) });
    const runner = this.target === 'ios' ? 'macOS' : this.target === 'android' ? 'Linux' : this.overrides.runner === 'macos' ? 'macOS' : 'Linux';
    this.formHost.append(
      field('Target', segmented(targets, this.target, (v) => {
        this.target = v;
        this.overrides = {};
        this.plan = null;
        void this.renderForm();
        clear(this.checksHost);
      }, 'Build target')),
      h('p', { class: 'small muted' }, 'Project ', h('strong', null, project.name), config.github.owner ? ` · builds in ${config.github.owner}/${config.github.repo}` : ' · no repository set yet'),
      ...controls,
      h(
        'div',
        { class: 'field-row' },
        field('Branch', branch),
        field('Before building', select([{ value: 'commit', label: 'Upload the project first' }, { value: 'none', label: 'Build what is on GitHub' }], this.overrides.sync ?? config.github.sync, (v) => set('sync', v), 'Sync strategy')),
      ),
      h('p', null, targetChip({ kind: 'cloud', provider: 'GitHub Actions', runner, purpose: this.target === 'ios' ? 'Xcode' : this.target === 'android' ? 'Gradle' : 'build' })),
      h(
        'p',
        { class: 'small muted' },
        this.target === 'ios'
          ? 'The iPad does not run Xcode. The build runs on a macOS runner; an unsigned IPA must be signed before it can be installed.'
          : this.target === 'android'
            ? 'APK files are Android apps; they cannot be installed on an iPad.'
            : 'The output folder is uploaded as a zip artifact.',
      ),
      h(
        'div',
        { class: 'field-row' },
        button([icon('search', 15), 'Check settings'], () => void this.check(), { disabled: this.busy }),
        button([icon('hammer', 15), this.busy ? 'Starting…' : 'Build'], () => void this.build(), { kind: 'primary', disabled: this.busy }),
      ),
    );
  }

  private async check(): Promise<BuildPlan | null> {
    clear(this.checksHost);
    this.checksHost.appendChild(h('p', { class: 'muted small' }, icon('spinner', 14, 'spin'), ' Checking with GitHub…'));
    try {
      this.plan = await this.services.builds.prepare({ kind: 'build', platform: this.platform(), overrides: this.overrides });
      clear(this.checksHost);
      this.checksHost.append(h('h2', null, 'Checks'), checksList(this.plan.checks));
      return this.plan;
    } catch (error) {
      clear(this.checksHost);
      this.checksHost.appendChild(h('div', { class: 'note err' }, toTerminiaError(error).message));
      return null;
    }
  }

  private async build(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    void this.renderForm();
    try {
      const plan = this.plan ?? (await this.check());
      if (!plan) return;
      const record = await this.services.builds.start(plan, {
        confirmSync: (sync, lines) =>
          confirmDialog({
            title: `Upload to ${sync.owner}/${sync.repo}?`,
            message: `Terminia commits these changes to ${sync.branch}, then starts the build. Detected secrets are never uploaded.`,
            details: lines,
            confirmLabel: 'Upload & build',
          }),
        confirmCommand: (command, runner) => confirmDialog({ title: 'Run this build command?', message: `It runs on a temporary GitHub Actions ${runner} runner:`, details: [command], confirmLabel: 'Run on runner' }),
      });
      this.selected = record.id;
      this.plan = null;
      if (record.status === 'waiting_for_signing') toast(record.error?.message ?? 'Signing is not configured.', 'error');
      else if (record.runId) toast(`Build started (run #${record.runNumber})`, 'success');
      this.renderDetail();
      this.renderHistory();
    } catch (error) {
      const e = toTerminiaError(error);
      if (e.code !== 'CANCELLED') toast(e.message, 'error');
    } finally {
      this.busy = false;
      void this.renderForm();
    }
  }

  private renderDetail(): void {
    clear(this.detailHost);
    const record = this.selected ? this.services.builds.get(this.selected) : undefined;
    if (!record) {
      this.detailHost.append(h('h2', null, 'Build'), emptyState('No build selected', 'Start a build, or choose one from the history.'));
      return;
    }
    const open = record.runUrl ? button([icon('external', 14), 'Open on GitHub'], () => this.services.platform.openUrl(record.runUrl!), { kind: 'ghost' }) : null;
    this.detailHost.append(
      h('h2', null, `${record.platform === 'ios' ? 'iOS' : record.platform === 'android' ? 'Android' : 'Web'} ${record.kind === 'deps' ? 'dependencies' : 'build'} ${record.id}`),
      h('div', { class: 'field-row', style: 'align-items:center;margin-bottom:8px' }, statusChip(record.status, record.statusDetail), record.runNumber ? h('span', { class: 'muted small' }, `Run #${record.runNumber}`) : null, open),
      h(
        'p',
        { class: 'small muted' },
        `${record.project.name} · ${record.summary} · ${record.repo.owner}/${record.repo.repo}@${record.branch}${record.commitSha ? ` (${record.commitSha.slice(0, 7)})` : ''} · started ${relativeTime(record.createdAt)}${record.completedAt ? ` · took ${formatDuration(record.completedAt - (record.startedAt ?? record.createdAt))}` : ''}`,
      ),
    );
    const actions = h('div', { class: 'field-row', style: 'margin-bottom:12px' });
    if (record.runId && isActive(record.status)) {
      actions.appendChild(
        button([icon('stop', 14), 'Cancel build'], async () => {
          try {
            await this.services.builds.cancel(record.id);
            toast('Cancellation requested', 'info');
          } catch (error) {
            toast(toTerminiaError(error).message, 'error');
          }
        }, { kind: 'danger' }),
      );
    }
    if (record.runId) {
      actions.appendChild(button([icon('refresh', 14), 'Refresh'], () => void this.services.builds.refresh(record.id).catch((e: unknown) => toast(toTerminiaError(e).message, 'error'))));
      actions.appendChild(button([icon('history', 14), this.logs?.id === record.id ? 'Hide logs' : 'Logs'], () => void this.toggleLogs(record)));
    }
    this.detailHost.appendChild(actions);

    if (record.error) {
      this.detailHost.appendChild(h('div', { class: `note ${record.status === 'waiting_for_signing' ? 'warn' : 'err'}` }, record.error.message, record.error.hint ? h('div', { class: 'small', style: 'margin-top:6px' }, record.error.hint) : null));
    }
    for (const a of record.annotations.filter((a) => a.level === 'failure' || a.level === 'warning').slice(0, 6)) {
      this.detailHost.appendChild(h('div', { class: `note ${a.level === 'failure' ? 'err' : 'warn'}`, style: 'margin-top:8px' }, h('strong', null, a.title || a.level), h('pre', { class: 'log', style: 'margin-top:6px;max-height:220px' }, a.message)));
    }
    if (record.jobs.length) {
      const jobs = h('div', { class: 'rows', style: 'margin-top:12px' });
      for (const job of record.jobs) {
        jobs.appendChild(h('div', { class: 'row' }, stepMark(job.status, job.conclusion), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, job.name), h('div', { class: 'row-sub' }, job.runnerName ?? 'waiting for a runner'))));
        for (const step of job.steps) {
          const took = step.startedAt && step.completedAt ? formatDuration(Date.parse(step.completedAt) - Date.parse(step.startedAt)) : '';
          jobs.appendChild(h('div', { class: 'row', style: 'min-height:36px;padding-left:34px' }, stepMark(step.status, step.conclusion), h('div', { class: 'row-main small' }, step.name), h('span', { class: 'faint small' }, took)));
        }
      }
      this.detailHost.appendChild(jobs);
    } else if (record.runId && !isTerminal(record.status)) {
      this.detailHost.appendChild(h('p', { class: 'muted small' }, 'Waiting for GitHub to assign a runner. Status updates arrive automatically.'));
    }
    if (this.logs?.id === record.id) this.detailHost.append(h('h2', null, 'Logs'), h('pre', { class: 'log', style: 'max-height:60vh' }, this.logs.text));

    if (record.artifacts.length) {
      this.detailHost.appendChild(h('h2', null, 'Artifacts'));
      const rows = h('div', { class: 'rows' });
      for (const artifact of record.artifacts) {
        const downloaded = this.services.artifacts.downloaded(artifact.id);
        const active = this.services.artifacts.activeDownloads().find((d) => d.artifactId === artifact.id);
        const row = h(
          'div',
          { class: 'row' },
          icon(/\.ipa$/i.test(artifact.name) ? 'tablet' : /\.(apk|aab)$/i.test(artifact.name) ? 'package' : 'archive', 18),
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, artifact.name),
            h('div', { class: 'row-sub' }, `${formatBytes(artifact.sizeBytes)}${artifact.expired ? ' · expired on GitHub' : artifact.expiresAt ? ` · expires ${relativeTime(artifact.expiresAt)}` : ''}${downloaded ? ` · downloaded ${formatDateTime(downloaded.downloadedAt)}` : ''}`),
            active ? h('div', { class: 'progress', style: 'margin-top:6px' }, h('span', { style: `width:${active.total ? Math.round((active.received / active.total) * 100) : 0}%` })) : null,
            downloaded && installNote(downloaded.kind, record) ? h('div', { class: 'row-sub', style: 'white-space:normal' }, installNote(downloaded.kind, record)) : null,
          ),
          h(
            'div',
            { class: 'row-actions' },
            active
              ? button('Cancel', () => this.services.artifacts.cancel(artifact.id))
              : downloaded
                ? button([icon('share', 14), 'Save to Files'], () => void this.services.artifacts.saveToFiles(downloaded).catch((e: unknown) => toast(toTerminiaError(e).message, 'error')))
                : button([icon('download', 14), 'Download'], () => void this.download(record, artifact.id), { kind: 'primary', disabled: artifact.expired }),
          ),
        );
        rows.appendChild(row);
      }
      this.detailHost.appendChild(rows);
    }
  }

  private async download(record: BuildRecord, artifactId: number): Promise<void> {
    const artifact = record.artifacts.find((a) => a.id === artifactId);
    if (!artifact) return;
    try {
      const item = await this.services.artifacts.download(record, artifact);
      toast(`Downloaded ${item.name} to Terminia › Artifacts`, 'success');
    } catch (error) {
      const e = toTerminiaError(error);
      if (e.code !== 'CANCELLED') toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
    }
  }

  private async toggleLogs(record: BuildRecord): Promise<void> {
    if (this.logs?.id === record.id) {
      this.logs = null;
      this.renderDetail();
      return;
    }
    this.logs = { id: record.id, text: 'Loading logs from GitHub…' };
    this.renderDetail();
    try {
      const jobLogs = await this.services.builds.logs(record.id);
      const text = jobLogs
        .map((j) => `━━ ${j.job.name}\n${(j.log ?? j.pending ?? '').split(/\r?\n/).slice(-1500).map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')).join('\n')}`)
        .join('\n\n');
      this.logs = { id: record.id, text: text || 'No jobs yet.' };
    } catch (error) {
      this.logs = { id: record.id, text: toTerminiaError(error).message };
    }
    this.renderDetail();
  }

  private renderHistory(): void {
    void this.services.builds.history().then((records) => {
      clear(this.historyHost);
      if (!records.length) {
        this.historyHost.appendChild(emptyState('No builds yet', 'Builds you start from Terminia appear here with their real GitHub Actions status.'));
        return;
      }
      const rows = h('div', { class: 'rows' });
      for (const r of records.slice(0, 50)) {
        rows.appendChild(
          h(
            'div',
            {
              class: `row clickable${r.id === this.selected ? ' selected' : ''}`,
              attrs: { role: 'button', tabindex: '0' },
              onClick: () => {
                this.selected = r.id;
                this.logs = null;
                this.renderDetail();
                this.renderHistory();
              },
            },
            statusChip(r.status),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, `${r.platform === 'ios' ? 'iOS' : r.platform === 'android' ? 'Android' : 'Web'}${r.kind === 'deps' ? ' dependencies' : ''} · ${r.summary}`), h('div', { class: 'row-sub' }, `${r.project.name} · ${r.id}${r.runNumber ? ` · run #${r.runNumber}` : ''}`)),
            h('span', { class: 'faint small' }, relativeTime(r.createdAt)),
          ),
        );
      }
      this.historyHost.appendChild(rows);
    });
  }
}
