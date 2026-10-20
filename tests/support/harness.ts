import { createServices } from '../../src/app/create-services';
import { HeadlessUi, type Services } from '../../src/app/services';
import { MemoryFsBackend } from '../../src/fs/backend';
import { FetchHttpClient } from '../../src/net/http';
import type { Platform } from '../../src/platform';
import { BackendFileOps, type DocumentService } from '../../src/platform/documents';
import { MemoryStore } from '../../src/platform/kv';
import { MemoryVault } from '../../src/platform/vault';
import { createRegistry } from '../../src/commands';
import { SessionManager, type TerminalSession } from '../../src/terminal/session';

/** Documents service for tests: records exports, imports nothing. */
export class TestDocuments implements DocumentService {
  readonly supportsFolders = false;
  readonly exported: string[] = [];
  async pickFolder() {
    return null;
  }
  async listFolders() {
    return [];
  }
  async openFolder(): Promise<never> {
    throw new Error('not supported in tests');
  }
  async closeFolder() {}
  async forgetFolder() {}
  async importFiles() {
    return null;
  }
  async importFolder() {
    return null;
  }
  async exportFile(root: string, path: string) {
    this.exported.push(`${root}:${path}`);
    return true;
  }
}

export interface Harness {
  services: Services;
  vault: MemoryVault;
  ui: HeadlessUi;
  workspace: MemoryFsBackend;
  cache: MemoryFsBackend;
  documents: TestDocuments;
  kv: MemoryStore;
  session: TerminalSession;
  run(input: string): Promise<{ code: number; out: string; err: string; info: string; all: string }>;
}

export function createHarness(options: { fetch?: typeof fetch; files?: Record<string, string>; autoConfirm?: boolean } = {}): Harness {
  const workspace = new MemoryFsBackend('workspace', options.files ?? {});
  const cache = new MemoryFsBackend('cache');
  const kv = new MemoryStore();
  const vault = new MemoryVault();
  const roots = { workspace, cache };
  const documents = new TestDocuments();
  const platform: Platform = {
    kind: 'test',
    isNative: false,
    workspace,
    cache,
    folderBackend: () => {
      throw new Error('no folders in tests');
    },
    documents,
    fileOps: new BackendFileOps(roots),
    vault,
    http: new FetchHttpClient({ vault, roots, fetch: options.fetch }),
    kv,
    openUrl: () => undefined,
    copyText: async () => undefined,
  };
  const ui = new HeadlessUi(options.autoConfirm ?? true);
  const services = createServices(platform, ui, { sleep: () => new Promise((r) => setTimeout(r, 1)) });
  const registry = createRegistry();
  const manager = new SessionManager(registry, services);
  const session = manager.create();
  return {
    services,
    vault,
    ui,
    workspace,
    cache,
    documents,
    kv,
    session,
    async run(input) {
      const before = session.entries.length;
      const code = await session.run(input);
      const entry = session.entries[session.entries.length - 1];
      const lines = session.entries.length > before && entry ? entry.lines : [];
      const pick = (...streams: string[]) => lines.filter((l) => streams.includes(l.stream)).map((l) => l.text).join('\n');
      return { code, out: pick('stdout'), err: pick('stderr'), info: pick('info', 'warn', 'success', 'muted'), all: lines.map((l) => l.text).join('\n') };
    },
  };
}
