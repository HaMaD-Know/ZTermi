import type { Services } from '../../app/services';
import { installNote, type DownloadedArtifact } from '../../artifacts/artifacts';
import type { ArtifactInfo, BuildRecord } from '../../build/types';
import { toTerminiaError } from '../../core/errors';
import { displayPath } from '../../core/paths';
import { formatBytes, formatDateTime, relativeTime } from '../../core/util';
import { button, clear, h } from '../dom';
import { icon, type IconName } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { emptyState, page } from './common';

const KIND_ICON: Record<string, IconName> = { ipa: 'tablet', apk: 'package', aab: 'package', zip: 'archive', wrapper: 'archive', file: 'file' };

/** Artifacts: real files from finished builds, downloaded with progress and saved to Files. */
export class ArtifactsView {
  readonly el: HTMLElement;
  private readonly downloadedHost = h('div');
  private readonly availableHost = h('div');

  constructor(private readonly services: Services) {
    this.el = h(
      'section',
      { style: 'display:flex;flex-direction:column;flex:1;min-height:0', attrs: { 'aria-label': 'Artifacts' } },
      page(
        h('h2', null, 'On this iPad'),
        h('p', null, 'Downloaded artifacts are kept in On My iPad › Terminia › Artifacts, where the Files app can open, share or move them. Save to Files puts a copy anywhere else, such as iCloud Drive.'),
        this.downloadedHost,
        h('h2', null, 'From recent builds'),
        this.availableHost,
      ),
    );
    services.artifacts.on('changed', () => this.render());
    services.artifacts.on('progress', () => this.renderAvailable());
    services.builds.on('history', () => this.renderAvailable());
  }

  show(): void {
    this.render();
  }

  private render(): void {
    this.renderDownloaded();
    this.renderAvailable();
  }

  private renderDownloaded(): void {
    clear(this.downloadedHost);
    const items = this.services.artifacts.downloads();
    if (!items.length) {
      this.downloadedHost.appendChild(emptyState('No downloads yet', 'When a build finishes, download its IPA, APK or archive here or with `terminia ios download`.'));
      return;
    }
    const rows = h('div', { class: 'rows' });
    for (const item of items) rows.appendChild(this.downloadedRow(item));
    this.downloadedHost.appendChild(rows);
  }

  private downloadedRow(item: DownloadedArtifact): HTMLElement {
    const record = this.services.builds.get(item.buildId);
    const note = installNote(item.kind, record);
    return h(
      'div',
      { class: 'row' },
      icon(KIND_ICON[item.kind] ?? 'file', 20),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, item.file.split('/').pop()),
        h('div', { class: 'row-sub' }, `${item.kind.toUpperCase() === 'FILE' ? 'File' : item.kind.toUpperCase()} · ${formatBytes(item.size)} · build ${item.buildId} · ${formatDateTime(item.downloadedAt)}${item.digestVerified ? ' · digest verified' : ''}`),
        h('div', { class: 'row-sub' }, displayPath(item.file)),
        note ? h('div', { class: 'row-sub', style: 'white-space:normal;margin-top:4px' }, note) : null,
      ),
      h(
        'div',
        { class: 'row-actions' },
        button([icon('share', 14), 'Save to Files'], () => void this.services.artifacts.saveToFiles(item).catch((e: unknown) => toast(toTerminiaError(e).message, 'error')), { kind: 'primary' }),
        button(icon('copy', 14), () => void this.services.platform.copyText(item.sha256).then(() => toast('SHA-256 copied', 'success')), { kind: 'ghost', class: 'btn-icon', title: 'Copy SHA-256' }),
        button(icon('trash', 14), () => void this.remove(item), { kind: 'ghost', class: 'btn-icon', title: 'Delete from this iPad' }),
      ),
    );
  }

  private async remove(item: DownloadedArtifact): Promise<void> {
    if (!(await confirmDialog({ title: 'Delete download?', message: `${displayPath(item.file)} is deleted from this iPad. You can download it again until it expires on GitHub.`, confirmLabel: 'Delete', danger: true }))) return;
    await this.services.artifacts.remove(item).catch((e: unknown) => toast(toTerminiaError(e).message, 'error'));
  }

  private renderAvailable(): void {
    void this.services.builds.history().then((records) => {
      clear(this.availableHost);
      const recent = records.filter((r) => r.status === 'succeeded' && r.artifacts.length).slice(0, 12);
      if (!recent.length) {
        this.availableHost.appendChild(emptyState('No finished builds with artifacts', 'Artifacts appear here once a build succeeds.'));
        return;
      }
      const rows = h('div', { class: 'rows' });
      for (const record of recent) for (const artifact of record.artifacts) rows.appendChild(this.availableRow(record, artifact));
      this.availableHost.appendChild(rows);
    });
  }

  private availableRow(record: BuildRecord, artifact: ArtifactInfo): HTMLElement {
    const downloaded = this.services.artifacts.downloaded(artifact.id);
    const active = this.services.artifacts.activeDownloads().find((d) => d.artifactId === artifact.id);
    return h(
      'div',
      { class: 'row' },
      icon(/\.ipa$/i.test(artifact.name) ? 'tablet' : /\.(apk|aab)$/i.test(artifact.name) ? 'package' : 'archive', 20),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, artifact.name),
        h('div', { class: 'row-sub' }, `${record.platform} · ${record.summary} · run #${record.runNumber ?? '?'} · ${formatBytes(artifact.sizeBytes)}${artifact.expired ? ' · expired' : artifact.expiresAt ? ` · expires ${relativeTime(artifact.expiresAt)}` : ''}`),
        active
          ? h(
              'div',
              null,
              h('div', { class: 'progress', style: 'margin-top:6px' }, h('span', { style: `width:${active.total ? Math.round((active.received / active.total) * 100) : 0}%` })),
              h('div', { class: 'row-sub' }, active.state === 'retrying' ? `Connection lost, retrying (attempt ${active.attempt})` : active.state === 'verifying' ? 'Verifying…' : `${formatBytes(active.received)} of ${formatBytes(active.total)}`),
            )
          : null,
      ),
      h(
        'div',
        { class: 'row-actions' },
        active
          ? button('Cancel', () => this.services.artifacts.cancel(artifact.id))
          : downloaded
            ? h('span', { class: 'muted small' }, 'Downloaded')
            : button([icon('download', 14), 'Download'], () => void this.download(record, artifact), { kind: 'primary', disabled: artifact.expired }),
      ),
    );
  }

  private async download(record: BuildRecord, artifact: ArtifactInfo): Promise<void> {
    try {
      const item = await this.services.artifacts.download(record, artifact);
      toast(`Downloaded ${item.file.split('/').pop()}`, 'success');
    } catch (error) {
      const e = toTerminiaError(error);
      if (e.code !== 'CANCELLED') toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
    }
  }
}
