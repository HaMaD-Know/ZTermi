import { ArtifactService } from '../artifacts/artifacts';
import { BuildManager } from '../build/manager';
import type { BuildProvider } from '../build/provider';
import { DependencyService } from '../deps/service';
import { Vfs, WORKSPACE } from '../fs/vfs';
import { GitHubService } from '../github/service';
import type { Platform } from '../platform';
import { ProjectService } from '../projects/projects';
import { RemoteService } from '../remote/service';
import { SettingsService } from '../settings/settings';
import type { Services, UiBridge } from './services';

export interface ServiceOptions {
  provider?: BuildProvider;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Wires all services for a platform. Used by the app and, with test platforms, by the tests. */
export function createServices(platform: Platform, ui: UiBridge, options: ServiceOptions = {}): Services {
  const vfs = new Vfs([{ path: WORKSPACE, backend: platform.workspace, label: 'Workspace', kind: 'workspace' }]);
  const settings = new SettingsService(platform.kv);
  const projects = new ProjectService(vfs, platform);
  const github = new GitHubService(platform, settings);
  const builds = new BuildManager({ platform, vfs, projects, github, settings, provider: options.provider, sleep: options.sleep });
  const artifacts = new ArtifactService(platform, vfs, builds, settings, { sleep: options.sleep });
  const remote = new RemoteService(platform);
  const deps = new DependencyService({ platform, vfs, projects, builds, artifacts, remote });
  return { platform, vfs, settings, projects, github, builds, artifacts, deps, remote, ui };
}

/** Loads persisted state. Order matters: settings first (polling intervals), builds before artifacts. */
export async function initServices(services: Services): Promise<void> {
  await services.settings.load();
  await services.remote.init();
  await services.projects.init();
  await services.builds.init();
  await services.artifacts.init();
}
