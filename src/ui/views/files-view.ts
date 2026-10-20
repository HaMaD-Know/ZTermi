import { openSearchPanel } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import type { Services } from '../../app/services';
import { TerminiaError, toTerminiaError } from '../../core/errors';
import { basename, displayPath, joinPath, validateFileName } from '../../core/paths';
import { isProbablyBinary } from '../../core/secrets';
import { formatBytes } from '../../core/util';
import { FOLDERS, WORKSPACE } from '../../fs/vfs';
import { button, clear, h } from '../dom';
import { EditorView, createState, languageFor } from '../editor';
import { icon } from '../icons';
import { choose, confirmDialog, dialog, promptText, toast } from '../overlays';

interface OpenDoc {
  path: string;
  state: EditorState;
  savedText: string;
  mtime: number;
  dirty: boolean;
}

const MAX_EDITOR_BYTES = 5 * 1024 * 1024;

/** File tree + editor. Everything here is local to the iPad. */
export class FilesView {
  readonly el: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private readonly layout: HTMLElement;
  private editor: EditorView | null = null;
  private readonly docs: OpenDoc[] = [];
  private active: OpenDoc | null = null;
  private readonly expanded = new Set<string>([WORKSPACE]);

  constructor(
    private readonly services: Services,
    private readonly openTerminalAt: (path: string) => void,
  ) {
    this.tree = h('div', { class: 'tree', attrs: { role: 'tree', 'aria-label': 'Files' } });
    this.tabs = h('div', { class: 'editor-tabs', attrs: { role: 'tablist', 'aria-label': 'Open files' } });
    this.host = h('div', { class: 'editor-host' });
    this.status = h('div', { class: 'editor-status' });
    const treePane = h(
      'div',
      { class: 'tree-pane' },
      h(
        'div',
        { class: 'toolbar' },
        button(icon('newFile', 16), () => void this.createEntry('file'), { kind: 'ghost', class: 'btn-icon', title: 'New file' }),
        button(icon('newFolder', 16), () => void this.createEntry('folder'), { kind: 'ghost', class: 'btn-icon', title: 'New folder' }),
        button(icon('fileImport', 16), () => void this.importFiles(), { kind: 'ghost', class: 'btn-icon', title: 'Import files from Files' }),
        button(icon('folderOpen', 16), () => void this.openFolder(), { kind: 'ghost', class: 'btn-icon', title: 'Open a folder in place' }),
        h('span', { class: 'grow' }),
        button(icon('refresh', 16), () => void this.renderTree(), { kind: 'ghost', class: 'btn-icon', title: 'Refresh' }),
      ),
      this.tree,
    );
    const editorPane = h(
      'div',
      { class: 'editor-pane' },
      h(
        'div',
        { class: 'toolbar' },
        button(icon('sidebar', 16), () => this.layout.classList.toggle('tree-hidden'), { kind: 'ghost', class: 'btn-icon', title: 'Show or hide the file tree' }),
        button([icon('save', 15), 'Save'], () => void this.save(), { kind: 'plain', title: 'Save (⌘S)' }),
        button([icon('share', 15), 'Save as…'], () => void this.saveAs(), { kind: 'ghost', title: 'Save a copy in the project or to Files' }),
        button(icon('search', 16), () => this.find(), { kind: 'ghost', class: 'btn-icon', title: 'Find and replace (⌘F)' }),
        h('span', { class: 'grow' }),
        button(icon('terminal', 16), () => this.active && this.openTerminalAt(this.active.path.slice(0, this.active.path.lastIndexOf('/'))), { kind: 'ghost', class: 'btn-icon', title: 'Open a terminal in this folder' }),
      ),
      this.tabs,
      this.host,
      this.status,
    );
    this.layout = h('div', { class: 'files' }, treePane, editorPane);
    this.el = h('section', { class: 'view-files', style: 'display:flex;flex-direction:column;flex:1;min-height:0', attrs: { 'aria-label': 'Files' } }, this.layout);
    const current = this.services.projects.current();
    if (current) this.expanded.add(current.path);
    this.services.projects.on('changed', () => void this.renderTree());
    this.services.projects.on('current', (p) => {
      if (p) this.expanded.add(p.path);
      void this.renderTree();
    });
    this.renderEditor();
  }

  show(params?: Record<string, string>): void {
    if (params?.path) {
      this.expanded.add(params.path);
      this.layout.classList.remove('tree-hidden');
    }
    void this.renderTree();
  }

  hasUnsaved(): boolean {
    return this.docs.some((d) => d.dirty);
  }

  // ------------------------------------------------------------- tree

  async renderTree(): Promise<void> {
    const roots = [{ path: WORKSPACE, label: 'Workspace (On My iPad › Terminia)' }];
    for (const m of this.services.vfs.mounts()) if (m.kind === 'folder') roots.push({ path: m.path, label: `Opened folder: ${m.label}` });
    const fragment = document.createDocumentFragment();
    for (const root of roots) {
      fragment.appendChild(h('div', { class: 'tree-root-label' }, root.label));
      await this.renderDir(fragment, root.path, 0);
    }
    clear(this.tree);
    this.tree.appendChild(fragment);
  }

  private async renderDir(parent: Node, dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await this.services.vfs.list(dir);
    } catch (error) {
      parent.appendChild(h('div', { class: 'tree-root-label', style: `padding-left:${20 + depth * 14}px` }, toTerminiaError(error).message));
      return;
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const isDir = e.type === 'directory';
      const open = this.expanded.has(e.path);
      const node = h(
        'button',
        {
          type: 'button',
          class: `tree-node${this.active?.path === e.path ? ' active' : ''}`,
          style: `padding-left:${8 + depth * 14}px`,
          attrs: { role: 'treeitem', 'aria-expanded': isDir ? String(open) : undefined, title: displayPath(e.path) },
          onClick: () => {
            if (isDir) {
              if (open) this.expanded.delete(e.path);
              else this.expanded.add(e.path);
              void this.renderTree();
            } else void this.open(e.path);
          },
        },
        isDir ? icon(open ? 'chevronDown' : 'chevronRight', 14) : h('span', { style: 'width:14px' }),
        icon(isDir ? (open ? 'folderOpen' : 'folder') : languageFor(e.path) ? 'fileCode' : 'file', 15),
        h('span', { class: 'name' }, e.name),
        h(
          'span',
          {
            class: 'more',
            attrs: { role: 'button', 'aria-label': `Actions for ${e.name}`, tabindex: '0' },
            onClick: (ev: Event) => {
              ev.stopPropagation();
              void this.actions(e.path, isDir);
            },
          },
          icon('more', 15),
        ),
      );
      parent.appendChild(node);
      if (isDir && open) await this.renderDir(parent, e.path, depth + 1);
    }
  }

  private targetDir(): string {
    const project = this.services.projects.current();
    if (this.active) return this.active.path.slice(0, this.active.path.lastIndexOf('/'));
    return project?.path ?? WORKSPACE;
  }

  private async createEntry(kind: 'file' | 'folder', dir = this.targetDir()): Promise<void> {
    const name = await promptText(kind === 'file' ? 'New file' : 'New folder', {
      message: `In ${displayPath(dir)}`,
      placeholder: kind === 'file' ? 'index.ts' : 'src',
      confirmLabel: 'Create',
      validate: (v) => {
        try {
          for (const part of v.split('/')) validateFileName(part);
          return null;
        } catch (error) {
          return (error as Error).message;
        }
      },
    });
    if (!name) return;
    const path = joinPath(dir, name.trim());
    try {
      if (kind === 'folder') await this.services.vfs.mkdir(path, { recursive: true });
      else await this.services.vfs.writeText(path, '', { overwrite: false });
      this.expanded.add(dir);
      await this.renderTree();
      if (kind === 'file') await this.open(path);
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  private async importFiles(): Promise<void> {
    const dir = this.targetDir();
    try {
      const { root, rel } = this.services.projects.rootFor(dir);
      const result = await this.services.platform.documents.importFiles(root, rel, { multiple: true });
      if (!result) return;
      toast(`Imported ${result.imported.length} file(s)${result.failed.length ? `, ${result.failed.length} failed` : ''}`, result.failed.length ? 'error' : 'success');
      this.expanded.add(dir);
      await this.renderTree();
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  private async openFolder(): Promise<void> {
    try {
      const project = await this.services.projects.openFolder();
      if (project) {
        this.expanded.add(project.path);
        await this.renderTree();
      }
    } catch (error) {
      const e = toTerminiaError(error);
      toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
    }
  }

  private async actions(path: string, isDir: boolean): Promise<void> {
    const choice = await choose(basename(path), [
      ...(isDir
        ? [
            { value: 'new-file' as const, label: 'New file here' },
            { value: 'terminal' as const, label: 'Open terminal here' },
          ]
        : [{ value: 'open' as const, label: 'Open' }]),
      { value: 'rename' as const, label: 'Rename' },
      { value: 'duplicate' as const, label: 'Duplicate' },
      ...(isDir ? [] : [{ value: 'export' as const, label: 'Save a copy to Files…' }]),
      { value: 'copy-path' as const, label: 'Copy path' },
      { value: 'delete' as const, label: 'Delete', description: 'Deleted permanently - there is no trash' },
    ]);
    try {
      switch (choice) {
        case 'open':
          await this.open(path);
          break;
        case 'new-file':
          await this.createEntry('file', path);
          break;
        case 'terminal':
          this.openTerminalAt(path);
          break;
        case 'rename': {
          const name = await promptText('Rename', { value: basename(path), confirmLabel: 'Rename', validate: (v) => (v.trim() ? null : 'Enter a name.') });
          if (!name) return;
          const target = joinPath(path.slice(0, path.lastIndexOf('/')), validateFileName(name));
          await this.services.vfs.move(path, target);
          for (const doc of this.docs) if (doc.path === path || doc.path.startsWith(`${path}/`)) doc.path = target + doc.path.slice(path.length);
          this.renderEditor();
          break;
        }
        case 'duplicate': {
          const dot = basename(path).lastIndexOf('.');
          const name = isDir || dot <= 0 ? `${basename(path)} copy` : `${basename(path).slice(0, dot)} copy${basename(path).slice(dot)}`;
          await this.services.vfs.copy(path, joinPath(path.slice(0, path.lastIndexOf('/')), name));
          break;
        }
        case 'export':
          await this.services.projects.saveToFiles(path);
          break;
        case 'copy-path':
          await this.services.platform.copyText(path);
          toast('Path copied', 'success');
          break;
        case 'delete': {
          const isFolderRoot = path.startsWith(`${FOLDERS}/`) && path.split('/').length === 3;
          if (path === WORKSPACE || isFolderRoot) throw new TerminiaError('PERMISSION_DENIED', 'Use Projects › Folders to stop using an opened folder.');
          if (!(await confirmDialog({ title: `Delete ${basename(path)}?`, message: `${displayPath(path)} will be deleted permanently${isDir ? ' with everything inside it' : ''}.`, confirmLabel: 'Delete', danger: true }))) return;
          await this.services.vfs.remove(path, { recursive: isDir });
          for (const doc of [...this.docs]) if (doc.path === path || doc.path.startsWith(`${path}/`)) void this.closeDoc(doc, true);
          break;
        }
        default:
          return;
      }
      await this.renderTree();
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  // ------------------------------------------------------------ editor

  async open(path: string, line?: number): Promise<void> {
    let doc = this.docs.find((d) => d.path === path);
    if (!doc) {
      try {
        const stat = await this.services.vfs.stat(path);
        if (stat.type === 'directory') throw new TerminiaError('IS_A_DIRECTORY', `${displayPath(path)} is a folder.`);
        if (stat.size > MAX_EDITOR_BYTES) throw new TerminiaError('TOO_LARGE', `${basename(path)} is ${formatBytes(stat.size)}; the editor opens files up to ${formatBytes(MAX_EDITOR_BYTES)}.`);
        const bytes = await this.services.vfs.readBytes(path, MAX_EDITOR_BYTES);
        if (isProbablyBinary(path, bytes)) throw new TerminiaError('UNSUPPORTED', `${basename(path)} is a binary file and cannot be edited as text.`);
        const { text, mtime } = await this.services.vfs.readText(path);
        const created: OpenDoc = { path, savedText: text, mtime, dirty: false, state: null as unknown as EditorState };
        created.state = createState(text, path, () => this.onDocChange(created), () => void this.save());
        doc = created;
        this.docs.push(doc);
      } catch (error) {
        toast(toTerminiaError(error).message, 'error');
        return;
      }
    }
    this.activate(doc);
    if (line && this.editor) {
      const target = this.editor.state.doc.line(Math.min(line, this.editor.state.doc.lines));
      this.editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    }
    void this.renderTree();
  }

  private onDocChange(doc: OpenDoc): void {
    if (this.active === doc && this.editor) doc.state = this.editor.state;
    const dirty = doc.state.doc.toString() !== doc.savedText;
    if (dirty !== doc.dirty) {
      doc.dirty = dirty;
      this.renderTabs();
    }
    this.renderStatus();
  }

  private activate(doc: OpenDoc): void {
    if (this.active && this.editor) this.active.state = this.editor.state;
    this.active = doc;
    if (!this.editor) {
      clear(this.host);
      this.editor = new EditorView({ state: doc.state, parent: this.host, dispatch: (tr, view) => view.update([tr]) });
      this.editor.dom.addEventListener('keyup', () => this.renderStatus());
      this.editor.dom.addEventListener('click', () => this.renderStatus());
    } else this.editor.setState(doc.state);
    this.renderEditor();
    this.editor.focus();
  }

  private renderEditor(): void {
    this.renderTabs();
    if (!this.active) {
      this.editor?.destroy();
      this.editor = null;
      clear(this.host);
      this.host.appendChild(
        h(
          'div',
          { class: 'empty' },
          h('strong', null, 'No file open'),
          'Choose a file in the tree, or create one. Files live on this iPad in Terminia’s folder and in folders you open.',
        ),
      );
    }
    this.renderStatus();
  }

  private renderTabs(): void {
    clear(this.tabs);
    for (const doc of this.docs) {
      this.tabs.appendChild(
        h(
          'button',
          { type: 'button', class: 'editor-tab', attrs: { role: 'tab', 'aria-selected': String(doc === this.active), title: displayPath(doc.path) }, onClick: () => this.activate(doc) },
          basename(doc.path),
          doc.dirty ? h('span', { class: 'dirty', title: 'Unsaved changes' }) : null,
          h(
            'span',
            {
              class: 'close',
              attrs: { role: 'button', 'aria-label': `Close ${basename(doc.path)}` },
              onClick: (e: Event) => {
                e.stopPropagation();
                void this.closeDoc(doc);
              },
            },
            icon('close', 13),
          ),
        ),
      );
    }
  }

  private renderStatus(): void {
    clear(this.status);
    const doc = this.active;
    if (!doc) return;
    const mount = this.services.vfs.mountFor(doc.path);
    const state = this.editor?.state ?? doc.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    this.status.append(
      h('span', null, displayPath(doc.path)),
      h('span', null, languageFor(doc.path)?.name ?? 'Plain text'),
      h('span', null, `Ln ${line.number}, Col ${head - line.from + 1}`),
      h('span', null, doc.dirty ? 'Unsaved' : 'Saved'),
      h('span', null, mount?.kind === 'folder' ? `Opened folder: ${mount.label}` : 'Workspace'),
    );
  }

  private async closeDoc(doc: OpenDoc, force = false): Promise<void> {
    if (doc.dirty && !force) {
      const result = await dialog({
        title: `Save changes to ${basename(doc.path)}?`,
        message: 'Your changes are lost if you close without saving.',
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: "Don't save", value: 'discard', kind: 'danger' },
          { label: 'Save', value: 'save', kind: 'primary' },
        ],
        cancelValue: 'cancel',
      });
      if (result.value === 'cancel') return;
      if (result.value === 'save' && !(await this.saveDoc(doc))) return;
    }
    const index = this.docs.indexOf(doc);
    this.docs.splice(index, 1);
    if (this.active === doc) {
      this.active = null;
      const next = this.docs[Math.max(0, index - 1)];
      if (next) this.activate(next);
      else this.renderEditor();
    } else this.renderTabs();
  }

  async save(): Promise<void> {
    if (this.active) await this.saveDoc(this.active);
  }

  private async saveDoc(doc: OpenDoc, overwrite = false): Promise<boolean> {
    if (this.active === doc && this.editor) doc.state = this.editor.state;
    const text = doc.state.doc.toString();
    try {
      const { mtime } = await this.services.vfs.writeText(doc.path, text, overwrite ? {} : { expectedMtime: doc.mtime });
      doc.mtime = mtime;
      doc.savedText = text;
      doc.dirty = false;
      this.renderTabs();
      this.renderStatus();
      return true;
    } catch (error) {
      const e = toTerminiaError(error);
      if (e.code !== 'CONFLICT') {
        toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
        return false;
      }
      const result = await dialog({
        title: `${basename(doc.path)} changed outside Terminia`,
        message: 'Another app (or iCloud) changed this file after you opened it.',
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Reload from disk', value: 'reload' },
          { label: 'Overwrite', value: 'overwrite', kind: 'danger' },
        ],
        cancelValue: 'cancel',
      });
      if (result.value === 'overwrite') return this.saveDoc(doc, true);
      if (result.value === 'reload') {
        const fresh = await this.services.vfs.readText(doc.path);
        doc.savedText = fresh.text;
        doc.mtime = fresh.mtime;
        doc.dirty = false;
        doc.state = createState(fresh.text, doc.path, () => this.onDocChange(doc), () => void this.save());
        if (this.active === doc) this.editor?.setState(doc.state);
        this.renderTabs();
      }
      return false;
    }
  }

  private async saveAs(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const choice = await choose('Save as', [
      { value: 'project', label: 'New file in Terminia…', description: 'Saves a copy under a new name next to this file' },
      { value: 'files', label: 'Save a copy to Files…', description: 'Choose a location such as iCloud Drive' },
    ]);
    if (choice === 'project') {
      const name = await promptText('Save as', { value: basename(doc.path), confirmLabel: 'Save', validate: (v) => (v.trim() ? null : 'Enter a name.') });
      if (!name) return;
      const target = joinPath(doc.path.slice(0, doc.path.lastIndexOf('/')), validateFileName(name));
      try {
        await this.services.vfs.writeText(target, (this.editor?.state ?? doc.state).doc.toString(), { overwrite: false });
        await this.open(target);
      } catch (error) {
        toast(toTerminiaError(error).message, 'error');
      }
    } else if (choice === 'files') {
      if (doc.dirty && !(await this.saveDoc(doc))) return;
      try {
        await this.services.projects.saveToFiles(doc.path);
      } catch (error) {
        toast(toTerminiaError(error).message, 'error');
      }
    }
  }

  private find(): void {
    if (!this.editor) return;
    openSearchPanel(this.editor);
  }
}
