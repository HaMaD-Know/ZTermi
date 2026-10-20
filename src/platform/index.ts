import { Capacitor } from '@capacitor/core';
import { CapacitorFsBackend, Directory } from '../fs/capacitor-backend';
import type { FsBackend } from '../fs/backend';
import { NativeFsBackend } from '../fs/native-backend';
import { FetchHttpClient, NativeHttpClient, type HttpClient } from '../net/http';
import { BackendFileOps, NativeDocumentService, WebDocumentService, type DocumentService, type FileOps } from './documents';
import { PreferencesStore, type KeyValueStore } from './kv';
import { MemoryVault, NativeVault, type SecretPrompter, type Vault } from './vault';

/** Everything that differs between the iPad app, the browser preview and tests. */
export interface Platform {
  readonly kind: 'ios' | 'web' | 'test';
  readonly isNative: boolean;
  readonly workspace: FsBackend;
  readonly cache: FsBackend;
  folderBackend(id: string): FsBackend;
  readonly documents: DocumentService;
  readonly fileOps: FileOps;
  readonly vault: Vault;
  readonly http: HttpClient;
  readonly kv: KeyValueStore;
  openUrl(url: string): void;
  copyText(text: string): Promise<void>;
}

export function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function openUrl(url: string): void {
  // Capacitor opens off-app URLs from window.open in Safari.
  if (!/^https:\/\//.test(url)) return;
  window.open(url, '_blank', 'noopener');
}

export function createNativePlatform(): Platform {
  const documents = new NativeDocumentService();
  return {
    kind: 'ios',
    isNative: true,
    workspace: new NativeFsBackend('workspace'),
    cache: new NativeFsBackend('cache'),
    folderBackend: (id) => new NativeFsBackend(`ext:${id}`),
    documents,
    fileOps: documents,
    vault: new NativeVault(),
    http: new NativeHttpClient(),
    kv: new PreferencesStore(),
    openUrl,
    copyText,
  };
}

/**
 * The browser preview: files live in IndexedDB, secrets only in memory for the
 * current tab, and requests go through fetch() (subject to CORS).
 */
export function createWebPlatform(prompter: SecretPrompter): Platform & { vault: MemoryVault } {
  const workspace = new CapacitorFsBackend('workspace', Directory.Documents, 'Terminia');
  const cache = new CapacitorFsBackend('cache', Directory.Cache, 'Terminia');
  const roots = { workspace, cache };
  const vault = new MemoryVault(prompter);
  return {
    kind: 'web',
    isNative: false,
    workspace,
    cache,
    folderBackend: () => {
      throw new Error('Folders cannot be opened in place in the browser preview.');
    },
    documents: new WebDocumentService(roots),
    fileOps: new BackendFileOps(roots),
    vault,
    http: new FetchHttpClient({ vault, roots }),
    kv: new PreferencesStore(),
    openUrl,
    copyText,
  };
}
