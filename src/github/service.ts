import { TerminiaError, sleep } from '../core/errors';
import { Emitter } from '../core/util';
import type { Platform } from '../platform';
import type { CredentialInfo } from '../platform/plugins';
import type { SettingsService } from '../settings/settings';
import { GITHUB_API, GitHubClient, encodePath } from './client';
import {
  branchListSchema,
  contentFileSchema,
  repoListSchema,
  repoSchema,
  secretListSchema,
  userSchema,
  workflowListSchema,
  type GitHubRepo,
  type GitHubUser,
  type GitHubWorkflow,
} from './schemas';

/**
 * GitHub connection: sign-in (OAuth device flow or a personal access token,
 * both stored in the iOS Keychain and bound to api.github.com), identity and
 * repository helpers used by builds, sync and the Settings screen.
 */

export const GITHUB_CREDENTIAL = 'github';
const API_ORIGIN = new URL(GITHUB_API).origin;

/** Scopes requested by the OAuth device flow (ignored by GitHub Apps, which use app permissions). */
export const OAUTH_SCOPES = ['repo', 'workflow'];

export interface GitHubStatus {
  connected: boolean;
  credential?: CredentialInfo;
  user?: GitHubUser;
  scopes?: string[];
  error?: string;
  checkedAt: number;
}

export class GitHubService extends Emitter<{ changed: GitHubStatus }> {
  private cached: GitHubStatus = { connected: false, checkedAt: 0 };
  private api: GitHubClient;

  constructor(
    private readonly platform: Platform,
    private readonly settings: SettingsService,
  ) {
    super();
    this.api = new GitHubClient({ http: platform.http, credentialId: GITHUB_CREDENTIAL });
  }

  client(): GitHubClient {
    return this.api;
  }

  lastStatus(): GitHubStatus {
    return this.cached;
  }

  async credential(): Promise<CredentialInfo | undefined> {
    return this.platform.vault.get(GITHUB_CREDENTIAL);
  }

  /** Checks the stored credential against GET /user. */
  async status(signal?: AbortSignal): Promise<GitHubStatus> {
    const credential = await this.credential();
    if (!credential) return this.publish({ connected: false, checkedAt: Date.now() });
    try {
      const response = await this.api.request('GET', '/user', { validator: userSchema, signal });
      const header = response.headers['x-oauth-scopes'];
      const scopes = header !== undefined ? header.split(',').map((s) => s.trim()).filter(Boolean) : credential.scopes;
      return this.publish({ connected: true, credential, user: response.data, scopes, checkedAt: Date.now() });
    } catch (error) {
      const e = error instanceof TerminiaError ? error : new TerminiaError('NETWORK', String(error));
      return this.publish({ connected: false, credential, error: e.message, checkedAt: Date.now() });
    }
  }

  /** Throws AUTH_REQUIRED unless a credential is stored. Does not hit the network. */
  async requireCredential(): Promise<CredentialInfo> {
    const credential = await this.credential();
    if (!credential) {
      throw new TerminiaError('AUTH_REQUIRED', 'GitHub is not connected.', {
        hint: 'Connect in Settings › Build Providers › GitHub, or run `terminia github login`.',
      });
    }
    return credential;
  }

  private publish(status: GitHubStatus): GitHubStatus {
    this.cached = status;
    this.emit('changed', status);
    return status;
  }

  /** Personal access token, typed into a native secure field (Keychain on iPad). */
  async loginWithToken(): Promise<GitHubStatus> {
    const credential = await this.platform.vault.promptSecret({
      id: GITHUB_CREDENTIAL,
      label: 'GitHub',
      kind: 'github-fine-grained',
      title: 'GitHub access token',
      message:
        'Paste a fine-grained personal access token with Actions, Contents and Workflows (read and write) and Metadata (read) for the repositories you build. ' +
        (this.platform.vault.storage === 'keychain' ? 'It is stored in the iOS Keychain' : 'It is kept in memory for this session') +
        ' and only sent to api.github.com.',
      placeholder: 'github_pat_…',
      allowedOrigins: [API_ORIGIN],
    });
    if (!credential) throw new TerminiaError('CANCELLED', 'Sign-in cancelled.');
    const status = await this.status();
    if (!status.connected) {
      await this.platform.vault.remove(GITHUB_CREDENTIAL);
      throw new TerminiaError('AUTH_FAILED', `GitHub did not accept the token: ${status.error ?? 'unknown error'}`);
    }
    return status;
  }

  /**
   * OAuth device flow, run natively: the user enters the code at
   * github.com/login/device and the resulting token goes straight into the
   * Keychain. Needs the client id of a GitHub OAuth App or GitHub App with
   * device flow enabled (Settings › Build Providers › GitHub).
   */
  async loginWithDevice(onCode: (code: { userCode: string; verificationUri: string; expiresIn: number }) => void, signal?: AbortSignal): Promise<GitHubStatus> {
    const clientId = this.settings.get().githubClientId;
    if (!clientId) {
      throw new TerminiaError('CONFIG_REQUIRED', 'No GitHub OAuth client id is configured.', {
        hint: 'Register an OAuth App (or GitHub App) with device flow enabled and enter its client id in Settings › Build Providers › GitHub - see docs/GITHUB-SETUP.md. Or use a token: `terminia github login --token`.',
      });
    }
    const start = await this.platform.vault.githubDeviceStart({ id: GITHUB_CREDENTIAL, label: 'GitHub', clientId, scopes: OAUTH_SCOPES });
    onCode({ userCode: start.userCode, verificationUri: start.verificationUri, expiresIn: start.expiresIn });
    let interval = Math.max(5, start.interval) * 1000;
    const deadline = Date.now() + start.expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(interval, signal);
      const result = await this.platform.vault.githubDevicePoll(start.flowId);
      if (result.status === 'authorized') return this.status();
      if (result.status === 'slow_down') interval = Math.max(interval + 5000, (result.interval ?? 0) * 1000);
      if (result.status === 'denied') throw new TerminiaError('AUTH_FAILED', 'Access was denied on github.com.');
      if (result.status === 'expired') break;
      if (result.status === 'error') throw new TerminiaError('AUTH_FAILED', result.error ?? 'GitHub sign-in failed.');
    }
    throw new TerminiaError('TIMEOUT', 'The sign-in code expired. Start again.');
  }

  async logout(): Promise<void> {
    await this.platform.vault.remove(GITHUB_CREDENTIAL);
    this.publish({ connected: false, checkedAt: Date.now() });
  }

  // --- Repository helpers ---

  async repos(signal?: AbortSignal): Promise<GitHubRepo[]> {
    await this.requireCredential();
    return this.api.paginate('/user/repos', repoListSchema, (page) => page, { query: { sort: 'updated', affiliation: 'owner,collaborator,organization_member' }, maxPages: 5, signal });
  }

  async repo(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepo> {
    await this.requireCredential();
    return this.api.get(`/repos/${owner}/${repo}`, repoSchema, { signal });
  }

  async branches(owner: string, repo: string, signal?: AbortSignal): Promise<string[]> {
    const list = await this.api.paginate(`/repos/${owner}/${repo}/branches`, branchListSchema, (page) => page, { maxPages: 5, signal });
    return list.map((b) => b.name);
  }

  async workflows(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubWorkflow[]> {
    const page = await this.api.get(`/repos/${owner}/${repo}/actions/workflows`, workflowListSchema, { query: { per_page: 100 }, signal });
    return page.workflows;
  }

  /** Blob sha of a file on a ref, or null when it does not exist there. */
  async fileSha(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const file = await this.api.get(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, contentFileSchema, { query: { ref }, signal, retries: 1 });
      return file.type === 'file' ? file.sha : null;
    } catch (error) {
      if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * Names of the Actions secrets defined for the repository (values are never
   * readable). Returns null when the token may not list secrets - then the
   * workflow itself checks for signing material and fails clearly.
   */
  async secretNames(owner: string, repo: string, signal?: AbortSignal): Promise<Set<string> | null> {
    try {
      const page = await this.api.get(`/repos/${owner}/${repo}/actions/secrets`, secretListSchema, { query: { per_page: 100 }, signal, retries: 1 });
      return new Set(page.secrets.map((s) => s.name));
    } catch (error) {
      if (error instanceof TerminiaError && (error.code === 'PERMISSION_DENIED' || error.code === 'NOT_FOUND')) return null;
      throw error;
    }
  }
}
