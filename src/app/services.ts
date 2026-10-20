import type { ArtifactService } from '../artifacts/artifacts';
import type { BuildManager } from '../build/manager';
import type { DependencyService } from '../deps/service';
import type { Vfs } from '../fs/vfs';
import type { GitHubService } from '../github/service';
import type { Platform } from '../platform';
import type { ProjectService } from '../projects/projects';
import type { RemoteService } from '../remote/service';
import type { SettingsService } from '../settings/settings';
import type { ConfirmRequest } from '../terminal/types';

export type ViewId = 'terminal' | 'projects' | 'files' | 'deps' | 'builds' | 'artifacts' | 'settings';

/** What services and commands may ask of the user interface. */
export interface UiBridge {
  confirm(request: ConfirmRequest): Promise<boolean>;
  openFile(path: string, line?: number): void;
  openView(view: ViewId, params?: Record<string, string>): void;
  notify(message: string, kind?: 'info' | 'success' | 'error'): void;
  /** Shows the GitHub device code while sign-in is pending. */
  showDeviceCode(info: { userCode: string; verificationUri: string; expiresIn: number }): { close(): void };
}

export interface Services {
  platform: Platform;
  vfs: Vfs;
  settings: SettingsService;
  projects: ProjectService;
  github: GitHubService;
  builds: BuildManager;
  artifacts: ArtifactService;
  deps: DependencyService;
  remote: RemoteService;
  ui: UiBridge;
}

/** A UI bridge for headless use (tests, background tasks): confirms only when told to. */
export class HeadlessUi implements UiBridge {
  readonly notifications: { message: string; kind: string }[] = [];
  readonly confirmations: ConfirmRequest[] = [];
  readonly opened: string[] = [];

  constructor(public autoConfirm = false) {}

  async confirm(request: ConfirmRequest): Promise<boolean> {
    this.confirmations.push(request);
    return this.autoConfirm;
  }
  openFile(path: string): void {
    this.opened.push(path);
  }
  openView(view: ViewId): void {
    this.opened.push(`view:${view}`);
  }
  notify(message: string, kind = 'info'): void {
    this.notifications.push({ message, kind });
  }
  showDeviceCode(): { close(): void } {
    return { close: () => undefined };
  }
}
