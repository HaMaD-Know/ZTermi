import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { createServices, initServices } from '../app/create-services';
import type { Services, UiBridge, ViewId } from '../app/services';
import { createRegistry } from '../commands';
import { v } from '../core/validate';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import { SessionManager, type SessionsState } from '../terminal/session';
import type { ConfirmRequest } from '../terminal/types';
import { debounce, h, replaceChildren } from './dom';
import { icon } from './icons';
import { confirmDialog, deviceCodeSheet, toast } from './overlays';
import { ArtifactsView } from './views/artifacts-view';
import { BuildsView } from './views/builds-view';
import { DepsView } from './views/deps-view';
import { FilesView } from './views/files-view';
import { ProjectsView } from './views/projects-view';
import { SettingsView } from './views/settings-view';
import { TerminalView } from './views/terminal-view';

const TITLES: Record<Exclude<ViewId, 'terminal'>, string> = {
  projects: 'Projects',
  files: 'Files',
  deps: 'Dependencies',
  builds: 'Builds',
  artifacts: 'Artifacts',
  settings: 'Settings',
};

const sessionsSchema = v.object({
  tabs: v.withDefault(v.array(v.object({ title: v.string(), cwd: v.string() }), { max: 20 }), []),
  history: v.withDefault(v.array(v.string(), { max: 2000 }), []),
});

interface ViewHandle {
  el: HTMLElement;
  show?(params?: Record<string, string>): void;
}

/**
 * The app is the terminal, full screen. Other screens (editor, builds, settings…)
 * open on top of it only when a command asks for them, and close back to it.
 */
export class TerminiaApp implements UiBridge {
  private services!: Services;
  private sessions!: SessionManager;
  private terminal!: TerminalView;
  private files!: FilesView;
  private readonly views = new Map<ViewId, ViewHandle>();
  private readonly hosts = new Map<ViewId, HTMLElement>();
  private current: ViewId = 'terminal';
  private panel!: HTMLElement;
  private panelTitle!: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly platform: Platform,
  ) {}

  async start(): Promise<void> {
    this.services = createServices(this.platform, this);
    await initServices(this.services);
    await this.restoreSessions();
    this.build();
    this.applyTheme();
    this.services.settings.on('changed', () => this.applyTheme());
    this.navigate('terminal');
    document.addEventListener('keydown', (e) => this.onShortcut(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.files.hasUnsaved()) e.preventDefault();
    });
    if (await this.services.github.credential()) void this.services.github.status().catch(() => undefined);
  }

  private async restoreSessions(): Promise<void> {
    const doc = new JsonDocument<SessionsState>(this.platform.kv, 'terminia.sessions', sessionsSchema, () => ({ tabs: [], history: [] }));
    const state = await doc.load();
    const save = debounce((s: SessionsState) => void doc.save(s), 800);
    this.sessions = new SessionManager(createRegistry(), this.services, state.history, save);
    const fallback = this.services.projects.current()?.path ?? this.services.vfs.home;
    const saved = state.tabs[0];
    const cwd = saved && (await this.services.vfs.isDirectory(saved.cwd).catch(() => false)) ? saved.cwd : fallback;
    this.sessions.create({ title: 'Terminal', cwd });
    this.sessions.activate(this.sessions.sessions[0]!.id);
  }

  private build(): void {
    this.terminal = new TerminalView(this.services, this.sessions);
    const openTerminalAt = (path: string) => {
      this.navigate('terminal');
      const session = this.sessions.active();
      if (!session.isRunning() && !session.remoteProfile()) session.setCwd(path);
    };
    const runInTerminal = (command: string) => {
      this.navigate('terminal');
      this.terminal.prefill(command, !this.sessions.active().isRunning());
    };
    this.files = new FilesView(this.services, openTerminalAt);
    this.views.set('projects', new ProjectsView(this.services, openTerminalAt));
    this.views.set('files', this.files);
    this.views.set('deps', new DepsView(this.services, runInTerminal));
    this.views.set('builds', new BuildsView(this.services));
    this.views.set('artifacts', new ArtifactsView(this.services));
    this.views.set('settings', new SettingsView(this.services));

    this.panelTitle = h('div', { class: 'panel-title' });
    const body = h('div', { class: 'panel-body' });
    for (const [id, view] of this.views) {
      const host = h('div', { class: 'view', hidden: true }, view.el);
      this.hosts.set(id, host);
      body.appendChild(host);
    }
    this.panel = h(
      'div',
      { class: 'panel', hidden: true },
      h(
        'div',
        { class: 'panel-bar' },
        this.panelTitle,
        h('button', { type: 'button', class: 'panel-close', title: 'Back to the terminal (Esc)', attrs: { 'aria-label': 'Close' }, onClick: () => this.navigate('terminal') }, icon('close', 18)),
      ),
      body,
    );
    replaceChildren(this.root, h('div', { class: 'app' }, this.terminal.el, this.panel));
  }

  navigate(view: ViewId, params?: Record<string, string>): void {
    this.current = view;
    this.panel.hidden = view === 'terminal';
    for (const [id, host] of this.hosts) host.hidden = id !== view;
    if (view === 'terminal') {
      this.terminal.focus();
      return;
    }
    this.panelTitle.textContent = TITLES[view];
    this.views.get(view)?.show?.(params);
  }

  private applyTheme(): void {
    const settings = this.services.settings.get();
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty('--term-size', `${settings.fontSize}px`);
    if (Capacitor.isNativePlatform()) {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);
      void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
    }
  }

  private onShortcut(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.current !== 'terminal' && !document.querySelector('.dialog')) {
      if (this.current === 'files' && this.files.hasUnsaved()) return;
      e.preventDefault();
      this.navigate('terminal');
      return;
    }
    if (!e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (this.current === 'files' && key === 's') {
      e.preventDefault();
      void this.files.save();
    }
  }

  // ---------------------------------------------------------- UiBridge

  confirm(request: ConfirmRequest): Promise<boolean> {
    return confirmDialog(request);
  }

  openFile(path: string, line?: number): void {
    this.navigate('files', { path: path.slice(0, path.lastIndexOf('/')) });
    void this.files.open(path, line);
  }

  openView(view: ViewId, params?: Record<string, string>): void {
    this.navigate(view, params);
  }

  notify(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    toast(message, kind);
  }

  showDeviceCode(info: { userCode: string; verificationUri: string; expiresIn: number }): { close(): void } {
    return deviceCodeSheet(info, (url) => this.platform.openUrl(url), (text) => this.platform.copyText(text).then(() => toast('Code copied', 'success')));
  }
}
