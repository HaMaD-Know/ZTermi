import type { ArtifactService } from '../artifacts/artifacts';
import type { BuildManager, StartHooks } from '../build/manager';
import type { DepsJob } from '../build/plan';
import type { BuildRecord } from '../build/types';
import { TerminiaError } from '../core/errors';
import { fromUtf8 } from '../core/hash';
import { joinPath, validateRelativePath } from '../core/paths';
import { extractZip } from '../core/zip';
import type { Vfs } from '../fs/vfs';
import type { Platform } from '../platform';
import type { ProjectInfo, ProjectService } from '../projects/projects';
import type { RemoteService } from '../remote/service';
import type { OutputSink } from '../terminal/types';
import { editPackageJson, editPyproject, editRequirements, type EditResult } from './edit';
import { readManifests, type Ecosystem, type ManifestInfo } from './manifests';
import { npmInfo, parseNpmSpecifier, pypiInfo, validatePipSpecifier, type RegistryInfo } from './registry';

export interface DepsReport {
  ecosystem: string;
  operation: string;
  packages: string[];
  changed: string[];
}

export interface ResultFile {
  /** Path inside the project. */
  path: string;
  content: Uint8Array;
  current: string | null;
  changed: boolean;
}

export interface DepsRunResult {
  build: BuildRecord;
  report: DepsReport | null;
  files: ResultFile[];
}

const JS_ECOSYSTEMS: Ecosystem[] = ['npm', 'pnpm', 'yarn'];

export class DependencyService {
  constructor(
    private readonly s: {
      platform: Platform;
      vfs: Vfs;
      projects: ProjectService;
      builds: BuildManager;
      artifacts: ArtifactService;
      remote: RemoteService;
    },
  ) {}

  private reader(project: ProjectInfo) {
    return {
      list: (rel: string) => this.s.vfs.list(joinPath(project.path, rel)),
      readText: async (rel: string) => {
        try {
          return (await this.s.vfs.readText(joinPath(project.path, rel))).text;
        } catch {
          return null;
        }
      },
    };
  }

  async list(project = this.s.projects.requireCurrent()): Promise<ManifestInfo[]> {
    return readManifests(this.reader(project));
  }

  /** Chooses the manifest for an operation; an explicit ecosystem wins, otherwise it must be unambiguous. */
  pick(manifests: ManifestInfo[], ecosystem?: string, editableOnly = false): ManifestInfo {
    const candidates = manifests.filter((m) => (!ecosystem || m.ecosystem === ecosystem || (ecosystem === 'npm' && JS_ECOSYSTEMS.includes(m.ecosystem))) && (!editableOnly || m.editable));
    if (!candidates.length) {
      throw new TerminiaError('NOT_FOUND', ecosystem ? `This project has no ${ecosystem} manifest${editableOnly ? ' Terminia can edit' : ''}.` : 'This project has no dependency manifest.', {
        hint: 'Supported: package.json, requirements.txt, pyproject.toml (edit); build.gradle, Podfile, Package.swift, *.psd1 (read).',
      });
    }
    if (candidates.length > 1 && !ecosystem) {
      const unique = [...new Set(candidates.map((c) => c.ecosystem))];
      if (unique.length > 1) throw new TerminiaError('INVALID_ARGUMENT', `Several ecosystems found (${unique.join(', ')}). Choose one with --ecosystem.`);
    }
    return candidates[0]!;
  }

  async info(ecosystem: Ecosystem, name: string, signal?: AbortSignal): Promise<RegistryInfo> {
    if (JS_ECOSYSTEMS.includes(ecosystem)) return npmInfo(this.s.platform.http, parseNpmSpecifier(name).name, signal);
    if (ecosystem === 'pip') return pypiInfo(this.s.platform.http, validatePipSpecifier(name).name, signal);
    throw new TerminiaError('UNSUPPORTED', `Registry lookups are available for npm and PyPI; ${ecosystem} packages are resolved on the builder.`);
  }

  /**
   * Declares packages in the manifest (package.json / requirements.txt /
   * pyproject.toml). When no version is given, the latest version is looked
   * up in the registry and pinned with a caret (npm) or == (pip).
   * Nothing is installed.
   */
  async add(specs: string[], options: { ecosystem?: string; dev?: boolean; signal?: AbortSignal; project?: ProjectInfo } = {}): Promise<{ manifest: ManifestInfo; edit: EditResult; lookups: RegistryInfo[] }> {
    const project = options.project ?? this.s.projects.requireCurrent();
    const manifest = this.pick(await this.list(project), options.ecosystem, true);
    const path = joinPath(project.path, manifest.manifest);
    const { text, mtime } = await this.s.vfs.readText(path);
    const lookups: RegistryInfo[] = [];
    let edit: EditResult;
    if (JS_ECOSYSTEMS.includes(manifest.ecosystem)) {
      const packages = [];
      for (const raw of specs) {
        const parsed = parseNpmSpecifier(raw);
        let spec = parsed.spec;
        if (!spec) {
          const info = await npmInfo(this.s.platform.http, parsed.name, options.signal);
          lookups.push(info);
          spec = `^${info.latest}`;
        }
        packages.push({ name: parsed.name, spec });
      }
      edit = editPackageJson(text, 'add', packages, options.dev ? 'devDependencies' : 'dependencies');
    } else {
      const packages = [];
      for (const raw of specs) {
        const parsed = validatePipSpecifier(raw);
        let spec = parsed.spec;
        if (!spec) {
          const info = await pypiInfo(this.s.platform.http, parsed.name, options.signal);
          lookups.push(info);
          spec = `==${info.latest}`;
        }
        packages.push({ name: parsed.name, extras: parsed.extras, spec });
      }
      edit = manifest.manifest === 'pyproject.toml' ? editPyproject(text, 'add', packages) : editRequirements(text, 'add', packages);
    }
    await this.s.vfs.writeText(path, edit.text, { expectedMtime: mtime });
    return { manifest, edit, lookups };
  }

  async remove(names: string[], options: { ecosystem?: string; project?: ProjectInfo } = {}): Promise<{ manifest: ManifestInfo; edit: EditResult }> {
    const project = options.project ?? this.s.projects.requireCurrent();
    const manifest = this.pick(await this.list(project), options.ecosystem, true);
    const path = joinPath(project.path, manifest.manifest);
    const { text, mtime } = await this.s.vfs.readText(path);
    let edit: EditResult;
    if (JS_ECOSYSTEMS.includes(manifest.ecosystem)) {
      edit = editPackageJson(text, 'remove', names.map((n) => ({ name: parseNpmSpecifier(n).name })));
    } else {
      const packages = names.map((n) => ({ name: validatePipSpecifier(n).name }));
      edit = manifest.manifest === 'pyproject.toml' ? editPyproject(text, 'remove', packages) : editRequirements(text, 'remove', packages);
    }
    await this.s.vfs.writeText(path, edit.text, { expectedMtime: mtime });
    return { manifest, edit };
  }

  /** Validates package specifiers for a job before anything is sent to a runner. */
  validateJob(job: DepsJob): DepsJob {
    for (const p of job.packages) {
      if (JS_ECOSYSTEMS.includes(job.ecosystem)) parseNpmSpecifier(p);
      else if (job.ecosystem === 'pip') validatePipSpecifier(p);
      else if (!/^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/.test(p)) throw new TerminiaError('INVALID_ARGUMENT', `'${p}' is not a valid package name.`);
    }
    if ((job.operation === 'add' || job.operation === 'remove') && !job.packages.length) {
      throw new TerminiaError('INVALID_ARGUMENT', `'${job.operation}' needs at least one package.`);
    }
    return job;
  }

  /**
   * Runs the job with the real package manager on a GitHub Actions runner,
   * then downloads the changed manifest/lock files. They are returned for
   * review; nothing is written to the project until applyFiles().
   */
  async runOnGitHub(job: DepsJob, hooks: StartHooks, onUpdate: (record: BuildRecord) => void, signal?: AbortSignal): Promise<DepsRunResult> {
    this.validateJob(job);
    const project = this.s.projects.requireCurrent();
    const plan = await this.s.builds.prepare({ kind: 'deps', platform: 'web', project, deps: job }, signal);
    const started = await this.s.builds.start(plan, hooks, signal);
    if (started.status === 'failed' || started.status === 'cancelled') return { build: started, report: null, files: [] };
    const build = await this.s.builds.waitFor(started.id, onUpdate, signal);
    const artifact = build.artifacts.find((a) => a.name === 'terminia-deps-result');
    if (!artifact) return { build, report: null, files: [] };
    const downloaded = await this.s.artifacts.download(build, artifact, { signal });
    const zip = await this.s.vfs.readBytes(downloaded.file, 50 * 1024 * 1024);
    const entries = extractZip(zip, { maxEntries: 500, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 200 });
    const reportEntry = entries.find((e) => e.path === 'deps-result/report.json');
    const report = reportEntry ? (JSON.parse(fromUtf8(reportEntry.data)) as DepsReport) : null;
    const config = await this.s.projects.config(project);
    const prefix = config.github.projectPath.replace(/^\.\/?/, '').replace(/\/+$/, '');
    const files: ResultFile[] = [];
    for (const entry of entries) {
      if (!entry.path.startsWith('deps-result/files/')) continue;
      let rel = entry.path.slice('deps-result/files/'.length);
      if (prefix) {
        if (!rel.startsWith(`${prefix}/`)) continue;
        rel = rel.slice(prefix.length + 1);
      }
      rel = validateRelativePath(rel, { allowEmpty: false });
      let current: string | null;
      try {
        current = (await this.s.vfs.readText(joinPath(project.path, rel))).text;
      } catch {
        current = null;
      }
      files.push({ path: rel, content: entry.data, current, changed: current !== fromUtf8(entry.data) });
    }
    return { build, report, files };
  }

  async applyFiles(files: ResultFile[], project = this.s.projects.requireCurrent()): Promise<string[]> {
    const written: string[] = [];
    for (const file of files.filter((f) => f.changed)) {
      await this.s.vfs.writeBytes(joinPath(project.path, file.path), file.content);
      written.push(file.path);
    }
    return written;
  }

  /** The structured command (program + arguments) a remote host runs for a job. */
  remoteCommand(job: DepsJob): { program: string; args: string[] } {
    const pkgs = job.packages;
    switch (job.ecosystem) {
      case 'npm': {
        const base = ['--no-audit', '--no-fund'];
        if (job.operation === 'add') return { program: 'npm', args: ['install', ...base, ...(job.dev ? ['--save-dev'] : []), ...pkgs] };
        if (job.operation === 'remove') return { program: 'npm', args: ['uninstall', ...base, ...pkgs] };
        if (job.operation === 'update') return { program: 'npm', args: ['update', ...base, ...pkgs] };
        if (job.operation === 'list') return { program: 'npm', args: ['ls', '--depth=0'] };
        return { program: 'npm', args: ['install', ...base] };
      }
      case 'pnpm':
        return { program: 'pnpm', args: job.operation === 'add' ? ['add', ...(job.dev ? ['-D'] : []), ...pkgs] : job.operation === 'remove' ? ['remove', ...pkgs] : job.operation === 'update' ? ['update', ...pkgs] : job.operation === 'list' ? ['list', '--depth', '0'] : ['install'] };
      case 'yarn':
        return { program: 'yarn', args: job.operation === 'add' ? ['add', ...(job.dev ? ['--dev'] : []), ...pkgs] : job.operation === 'remove' ? ['remove', ...pkgs] : job.operation === 'update' ? ['upgrade', ...pkgs] : job.operation === 'list' ? ['list', '--depth=0'] : ['install'] };
      case 'pip':
        if (job.operation === 'add' || job.operation === 'update') return { program: 'python', args: ['-m', 'pip', 'install', ...(job.operation === 'update' ? ['--upgrade'] : []), ...(pkgs.length ? pkgs : ['-r', 'requirements.txt'])] };
        if (job.operation === 'remove') return { program: 'python', args: ['-m', 'pip', 'uninstall', '-y', ...pkgs] };
        if (job.operation === 'list') return { program: 'python', args: ['-m', 'pip', 'list'] };
        return { program: 'python', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] };
      default:
        throw new TerminiaError('UNSUPPORTED', `${job.ecosystem} operations run on the build runners (--on github), not on remote hosts.`);
    }
  }

  /** Runs the job on a remote host, in that host's copy of the project. The iPad copy is not changed. */
  async runOnRemote(profileRef: string | undefined, job: DepsJob, sink: OutputSink, signal: AbortSignal): Promise<{ exitCode: number; cwd: string; program: string; args: string[] }> {
    this.validateJob(job);
    const project = this.s.projects.requireCurrent();
    const profile = this.s.remote.require(profileRef);
    const cwd = profile.projectPaths[project.name];
    if (!cwd) {
      throw new TerminiaError('CONFIG_REQUIRED', `${profile.name} has no folder for the project '${project.name}'.`, {
        hint: `Tell Terminia where the project lives on that host: remote map ${profile.name} "<path on the host>"`,
      });
    }
    const { program, args } = this.remoteCommand(job);
    const exitCode = await this.s.remote.exec(profile.id, program, args, cwd, sink, signal);
    return { exitCode, cwd, program, args };
  }
}
