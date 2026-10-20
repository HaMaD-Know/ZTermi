import { TerminiaError } from '../core/errors';
import { TerminiaVault, nativeErrorCode, type CredentialInfo, type CredentialKind, type TerminiaVaultPlugin } from './plugins';

/**
 * Credential storage.
 *
 * On iPad the secret is typed into a native secure field, stored in the iOS
 * Keychain (this-device-only, after first unlock) and only ever read by native
 * code, which attaches it to requests for the origins it was bound to. The
 * JavaScript side sees metadata only - there is deliberately no "get value"
 * method.
 *
 * In the browser preview there is no Keychain; MemoryVault keeps secrets in
 * memory for the current tab only (never localStorage) and says so.
 */

export interface PromptSecretOptions {
  id: string;
  label: string;
  kind: CredentialKind;
  title: string;
  message: string;
  placeholder?: string;
  allowedOrigins: string[];
  pinSha256?: string;
}

export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollStatus = 'pending' | 'slow_down' | 'authorized' | 'denied' | 'expired' | 'error';

export interface Vault {
  readonly storage: 'keychain' | 'memory';
  list(): Promise<CredentialInfo[]>;
  get(id: string): Promise<CredentialInfo | undefined>;
  promptSecret(options: PromptSecretOptions): Promise<CredentialInfo | null>;
  remove(id: string): Promise<void>;
  githubDeviceStart(options: { id: string; label: string; clientId: string; scopes: string[] }): Promise<DeviceFlowStart>;
  githubDevicePoll(flowId: string): Promise<{ status: DevicePollStatus; interval?: number; credential?: CredentialInfo; error?: string }>;
}

/** Checks that every origin is a bare origin, and HTTPS unless it is a local/private address. */
export function validateOrigins(origins: string[]): string[] {
  if (!origins.length) throw new TerminiaError('INVALID_ARGUMENT', 'A credential must be bound to at least one origin.');
  return origins.map((origin) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new TerminiaError('INVALID_ARGUMENT', `Not a valid origin: ${origin}`);
    }
    if (url.origin !== origin.replace(/\/$/, '')) throw new TerminiaError('INVALID_ARGUMENT', `Expected an origin without a path: ${origin}`);
    if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
      throw new TerminiaError('INVALID_ARGUMENT', `Plain HTTP is only allowed for local or private network addresses (${url.hostname}).`, {
        hint: 'Use HTTPS (for example `tailscale cert`) or connect over a private network.',
      });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TerminiaError('INVALID_ARGUMENT', `Unsupported scheme: ${url.protocol}`);
    return url.origin;
  });
}

/** Loopback, RFC 1918, CGNAT (100.64/10, used by Tailscale), link-local, and .local names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
  if (/^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function wrap(error: unknown): TerminiaError {
  if (error instanceof TerminiaError) return error;
  const code = nativeErrorCode(error);
  const message = (error as { message?: string })?.message ?? String(error);
  if (code === 'CANCELLED') return new TerminiaError('CANCELLED', message);
  if (code === 'UNAVAILABLE') return new TerminiaError('UNAVAILABLE', message);
  if (code === 'NETWORK') return new TerminiaError('NETWORK', message, { retryable: true });
  return new TerminiaError('INTERNAL', message, { cause: error });
}

export class NativeVault implements Vault {
  readonly storage = 'keychain' as const;

  constructor(private readonly plugin: TerminiaVaultPlugin = TerminiaVault) {}

  async list(): Promise<CredentialInfo[]> {
    try {
      return (await this.plugin.list()).credentials;
    } catch (error) {
      throw wrap(error);
    }
  }

  async get(id: string): Promise<CredentialInfo | undefined> {
    return (await this.list()).find((c) => c.id === id);
  }

  async promptSecret(options: PromptSecretOptions): Promise<CredentialInfo | null> {
    const allowedOrigins = validateOrigins(options.allowedOrigins);
    try {
      const result = await this.plugin.promptSecret({ ...options, allowedOrigins });
      return result.cancelled ? null : (result.credential ?? null);
    } catch (error) {
      throw wrap(error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.plugin.remove({ id });
    } catch (error) {
      throw wrap(error);
    }
  }

  async githubDeviceStart(options: { id: string; label: string; clientId: string; scopes: string[] }): Promise<DeviceFlowStart> {
    try {
      return await this.plugin.githubDeviceStart(options);
    } catch (error) {
      throw wrap(error);
    }
  }

  async githubDevicePoll(flowId: string) {
    try {
      return await this.plugin.githubDevicePoll({ flowId });
    } catch (error) {
      throw wrap(error);
    }
  }
}

export type SecretPrompter = (options: PromptSecretOptions) => Promise<string | null>;

interface MemoryEntry {
  info: CredentialInfo;
  value: string;
}

/** Browser-preview and test vault. Secrets exist only in this object's memory. */
export class MemoryVault implements Vault {
  readonly storage = 'memory' as const;
  private entries = new Map<string, MemoryEntry>();

  constructor(private prompter: SecretPrompter = async () => null) {}

  setPrompter(prompter: SecretPrompter): void {
    this.prompter = prompter;
  }

  async list(): Promise<CredentialInfo[]> {
    return [...this.entries.values()].map((e) => e.info);
  }

  async get(id: string): Promise<CredentialInfo | undefined> {
    return this.entries.get(id)?.info;
  }

  async promptSecret(options: PromptSecretOptions): Promise<CredentialInfo | null> {
    const allowedOrigins = validateOrigins(options.allowedOrigins);
    const value = (await this.prompter(options))?.trim();
    if (!value) return null;
    return this.store({ ...options, allowedOrigins }, value);
  }

  /** Stores a secret directly (tests, and the browser preview's own dialog). */
  store(options: Omit<PromptSecretOptions, 'title' | 'message'>, value: string): CredentialInfo {
    const info: CredentialInfo = {
      id: options.id,
      label: options.label,
      kind: detectKind(options.kind, value),
      allowedOrigins: validateOrigins(options.allowedOrigins),
      pinSha256: options.pinSha256,
      createdAt: Date.now(),
    };
    this.entries.set(options.id, { info, value });
    return info;
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async githubDeviceStart(): Promise<DeviceFlowStart> {
    throw new TerminiaError('UNAVAILABLE', 'GitHub device sign-in needs the iPad app.', {
      hint: "github.com's device-flow endpoints do not allow browser requests (no CORS). In the browser preview, use a token: `terminia github login --token`.",
    });
  }

  async githubDevicePoll(): Promise<{ status: DevicePollStatus }> {
    return { status: 'error' };
  }

  /** Used only by FetchHttpClient to attach the secret; never exposed to UI code. */
  resolveForOrigin(id: string, origin: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return entry.info.allowedOrigins.includes(origin) ? entry.value : undefined;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}

function detectKind(requested: CredentialKind, value: string): CredentialKind {
  if (!requested.startsWith('github')) return requested;
  if (value.startsWith('github_pat_')) return 'github-fine-grained';
  if (value.startsWith('ghp_')) return 'github-classic';
  if (value.startsWith('gho_')) return 'github-oauth';
  if (value.startsWith('ghu_')) return 'github-app-user';
  return requested;
}
