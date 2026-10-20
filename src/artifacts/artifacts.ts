import type { BuildManager } from '../build/manager';
import { runRef, type ArtifactInfo, type BuildRecord } from '../build/types';
import { TerminiaError, isAbortError, sleep as defaultSleep, toTerminiaError } from '../core/errors';
import { basename, extname, joinPath, validateFileName } from '../core/paths';
import { v } from '../core/validate';
import { Emitter, formatBytes, newId } from '../core/util';
import { classifyZipEntries, type PackageKind } from '../core/zip';
import { WORKSPACE, type Vfs } from '../fs/vfs';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import type { SettingsService } from '../settings/settings';

/**
 * Downloads build artifacts from the provider, verifies them, unwraps the zip
 * GitHub puts around archived artifacts, and keeps the result in
 * Terminia › Artifacts (visible in the Files app) from where it can also be
 * saved anywhere with "Save to Files".
 */

export type ArtifactKind = PackageKind | 'file';

export interface DownloadedArtifact {
  artifactId: number;
  buildId: string;
  platform: string;
  name: string;
  /** VFS path of the downloaded file. */
  file: string;
  kind: ArtifactKind;
  size: number;
  sha256: string;
  digestVerified: boolean;
  downloadedAt: number;
}

export interface ActiveDownload {
  artifactId: number;
  buildId: string;
  name: string;
  received: number;
  total: number;
  attempt: number;
  state: 'downloading' | 'verifying' | 'retrying';
  controller: AbortController;
}

const downloadedSchema = v.array(
  v.object({
    artifactId: v.number(),
    buildId: v.string(),
    platform: v.withDefault(v.string(), ''),
    name: v.string(),
    file: v.string(),
    kind: v.oneOf(['ipa', 'apk', 'aab', 'wrapper', 'zip', 'file'] as const, 'file'),
    size: v.number(),
    sha256: v.withDefault(v.string(), ''),
    digestVerified: v.withDefault(v.boolean(), false),
    downloadedAt: v.number(),
  }),
  { max: 500 },
);

const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'PROVIDER', 'RATE_LIMITED']);

export const ARTIFACTS_DIR = joinPath(WORKSPACE, 'Artifacts');

export class ArtifactService extends Emitter<{ progress: ActiveDownload; changed: undefined }> {
  private items: DownloadedArtifact[] = [];
  private readonly active = new Map<number, ActiveDownload>();
  private readonly doc: JsonDocument<DownloadedArtifact[]>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly platform: Platform,
    private readonly vfs: Vfs,
    private readonly builds: BuildManager,
    private readonly settings: SettingsService,
    options: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
  ) {
    super();
    this.doc = new JsonDocument(platform.kv, 'terminia.artifacts', downloadedSchema, () => []);
    this.sleep = options.sleep ?? defaultSleep;
  }

  async init(): Promise<void> {
    const stored = await this.doc.load();
    // Drop entries whose file was deleted from the Files app.
    const present: DownloadedArtifact[] = [];
    for (const item of stored) if (await this.vfs.exists(item.file).catch(() => false)) present.push(item);
    this.items = present;
    if (present.length !== stored.length) await this.persist();
  }

  downloads(): DownloadedArtifact[] {
    return [...this.items].sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  activeDownloads(): ActiveDownload[] {
    return [...this.active.values()];
  }

  downloaded(artifactId: number): DownloadedArtifact | undefined {
    return this.items.find((i) => i.artifactId === artifactId);
  }

  private async persist(): Promise<void> {
    await this.doc.save(this.items);
    this.emit('changed', undefined);
  }

  /** Resolves an artifact of a build by id, exact name, or name prefix (skips log artifacts by default). */
  async resolve(record: BuildRecord, selector?: string, signal?: AbortSignal): Promise<ArtifactInfo> {
    const list = record.artifacts.length ? record.artifacts : await this.builds.artifacts(record.id, signal);
    if (!list.length) {
      throw new TerminiaError('NOT_FOUND', `Build ${record.id} has no artifacts${record.status === 'succeeded' ? '' : ` (status: ${record.status})`}.`, {
        hint: record.status === 'running' || record.status === 'queued' ? 'Artifacts appear when the run finishes.' : undefined,
      });
    }
    if (!selector) {
      const packages = list.filter((a) => !/-logs(-\d+)?$/.test(a.name) && a.name !== 'terminia-deps-result');
      if (packages.length === 1) return packages[0]!;
      if (!packages.length) return list[0]!;
      throw new TerminiaError('INVALID_ARGUMENT', `Build ${record.id} has several artifacts: ${packages.map((a) => a.name).join(', ')}. Name the one to download.`);
    }
    const found = list.find((a) => String(a.id) === selector || a.name === selector) ?? list.find((a) => a.name.toLowerCase().startsWith(selector.toLowerCase()));
    if (!found) throw new TerminiaError('NOT_FOUND', `No artifact '${selector}' in build ${record.id}. Available: ${list.map((a) => a.name).join(', ')}.`);
    return found;
  }

  cancel(artifactId: number): boolean {
    const active = this.active.get(artifactId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  /**
   * Downloads an artifact. Retries recoverable failures (network, timeouts,
   * 5xx) up to three times. Never fabricates anything: the stored file is
   * exactly what the provider returned, or the single package inside its zip.
   */
  async download(record: BuildRecord, artifact: ArtifactInfo, options: { signal?: AbortSignal; onProgress?: (d: ActiveDownload) => void } = {}): Promise<DownloadedArtifact> {
    const ref = runRef(record);
    if (!ref) throw new TerminiaError('CONFLICT', 'The build has no run on GitHub.');
    if (artifact.expired) {
      throw new TerminiaError('EXPIRED', `'${artifact.name}' expired on GitHub${artifact.expiresAt ? ` (${new Date(artifact.expiresAt).toLocaleDateString()})` : ''}.`, {
        hint: 'Artifacts are kept for 14 days by Terminia\'s workflows. Build again to get a new one.',
      });
    }
    const maxBytes = this.settings.get().maxArtifactMegabytes * 1024 * 1024;
    if (artifact.sizeBytes > maxBytes) {
      throw new TerminiaError('TOO_LARGE', `'${artifact.name}' is ${formatBytes(artifact.sizeBytes)}; the download limit is ${formatBytes(maxBytes)}.`, {
        hint: 'Raise the limit in Settings › Builds.',
      });
    }
    if (this.active.has(artifact.id)) throw new TerminiaError('CONFLICT', `'${artifact.name}' is already downloading.`);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const state: ActiveDownload = { artifactId: artifact.id, buildId: record.id, name: artifact.name, received: 0, total: artifact.sizeBytes, attempt: 1, state: 'downloading', controller };
    this.active.set(artifact.id, state);
    const report = () => {
      this.emit('progress', state);
      options.onProgress?.(state);
    };
    const temp = `downloads/${artifact.id}-${newId().slice(0, 8)}.part`;
    try {
      let result;
      for (;;) {
        try {
          result = await this.builds.provider().downloadArtifact(ref, artifact, { root: 'cache', path: temp }, {
            maxBytes,
            signal: controller.signal,
            onProgress: (received, total) => {
              state.received = received;
              state.total = total || artifact.sizeBytes;
              report();
            },
          });
          break;
        } catch (error) {
          const e = toTerminiaError(error);
          if (controller.signal.aborted || isAbortError(error)) throw new TerminiaError('CANCELLED', 'Download cancelled.');
          if (!RETRYABLE.has(e.code) || state.attempt >= 3) throw e;
          state.attempt++;
          state.state = 'retrying';
          state.received = 0;
          report();
          await this.sleep(2000 * state.attempt, controller.signal);
          state.state = 'downloading';
        }
      }

      state.state = 'verifying';
      report();
      let digestVerified = false;
      const expected = artifact.digest?.replace(/^sha256:/, '').toLowerCase();
      if (expected) {
        if (expected !== result.sha256.toLowerCase()) {
          throw new TerminiaError('VALIDATION', `'${artifact.name}' failed its integrity check (SHA-256 does not match GitHub's digest).`, { hint: 'Download it again.' });
        }
        digestVerified = true;
      }
      const stored = await this.storeResult(record, artifact, temp, result.size, result.sha256, digestVerified);
      this.items = [stored, ...this.items.filter((i) => i.artifactId !== artifact.id)];
      await this.persist();
      return stored;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.active.delete(artifact.id);
      this.emit('changed', undefined);
      await this.platform.cache.remove(temp).catch(() => undefined);
    }
  }

  private async storeResult(record: BuildRecord, artifact: ArtifactInfo, temp: string, size: number, sha256: string, digestVerified: boolean): Promise<DownloadedArtifact> {
    let entries: string[] | null;
    try {
      entries = (await this.platform.fileOps.zipEntries('cache', temp)).map((e) => e.name);
    } catch {
      entries = null; // not a zip: a raw file uploaded with archive: false
    }
    const folder = `Artifacts/${record.platform}-${record.runNumber ? `run${record.runNumber}` : record.id}`;
    const safe = (name: string) => validateFileName(name.replace(/[/\\:]/g, '_'));
    let kind: ArtifactKind = 'file';
    let fileName = safe(artifact.name);
    let finalSize = size;
    let finalSha = sha256;

    if (entries) {
      const classified = classifyZipEntries(entries);
      kind = classified.kind;
      if (classified.kind === 'wrapper' && classified.inner) {
        // GitHub zipped the artifact: keep the package inside, not the wrapper.
        const inner = safe(basename(classified.inner));
        const extracted = `downloads/${artifact.id}-${inner}`;
        finalSize = await this.platform.fileOps.zipExtract('cache', temp, classified.inner, 'cache', extracted);
        finalSha = (await this.platform.fileOps.sha256('cache', extracted)).sha256;
        const kindOfInner = extname(inner).slice(1);
        kind = kindOfInner === 'ipa' || kindOfInner === 'apk' || kindOfInner === 'aab' ? kindOfInner : 'file';
        fileName = inner;
        await this.platform.fileOps.transfer('cache', extracted, 'workspace', `${folder}/${fileName}`, true);
      } else {
        const ext = classified.kind === 'zip' ? '.zip' : `.${classified.kind}`;
        if (!fileName.toLowerCase().endsWith(ext)) fileName += ext;
        await this.platform.fileOps.transfer('cache', temp, 'workspace', `${folder}/${fileName}`, true);
      }
    } else {
      await this.platform.fileOps.transfer('cache', temp, 'workspace', `${folder}/${fileName}`, true);
    }
    return {
      artifactId: artifact.id,
      buildId: record.id,
      platform: record.platform,
      name: artifact.name,
      file: joinPath(WORKSPACE, folder, fileName),
      kind,
      size: finalSize,
      sha256: finalSha,
      digestVerified,
      downloadedAt: Date.now(),
    };
  }

  /** "Save to Files": the system picker lets the user choose iCloud Drive, On My iPad, etc. */
  async saveToFiles(item: DownloadedArtifact): Promise<boolean> {
    const rel = item.file.replace(`${WORKSPACE}/`, '');
    return this.platform.documents.exportFile('workspace', rel);
  }

  async remove(item: DownloadedArtifact): Promise<void> {
    await this.vfs.remove(item.file).catch((error) => {
      if (!(error instanceof TerminiaError && error.code === 'NOT_FOUND')) throw error;
    });
    this.items = this.items.filter((i) => i.artifactId !== item.artifactId);
    await this.persist();
  }
}

/** What the user can and cannot do with a file, stated plainly. */
export function installNote(kind: ArtifactKind, record?: BuildRecord): string {
  switch (kind) {
    case 'apk':
      return 'APK files are Android apps. They cannot be installed on an iPad - copy the file to an Android device to install it.';
    case 'aab':
      return 'An AAB is for uploading to Google Play; it is not directly installable.';
    case 'ipa':
      return record?.inputs.export_method === 'unsigned'
        ? 'Unsigned IPA: it cannot be installed as it is. Sign it first (Xcode, AltStore/Sideloadly, or a signed Terminia build) - see docs/SIGNING.md.'
        : 'Signed IPA: installable only on devices allowed by its provisioning profile (development/ad-hoc), or through TestFlight/App Store distribution.';
    default:
      return '';
  }
}
