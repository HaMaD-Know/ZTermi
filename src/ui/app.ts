import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { createServices, initServices } from '../app/create-services';
import type { Services, UiBridge, ViewId } from '../app/services';
import { createRegistry } from '../commands';
import { isActive } from '../build/state';
import { v } from '../core/validate';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import { SessionManager, type SessionsState } from '../terminal/session';
import type { ConfirmRequest } from '../terminal/types';
import { debounce, h, replaceChildren } from './dom';
import { icon, type IconName } from './icons';
import { choose, confirmDialog, deviceCodeSheet, toast } from './overlays';
import { ArtifactsView } from './views/artifacts-view';
import { BuildsView } from './views/builds-view';
import { DepsView } from './views/deps-view';
import { FilesView } from './views/files-view';
import { ProjectsView } from './views/projects-view';
import { SettingsView } from './views/settings-view';
import { TerminalView } from './views/terminal-view';

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'projects', label: 'Projects', icon: 'boxes' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'deps', label: 'Dependencies', icon: 'package' },
  { id: 'builds', label: 'Builds', icon: 'hammer' },
  { id: 'artifacts', label: 'Artifacts', icon: 'archive' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const sessionsSchema = v.object({
  tabs: v.withDefault(v.array(v.object({ title: v.string(), cwd: v.string() }), { max: 20 }), []),
  history: v.withDefault(v.array(v.string(), { max: 2000 }), []),
});

interface ViewHandle {
  el: HTMLElement;
  show?(params?: Record<string, string>): void;
}

export class TerminiaApp implements UiBridge {
  private services!: Services;
  private sessions!: SessionManager;
  private terminal!: TerminalView;
  private files!: FilesView;
  private readonly views = new Map<ViewId, ViewHandle>();
  private readonly hosts = new Map<ViewId, HTMLElement>();
  private current: ViewId = 'terminal';
  private shell!: HTMLElement;
  private headerTitle!: HTMLElement;
  private projectButton!: HTMLButtonElement;
  private connection!: HTMLElement;
  private readonly navButtons = new Map<string, HTMLButtonElement[]>();

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
    this.services.projects.on('current', () => this.renderHeader());
    this.services.github.on('changed', () => this.renderHeader());
    this.services.builds.on('history', () => this.renderBadges());
    this.services.builds.on('update', () => this.renderBadges());
    this.renderHeader();
    this.renderBadges();
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
    const tabs = state.tabs.length ? state.tabs : [{ title: 'Terminal', cwd: fallback }];
    for (const tab of tabs) {
      const cwd = (await this.services.vfs.isDirectory(tab.cwd).catch(() => false)) ? tab.cwd : fallback;
      this.sessions.create({ title: tab.title, cwd });
    }
    this.sessions.activate(this.sessions.sessions[0]!.id);
  }

  private build(): void {
    this.terminal = new TerminalView(this.services, this.sessions);
    const openTerminalAt = (path: string) => {
      this.navigate('terminal');
      this.terminal.newTab(path);
    };
    const runInTerminal = (command: string) => {
      this.navigate('terminal');
      if (this.sessions.active().isRunning()) this.terminal.newTab();
      this.terminal.prefill(command, true);
    };
    this.files = new FilesView(this.services, openTerminalAt);
    this.views.set('terminal', { el: this.terminal.el, show: () => this.terminal.focus() });
    this.views.set('projects', new ProjectsView(this.services, openTerminalAt));
    this.views.set('files', this.files);
    this.views.set('deps', new DepsView(this.services, runInTerminal));
    this.views.set('builds', new BuildsView(this.services));
    this.views.set('artifacts', new ArtifactsView(this.services));
    this.views.set('settings', new SettingsView(this.services));

    const navButton = (item: (typeof NAV)[number]) => {
      const b = h(
        'button',
        { type: 'button', class: 'rail-item', title: item.label, attrs: { 'aria-label': item.label }, onClick: () => this.navigate(item.id) },
        icon(item.icon, 19),
        h('span', { class: 'rail-label' }, item.label),
        item.id === 'builds' ? h('span', { class: 'badge', hidden: true }) : null,
      );
      this.navButtons.set(item.id, [...(this.navButtons.get(item.id) ?? []), b]);
      return b;
    };
    const rail = h(
      'nav',
      { class: 'rail', attrs: { 'aria-label': 'Main' } },
      h('div', { class: 'rail-brand' }, h('span', { class: 'mark', attrs: { 'aria-hidden': 'true' } }, '>_'), h('span', { class: 'name' }, 'Terminia')),
      NAV.map(navButton),
      h('div', { class: 'rail-spacer' }),
    );
    const tabbar = h('nav', { class: 'tabbar', attrs: { 'aria-label': 'Main' } }, NAV.map(navButton));

    this.headerTitle = h('div', { class: 'header-title' });
    this.projectButton = h('button', { type: 'button', class: 'header-project', title: 'Switch project', onClick: () => void this.switchProject() });
    this.connection = h('button', { type: 'button', class: 'connection btn-ghost btn', onClick: () => this.navigate('settings') });
    const header = h(
      'header',
      { class: 'header' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-icon rail-toggle',
          title: 'Collapse or expand the sidebar (⌘B)',
          attrs: { 'aria-label': 'Toggle sidebar' },
          onClick: () => void this.toggleRail(),
        },
        icon('sidebar', 18),
      ),
      this.headerTitle,
      this.projectButton,
      h('div', { class: 'header-spacer' }),
      this.connection,
    );

    const main = h('main', { class: 'main' }, header);
    for (const item of NAV) {
      const host = h('div', { class: 'view', hidden: true, attrs: { 'aria-label': item.label } }, this.views.get(item.id)!.el);
      this.hosts.set(item.id, host);
      main.appendChild(host);
    }
    this.shell = h('div', { class: `app${this.services.settings.get().sidebarCollapsed ? ' rail-collapsed' : ''}` }, rail, main, tabbar);
    replaceChildren(this.root, this.shell);
  }

  private async toggleRail(): Promise<void> {
    const collapsed = !this.shell.classList.contains('rail-collapsed');
    this.shell.classList.toggle('rail-collapsed', collapsed);
    await this.services.settings.update({ sidebarCollapsed: collapsed });
  }

  navigate(view: ViewId, params?: Record<string, string>): void {
    this.current = view;
    for (const [id, host] of this.hosts) host.hidden = id !== view;
    for (const [id, buttons] of this.navButtons) {
      for (const b of buttons) {
        if (id === view) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      }
    }
    this.headerTitle.textContent = NAV.find((n) => n.id === view)!.label;
    this.views.get(view)?.show?.(params);
  }

  private renderHeader(): void {
    const project = this.services.projects.current();
    replaceChildren(this.projectButton, icon('boxes', 15), project ? project.name : 'No project');
    const gh = this.services.github.lastStatus();
    replaceChildren(
      this.connection,
      h('span', { class: `dot${gh.connected ? ' ok' : gh.credential ? ' err' : ''}` }),
      h('span', { class: 'label' }, gh.connected ? `GitHub · ${gh.user?.login}` : gh.credential ? 'GitHub · check connection' : 'GitHub · not connected'),
    );
    this.connection.title = 'GitHub connection (opens Settings)';
  }

  private renderBadges(): void {
    void this.services.builds.history().then((records) => {
      const active = records.filter((r) => isActive(r.status)).length;
      for (const b of this.navButtons.get('builds') ?? []) {
        const badge = b.querySelector<HTMLElement>('.badge');
        if (!badge) continue;
        badge.hidden = active === 0;
        badge.textContent = String(active);
        b.setAttribute('aria-label', active ? `Builds, ${active} running` : 'Builds');
      }
    });
  }

  private async switchProject(): Promise<void> {
    const projects = await this.services.projects.list();
    if (!projects.length) {
      this.navigate('projects');
      return;
    }
    const choice = await choose('Open project', projects.map((p) => ({ value: p.path, label: p.name, description: p.location === 'folder' ? `Opened folder · ${p.path}` : p.path })));
    if (!choice) return;
    const project = projects.find((p) => p.path === choice)!;
    await this.services.projects.open(project);
    const session = this.sessions.active();
    if (!session.isRunning() && !session.remoteProfile()) session.setCwd(project.path);
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
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const index = Number(key) - 1;
    if (e.metaKey && index >= 0 && index < NAV.length) {
      e.preventDefault();
      this.navigate(NAV[index]!.id);
      return;
    }
    if (e.metaKey && key === 'b') {
      e.preventDefault();
      void this.toggleRail();
      return;
    }
    if (this.current === 'terminal' && e.metaKey && key === 't') {
      e.preventDefault();
      this.terminal.newTab();
    } else if (this.current === 'terminal' && e.metaKey && key === 'w') {
      e.preventDefault();
      this.terminal.closeSession();
    } else if (this.current === 'files' && e.metaKey && key === 's') {
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
