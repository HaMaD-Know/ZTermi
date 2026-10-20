import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Contracts of Terminia's three native iOS plugins (ios/App/App/Terminia/*.swift).
 * `scripts/check-ios-project.mjs` verifies that every method declared here has
 * an @objc implementation and a CAPPluginMethod entry in Swift.
 *
 * None of them has a web implementation on purpose: the browser preview uses
 * the separate classes in src/fs, src/platform/vault.ts and src/net/http.ts,
 * so nothing silently pretends to be native.
 */

/** Storage roots: the app's Documents folder, its Caches folder, or a user-selected folder. */
export type RootId = 'workspace' | 'cache' | `ext:${string}`;

export interface NativeDirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  /** iCloud items that are not downloaded yet report false. */
  downloaded?: boolean;
}

export interface NativeFolderInfo {
  id: string;
  name: string;
  path: string;
  available: boolean;
  stale: boolean;
  open: boolean;
  addedAt: number;
}

export interface TerminiaFilesPlugin {
  getWorkspace(): Promise<{ path: string }>;
  pickFolder(): Promise<{ cancelled: boolean; id?: string; name?: string; path?: string }>;
  listFolders(): Promise<{ folders: NativeFolderInfo[] }>;
  openFolder(options: { id: string }): Promise<{ id: string; name: string; path: string; stale: boolean }>;
  closeFolder(options: { id: string }): Promise<void>;
  forgetFolder(options: { id: string }): Promise<void>;
  importFiles(options: { root: RootId; destination: string; multiple?: boolean; kind?: 'any' | 'zip' }): Promise<{
    cancelled: boolean;
    imported: { name: string; path: string; size: number }[];
    failed: { name: string; error: string }[];
  }>;
  importFolder(options: { root: RootId; destination: string }): Promise<{ cancelled: boolean; name?: string; path?: string; files?: number }>;
  exportFile(options: { root: RootId; path: string }): Promise<{ cancelled: boolean; exported: boolean }>;
  list(options: { root: RootId; path: string }): Promise<{ entries: NativeDirEntry[] }>;
  stat(options: { root: RootId; path: string }): Promise<{ type: 'file' | 'directory'; size: number; mtime: number }>;
  readText(options: { root: RootId; path: string }): Promise<{ data: string; mtime: number }>;
  writeText(options: { root: RootId; path: string; data: string; expectedMtime?: number; overwrite?: boolean }): Promise<{ mtime: number }>;
  readBase64(options: { root: RootId; path: string; maxBytes?: number }): Promise<{ data: string; size: number; mtime: number }>;
  writeBase64(options: { root: RootId; path: string; data: string; overwrite?: boolean }): Promise<{ mtime: number }>;
  mkdir(options: { root: RootId; path: string; recursive?: boolean }): Promise<void>;
  remove(options: { root: RootId; path: string; recursive?: boolean }): Promise<void>;
  rename(options: { root: RootId; from: string; to: string }): Promise<void>;
  copy(options: { root: RootId; from: string; to: string }): Promise<void>;
  transfer(options: { fromRoot: RootId; from: string; toRoot: RootId; to: string; move: boolean }): Promise<void>;
  zipEntries(options: { root: RootId; path: string }): Promise<{ entries: { name: string; size: number; compressedSize: number; method: number }[] }>;
  zipExtract(options: { root: RootId; path: string; entry: string; toRoot: RootId; to: string }): Promise<{ size: number }>;
  sha256(options: { root: RootId; path: string }): Promise<{ sha256: string; size: number }>;
}

export type CredentialKind = 'github-classic' | 'github-fine-grained' | 'github-oauth' | 'github-app-user' | 'remote-agent' | 'generic';

/** Credential metadata. The secret value itself never leaves native code. */
export interface CredentialInfo {
  id: string;
  label: string;
  kind: CredentialKind;
  /** Exact origins (scheme://host[:port]) the secret may be sent to. Fixed when stored. */
  allowedOrigins: string[];
  /** Optional SHA-256 (hex) of the server's leaf certificate, enforced natively. */
  pinSha256?: string;
  createdAt: number;
  expiresAt?: number;
  /** Granted OAuth scopes when the provider reported them. */
  scopes?: string[];
}

export interface TerminiaVaultPlugin {
  isAvailable(): Promise<{ available: boolean; storage: 'keychain' }>;
  /** Shows a native secure text field, stores what the user types in the Keychain. */
  promptSecret(options: {
    id: string;
    label: string;
    kind: CredentialKind;
    title: string;
    message: string;
    placeholder?: string;
    allowedOrigins: string[];
    pinSha256?: string;
  }): Promise<{ cancelled: boolean; credential?: CredentialInfo }>;
  list(): Promise<{ credentials: CredentialInfo[] }>;
  remove(options: { id: string }): Promise<void>;
  githubDeviceStart(options: { id: string; label: string; clientId: string; scopes: string[] }): Promise<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }>;
  githubDevicePoll(options: { flowId: string }): Promise<{
    status: 'pending' | 'slow_down' | 'authorized' | 'denied' | 'expired' | 'error';
    interval?: number;
    credential?: CredentialInfo;
    error?: string;
  }>;
}

export interface NativeHttpRequest {
  requestId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
  credentialId?: string;
  timeoutMs?: number;
  responseType?: 'text' | 'base64';
  maxBytes?: number;
}

export interface NativeHttpResponse {
  status: number;
  headers: Record<string, string>;
  url: string;
  bodyText?: string;
  bodyBase64?: string;
}

export interface TerminiaHttpPlugin {
  request(options: NativeHttpRequest): Promise<NativeHttpResponse>;
  download(options: {
    requestId: string;
    url: string;
    headers?: Record<string, string>;
    credentialId?: string;
    root: RootId;
    path: string;
    maxBytes?: number;
  }): Promise<{ status: number; size: number; sha256: string; contentType?: string }>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(
    eventName: 'downloadProgress',
    listener: (event: { requestId: string; received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const TerminiaFiles = registerPlugin<TerminiaFilesPlugin>('TerminiaFiles');
export const TerminiaVault = registerPlugin<TerminiaVaultPlugin>('TerminiaVault');
export const TerminiaHttp = registerPlugin<TerminiaHttpPlugin>('TerminiaHttp');

/** Converts a native plugin rejection ({ code, message }) into the shared error code space. */
export function nativeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
