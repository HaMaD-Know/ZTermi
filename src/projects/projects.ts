import { TerminiaError } from '../core/errors';
import { basename, isInside, joinPath, normalizeAbsolute, relativeTo, resolvePath, validateFileName } from '../core/paths';
import { v } from '../core/validate';
import { Emitter } from '../core/util';
import { WORKSPACE, type Mount, type Vfs } from '../fs/vfs';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import type { RootId } from '../platform/plugins';
import { exportProjectArchive, importProjectArchive, type ExportResult } from './archive';
import { CONFIG_PATH, defaultConfig, parseConfig, serializeConfig, type ProjectConfig } from './config';
import { detectProject, type Detection } from './detect';
import { TEMPLATES, findTemplate, type ProjectTemplate } from './templates';

export interface ProjectInfo {
  name: string;
  /** VFS path of the project root. */
  path: string;
  location: 'workspace' | 'folder';
  folderId?: string;
}

/** Workspace folders Terminia manages itself; they are never listed as projects. */
export const RESERVED_FOLDERS = new Set(['Artifacts', 'Exports', 'Inbox']);

const stateSchema = v.object({
  current: v.withDefault(v.string(), ''),
  recent: v.withDefault(v.array(v.object({ path: v.string(), name: v.string(), openedAt: v.number() }), { max: 50 }), []),
});
type ProjectState = { current: string; recent: { path: string; name: string; openedAt: number }[] };

export interface FolderStatus {
  id: string;
  name: string;
  available: boolean;
  open: boolean;
  stale: boolean;
  mountPath?: string;
}

export class ProjectService extends Emitter<{ changed: undefined; current: ProjectInfo | null }> {
  private state: ProjectState = { current: '', recent: [] };
  private doc: JsonDocument<ProjectState>;
  private currentProject: ProjectInfo | null = null;

  constructor(
    private readonly vfs: Vfs,
    private readonly platform: Platform,
  ) {
    super();
    this.doc = new JsonDocument(platform.kv, 'terminia.projects', stateSchema, () => ({ current: '', recent: [] }));
  }

  /** Restores remembered folders and the last open project. */
  async init(): Promise<void> {
    this.state = await this.doc.load();
    await this.restoreFolders().catch((error) => console.warn('Could not restore folders:', error));
    if (this.state.current) {
      try {
        await this.open(this.state.current);
      } catch {
        this.currentProject = null;
      }
    }
  }

  templates(): ProjectTemplate[] {
    return TEMPLATES;
  }

  current(): ProjectInfo | null {
    return this.currentProject;
  }

  requireCurrent(): ProjectInfo {
    if (!this.currentProject) {
      throw new TerminiaError('CONFIG_REQUIRED', 'No project is open.', {
        hint: 'Open one with `terminia project open <name>` or create one with `terminia project new <template> <name>`.',
      });
    }
    return this.currentProject;
  }

  async list(): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    try {
      for (const entry of await this.vfs.list(WORKSPACE)) {
        if (entry.type === 'directory' && !entry.name.startsWith('.') && !RESERVED_FOLDERS.has(entry.name)) {
          out.push({ name: entry.name, path: entry.path, location: 'workspace' });
        }
      }
    } catch (error) {
      if (!(error instanceof TerminiaError && error.code === 'NOT_FOUND')) throw error;
    }
    for (const mount of this.vfs.mounts()) {
      if (mount.kind === 'folder') out.push({ name: basename(mount.path), path: mount.path, location: 'folder', folderId: mount.folderId });
    }
    return out;
  }

  recent(): { path: string; name: string; openedAt: number }[] {
    return this.state.recent;
  }

  /** Finds a project by name, VFS path, or a path relative to the workspace. */
  async resolve(ref: string, cwd = WORKSPACE): Promise<ProjectInfo> {
    const projects = await this.list();
    const byName = projects.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (byName) return byName;
    const path = resolvePath(cwd, ref);
    const exact = projects.find((p) => p.path === path);
    if (exact) return exact;
    if (await this.vfs.isDirectory(path)) {
      const mount = this.vfs.mountFor(path);
      return { name: basename(path) || 'workspace', path, location: mount?.kind === 'folder' ? 'folder' : 'workspace', folderId: mount?.folderId };
    }
    throw new TerminiaError('NOT_FOUND', `No project named '${ref}'.`, { hint: 'List projects with `terminia project list`.' });
  }

  /** The project that contains `path`, if any (used to default commands to the cwd's project). */
  async projectAt(path: string): Promise<ProjectInfo | null> {
    const p = normalizeAbsolute(path);
    for (const project of await this.list()) if (isInside(p, project.path)) return project;
    return null;
  }

  async open(ref: string | ProjectInfo): Promise<ProjectInfo> {
    const project = typeof ref === 'string' ? await this.resolve(ref) : ref;
    this.currentProject = project;
    this.state.current = project.path;
    this.state.recent = [{ path: project.path, name: project.name, openedAt: Date.now() }, ...this.state.recent.filter((r) => r.path !== project.path)].slice(0, 20);
    await this.doc.save(this.state);
    this.emit('current', project);
    return project;
  }

  async close(): Promise<void> {
    this.currentProject = null;
    this.state.current = '';
    await this.doc.save(this.state);
    this.emit('current', null);
  }

  async create(templateId: string, name: string): Promise<ProjectInfo> {
    const template = findTemplate(templateId);
    if (!template) throw new TerminiaError('INVALID_ARGUMENT', `Unknown template '${templateId}'. Available: ${TEMPLATES.map((t) => t.id).join(', ')}.`);
    const clean = validateFileName(name);
    if (RESERVED_FOLDERS.has(clean)) throw new TerminiaError('INVALID_ARGUMENT', `'${clean}' is reserved by Terminia.`);
    const root = joinPath(WORKSPACE, clean);
    if (await this.vfs.exists(root)) throw new TerminiaError('EXISTS', `A project named '${clean}' already exists.`);
    await this.vfs.mkdir(root, { recursive: true });
    for (const [path, content] of Object.entries(template.files(clean))) {
      await this.vfs.writeText(joinPath(root, path), content, { overwrite: false });
    }
    this.emit('changed', undefined);
    return { name: clean, path: root, location: 'workspace' };
  }

  async detect(project = this.requireCurrent()): Promise<Detection> {
    return detectProject({
      list: (rel) => this.vfs.list(joinPath(project.path, rel)),
      readText: async (rel) => {
        try {
          return (await this.vfs.readText(joinPath(project.path, rel))).text;
        } catch {
          return null;
        }
      },
    });
  }

  async config(project = this.requireCurrent()): Promise<ProjectConfig> {
    const path = joinPath(project.path, CONFIG_PATH);
    if (!(await this.vfs.exists(path))) return defaultConfig();
    return parseConfig((await this.vfs.readText(path)).text);
  }

  async saveConfig(config: ProjectConfig, project = this.requireCurrent()): Promise<void> {
    await this.vfs.writeText(joinPath(project.path, CONFIG_PATH), serializeConfig(config));
  }

  async updateConfig(mutate: (config: ProjectConfig) => void, project = this.requireCurrent()): Promise<ProjectConfig> {
    const config = await this.config(project);
    mutate(config);
    await this.saveConfig(config, project);
    return config;
  }

  /** Maps a VFS path to a native storage root (for the document picker and native file ops). */
  rootFor(path: string): { root: RootId; rel: string; mount: Mount } {
    const { mount, rel } = this.vfs.resolve(path);
    if (mount.kind === 'workspace') return { root: 'workspace', rel, mount };
    if (mount.folderId) return { root: `ext:${mount.folderId}`, rel, mount };
    throw new TerminiaError('UNSUPPORTED', `${path} cannot be exported.`);
  }

  async exportArchive(project = this.requireCurrent(), options: { includeIgnored?: boolean; signal?: AbortSignal } = {}): Promise<ExportResult & { path: string }> {
    const result = await exportProjectArchive(this.vfs, project.path, options);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const path = joinPath(WORKSPACE, 'Exports', `${project.name}-${stamp}.zip`);
    await this.vfs.writeBytes(path, result.zip);
    return { ...result, path };
  }

  /** Presents "Save to Files" for any file in the workspace or an open folder. */
  async saveToFiles(path: string): Promise<boolean> {
    const { root, rel } = this.rootFor(path);
    return this.platform.documents.exportFile(root, rel);
  }

  /** Lets the user pick a zip archive and imports it as a new workspace project. */
  async importArchiveFromPicker(name?: string): Promise<ProjectInfo | null> {
    const picked = await this.platform.documents.importFiles('workspace', 'Inbox', { multiple: false, kind: 'zip' });
    const file = picked?.imported[0];
    if (!file) return null;
    const inboxPath = joinPath(WORKSPACE, file.path);
    try {
      const data = await this.vfs.readBytes(inboxPath, 500 * 1024 * 1024);
      return await this.importArchive(data, name ?? basename(file.name).replace(/\.zip$/i, ''));
    } finally {
      await this.vfs.remove(inboxPath).catch(() => undefined);
    }
  }

  async importArchive(data: Uint8Array, name: string): Promise<ProjectInfo> {
    const clean = await this.freeName(validateFileName(name.replace(/[^\w .-]/g, '_')));
    const root = joinPath(WORKSPACE, clean);
    await importProjectArchive(this.vfs, data, root);
    this.emit('changed', undefined);
    return { name: clean, path: root, location: 'workspace' };
  }

  /** Copies a folder the user picks into the workspace (the original is not changed). */
  async importFolderCopy(): Promise<ProjectInfo | null> {
    const result = await this.platform.documents.importFolder('workspace', '');
    if (!result) return null;
    this.emit('changed', undefined);
    return { name: basename(result.path), path: joinPath(WORKSPACE, result.path), location: 'workspace' };
  }

  private async freeName(name: string): Promise<string> {
    let candidate = name;
    for (let n = 2; await this.vfs.exists(joinPath(WORKSPACE, candidate)); n++) candidate = `${name} ${n}`;
    return candidate;
  }

  // --- Folders opened in place (security-scoped bookmarks) ---

  async openFolder(): Promise<ProjectInfo | null> {
    const picked = await this.platform.documents.pickFolder();
    if (!picked) return null;
    const opened = await this.platform.documents.openFolder(picked.id);
    const mount = this.mountFolder(opened.id, opened.name);
    this.emit('changed', undefined);
    return { name: basename(mount.path), path: mount.path, location: 'folder', folderId: opened.id };
  }

  private mountFolder(id: string, name: string): Mount {
    const existing = this.vfs.mounts().find((m) => m.folderId === id);
    if (existing) return existing;
    return this.vfs.mount({ path: this.vfs.folderMountPath(name), backend: this.platform.folderBackend(id), label: name, kind: 'folder', folderId: id });
  }

  /**
   * Re-opens remembered folders. iOS keeps the bookmark across launches, but
   * access must be re-activated each launch, and a bookmark can go stale
   * (folder moved, provider signed out) - those are reported, not hidden.
   */
  async restoreFolders(): Promise<FolderStatus[]> {
    if (!this.platform.documents.supportsFolders) return [];
    const statuses: FolderStatus[] = [];
    for (const folder of await this.platform.documents.listFolders()) {
      if (!folder.available) {
        statuses.push({ id: folder.id, name: folder.name, available: false, open: false, stale: folder.stale });
        continue;
      }
      try {
        const opened = await this.platform.documents.openFolder(folder.id);
        const mount = this.mountFolder(opened.id, opened.name);
        statuses.push({ id: folder.id, name: folder.name, available: true, open: true, stale: opened.stale, mountPath: mount.path });
      } catch {
        statuses.push({ id: folder.id, name: folder.name, available: true, open: false, stale: folder.stale });
      }
    }
    this.emit('changed', undefined);
    return statuses;
  }

  async folders(): Promise<FolderStatus[]> {
    if (!this.platform.documents.supportsFolders) return [];
    const mounts = this.vfs.mounts();
    return (await this.platform.documents.listFolders()).map((f) => ({
      id: f.id,
      name: f.name,
      available: f.available,
      open: f.open,
      stale: f.stale,
      mountPath: mounts.find((m) => m.folderId === f.id)?.path,
    }));
  }

  async closeFolder(id: string, forget = false): Promise<void> {
    const mount = this.vfs.mounts().find((m) => m.folderId === id);
    if (mount) this.vfs.unmount(mount.path);
    if (this.currentProject && mount && isInside(this.currentProject.path, mount.path)) await this.close();
    if (forget) await this.platform.documents.forgetFolder(id);
    else await this.platform.documents.closeFolder(id);
    this.emit('changed', undefined);
  }

  /** Path of `path` relative to the current project, or null when outside it. */
  relativeToProject(path: string): string | null {
    const project = this.currentProject;
    if (!project || !isInside(path, project.path)) return null;
    return relativeTo(project.path, path);
  }
}
