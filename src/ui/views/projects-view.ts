import type { Services } from '../../app/services';
import { toTerminiaError } from '../../core/errors';
import { displayPath } from '../../core/paths';
import { formatBytes } from '../../core/util';
import { describeTypes } from '../../projects/detect';
import type { ProjectInfo } from '../../projects/projects';
import { button, clear, h } from '../dom';
import { icon } from '../icons';
import { choose, confirmDialog, promptText, toast } from '../overlays';
import { emptyState, page } from './common';

/** Projects: create, import, open folders in place, export, see detected build targets. */
export class ProjectsView {
  readonly el: HTMLElement;
  private readonly currentHost = h('div');
  private readonly listHost = h('div');
  private readonly foldersHost = h('div');

  constructor(
    private readonly services: Services,
    private readonly openTerminalAt: (path: string) => void,
  ) {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      button([icon('plus', 15), 'New project'], () => void this.create(), { kind: 'primary' }),
      button([icon('fileImport', 15), 'Import zip'], () => void this.run(() => this.services.projects.importArchiveFromPicker(), 'Imported')),
      button([icon('folderImport', 15), 'Copy a folder in'], () => void this.run(() => this.services.projects.importFolderCopy(), 'Copied')),
      button([icon('folderOpen', 15), 'Open folder in place'], () => void this.run(() => this.services.projects.openFolder(), 'Opened')),
    );
    this.el = h(
      'section',
      { style: 'display:flex;flex-direction:column;flex:1;min-height:0', attrs: { 'aria-label': 'Projects' } },
      toolbar,
      page(this.currentHost, h('h2', null, 'Projects'), this.listHost, h('h2', null, 'Folders opened in place'), this.foldersHost),
    );
    services.projects.on('changed', () => void this.render());
    services.projects.on('current', () => void this.render());
  }

  show(): void {
    void this.render();
  }

  private async run(action: () => Promise<ProjectInfo | null>, verb: string): Promise<void> {
    try {
      const project = await action();
      if (!project) return;
      await this.services.projects.open(project);
      toast(`${verb} ${project.name}`, 'success');
    } catch (error) {
      const e = toTerminiaError(error);
      toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
    }
  }

  private async create(): Promise<void> {
    const template = await choose(
      'New project',
      this.services.projects.templates().map((t) => ({ value: t.id, label: t.name, description: t.description })),
      'Choose a starting point. Everything is created on this iPad; nothing is uploaded until you sync or build.',
    );
    if (!template) return;
    const name = await promptText('Project name', { placeholder: 'MyApp', confirmLabel: 'Create', validate: (v) => (/^[^/\\:]{1,80}$/.test(v.trim()) ? null : 'Use a name without / \\ or :') });
    if (!name) return;
    await this.run(() => this.services.projects.create(template, name.trim()), 'Created');
  }

  private async render(): Promise<void> {
    await Promise.all([this.renderCurrent(), this.renderList(), this.renderFolders()]);
  }

  private async renderCurrent(): Promise<void> {
    clear(this.currentHost);
    const project = this.services.projects.current();
    if (!project) {
      this.currentHost.appendChild(emptyState('No project open', 'Create a project from a template, import a zip, or open a folder from Files.'));
      return;
    }
    let detection;
    let config;
    try {
      [detection, config] = await Promise.all([this.services.projects.detect(project), this.services.projects.config(project)]);
    } catch (error) {
      this.currentHost.appendChild(h('div', { class: 'note err' }, toTerminiaError(error).message));
      return;
    }
    const targets = h(
      'ul',
      { class: 'checks' },
      detection.targets.map((t) =>
        h('li', { class: t.viable ? 'ok' : 'fail' }, icon(t.viable ? 'ok' : 'error', 16), h('div', null, h('strong', null, `${t.platform === 'ios' ? 'iOS' : t.platform === 'android' ? 'Android' : 'Web'}: `), t.reason, ...t.notes.map((n) => h('span', { class: 'fix' }, n)))),
      ),
    );
    this.currentHost.append(
      h('h2', null, project.name),
      h('p', { class: 'muted' }, `${describeTypes(detection.types)} · ${displayPath(project.path)}${project.location === 'folder' ? ' (opened folder)' : ''}`),
      h('p', { class: 'small muted' }, config.github.owner ? `Builds in ${config.github.owner}/${config.github.repo}${config.github.branch ? `@${config.github.branch}` : ''}` : 'No build repository yet. Run `terminia github use <owner>/<repo>` or set it in Builds.'),
      targets,
      ...(detection.ambiguous ? [h('div', { class: 'note' }, 'Several build targets are possible. Choose one explicitly in Builds (or `terminia build ios|android|web`).')] : []),
      h(
        'div',
        { class: 'field-row', style: 'margin-top:12px' },
        button([icon('terminal', 15), 'Terminal here'], () => this.openTerminalAt(project.path)),
        button([icon('folder', 15), 'Files'], () => this.services.ui.openView('files', { path: project.path })),
        button([icon('hammer', 15), 'Build'], () => this.services.ui.openView('builds')),
        button([icon('archive', 15), 'Export zip'], () => void this.exportProject(project)),
        button('Close project', () => void this.services.projects.close(), { kind: 'ghost' }),
      ),
    );
  }

  private async exportProject(project: ProjectInfo): Promise<void> {
    try {
      const result = await this.services.projects.exportArchive(project);
      const excluded = result.excluded.map((f) => `${f.path}: ${f.reason}`);
      const save = await confirmDialog({
        title: 'Project exported',
        message: `${result.included} files (${formatBytes(result.zip.byteLength)}) in ${displayPath(result.path)}.${excluded.length ? ' Files with secrets were left out:' : ''}`,
        details: excluded.length ? excluded : undefined,
        confirmLabel: 'Save to Files…',
      });
      if (save) await this.services.projects.saveToFiles(result.path);
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  private async renderList(): Promise<void> {
    clear(this.listHost);
    const projects = await this.services.projects.list();
    if (!projects.length) {
      this.listHost.appendChild(emptyState('Nothing here yet', 'Projects you create or import appear here. They live in On My iPad › Terminia, so the Files app can see them too.'));
      return;
    }
    const current = this.services.projects.current();
    const rows = h('div', { class: 'rows' });
    for (const p of projects) {
      rows.appendChild(
        h(
          'div',
          { class: `row${p.path === current?.path ? ' selected' : ''}` },
          icon(p.location === 'folder' ? 'folderOpen' : 'boxes', 18),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.name), h('div', { class: 'row-sub' }, `${p.location === 'folder' ? 'Opened folder' : 'Workspace'} · ${displayPath(p.path)}`)),
          h(
            'div',
            { class: 'row-actions' },
            p.path === current?.path ? h('span', { class: 'muted small' }, 'Open') : button('Open', () => void this.services.projects.open(p)),
            button(icon('terminal', 15), () => this.openTerminalAt(p.path), { kind: 'ghost', class: 'btn-icon', title: `Terminal in ${p.name}` }),
            p.location === 'workspace'
              ? button(icon('trash', 15), () => void this.deleteProject(p), { kind: 'ghost', class: 'btn-icon', title: `Delete ${p.name}` })
              : null,
          ),
        ),
      );
    }
    this.listHost.appendChild(rows);
  }

  private async deleteProject(p: ProjectInfo): Promise<void> {
    if (!(await confirmDialog({ title: `Delete ${p.name}?`, message: `${displayPath(p.path)} and all its files are deleted from this iPad permanently. Copies on GitHub are not affected.`, confirmLabel: 'Delete project', danger: true }))) return;
    try {
      if (this.services.projects.current()?.path === p.path) await this.services.projects.close();
      await this.services.vfs.remove(p.path, { recursive: true });
      void this.render();
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  private async renderFolders(): Promise<void> {
    clear(this.foldersHost);
    if (!this.services.platform.documents.supportsFolders) {
      this.foldersHost.appendChild(h('p', { class: 'section-note' }, 'Opening folders in place needs the iPad app. In this browser preview, import a zip instead.'));
      return;
    }
    const folders = await this.services.projects.folders();
    this.foldersHost.appendChild(
      h('p', { class: 'section-note' }, 'Terminia can only use folders you choose in the document picker. iOS remembers them across launches; if one is moved or its provider signs out, choose it again.'),
    );
    if (!folders.length) return;
    const rows = h('div', { class: 'rows' });
    for (const f of folders) {
      rows.appendChild(
        h(
          'div',
          { class: 'row' },
          icon(f.available ? 'folderOpen' : 'warning', 18),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, f.name), h('div', { class: 'row-sub' }, f.available ? (f.open ? `Open at ${f.mountPath}` : 'Remembered, not open') : 'Unavailable: choose the folder again')),
          h(
            'div',
            { class: 'row-actions' },
            !f.available ? button('Choose again', () => void this.run(() => this.services.projects.openFolder(), 'Opened')) : null,
            button('Forget', () => void this.services.projects.closeFolder(f.id, true).then(() => this.render()), { kind: 'ghost' }),
          ),
        ),
      );
    }
    this.foldersHost.appendChild(rows);
  }
}
