import { TerminiaError } from '../core/errors';
import { v } from '../core/validate';
import { Emitter, newId } from '../core/util';
import type { Platform } from '../platform';
import { JsonDocument } from '../platform/kv';
import { isPrivateHost, validateOrigins } from '../platform/vault';
import type { OutputSink } from '../terminal/types';
import { RemoteHostClient, type RemoteProfile } from './client';
import type { HostInfo } from './protocol';
import { RemoteShell, followCommand } from './shell';

const profilesSchema = v.array(
  v.object({
    id: v.string(),
    name: v.string(),
    url: v.string(),
    pinSha256: v.optional(v.string()),
    credentialId: v.string(),
    createdAt: v.number(),
    lastConnectedAt: v.optional(v.number()),
    projectPaths: v.withDefault(v.record(v.string()), {}),
  }),
  { max: 50 },
);

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

/**
 * Connection profiles for remote PowerShell hosts. A profile holds the
 * agent's origin and optional certificate fingerprint; the token lives in the
 * vault, bound to that origin, so it can never be sent anywhere else.
 */
export class RemoteService extends Emitter<{ changed: undefined }> {
  private list: RemoteProfile[] = [];
  private readonly doc: JsonDocument<RemoteProfile[]>;

  constructor(private readonly platform: Platform) {
    super();
    this.doc = new JsonDocument(platform.kv, 'terminia.remote.profiles', profilesSchema, () => []);
  }

  async init(): Promise<void> {
    this.list = await this.doc.load();
  }

  async profiles(): Promise<RemoteProfile[]> {
    return [...this.list];
  }

  find(ref: string): RemoteProfile | undefined {
    return this.list.find((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase());
  }

  require(ref: string | undefined): RemoteProfile {
    if (!ref) {
      if (this.list.length === 1) return this.list[0]!;
      throw new TerminiaError('INVALID_ARGUMENT', this.list.length ? 'Name the remote host to use.' : 'No remote hosts are configured.', {
        hint: this.list.length ? `Profiles: ${this.list.map((p) => p.name).join(', ')}` : 'Add one with `remote add <name> <url>` (see docs/REMOTE-HOST.md).',
      });
    }
    const profile = this.find(ref);
    if (!profile) throw new TerminiaError('NOT_FOUND', `No remote host named '${ref}'.`, { hint: 'List them with `remote list`.' });
    return profile;
  }

  private async save(): Promise<void> {
    await this.doc.save(this.list);
    this.emit('changed', undefined);
  }

  client(profile: RemoteProfile): RemoteHostClient {
    return new RemoteHostClient(this.platform.http, profile);
  }

  /** Validates the URL, then asks for the agent token in a native secure field. */
  async add(name: string, url: string, options: { pinSha256?: string } = {}): Promise<RemoteProfile> {
    if (!PROFILE_NAME.test(name)) throw new TerminiaError('INVALID_ARGUMENT', 'Profile names use letters, digits, dot, dash and underscore.');
    if (this.find(name)) throw new TerminiaError('EXISTS', `A remote host named '${name}' already exists.`);
    const [origin] = validateOrigins([url.replace(/\/+$/, '')]);
    const pin = options.pinSha256?.replace(/[:\s]/g, '').toLowerCase();
    if (pin && !/^[0-9a-f]{64}$/.test(pin)) throw new TerminiaError('INVALID_ARGUMENT', 'The certificate fingerprint must be a SHA-256 hex value (64 characters, colons allowed).');
    if (pin && !origin!.startsWith('https:')) throw new TerminiaError('INVALID_ARGUMENT', 'Certificate pinning needs an https:// URL.');
    const id = newId();
    const profile: RemoteProfile = { id, name, url: origin!, pinSha256: pin, credentialId: `remote:${id}`, createdAt: Date.now(), projectPaths: {} };
    await this.promptToken(profile);
    this.list.push(profile);
    await this.save();
    return profile;
  }

  async promptToken(profile: RemoteProfile): Promise<void> {
    const host = new URL(profile.url);
    const credential = await this.platform.vault.promptSecret({
      id: profile.credentialId,
      label: `Remote host ${profile.name}`,
      kind: 'remote-agent',
      title: `Token for ${profile.name}`,
      message: `Paste the token printed by \`terminia-agent init\` on ${host.host}. It is stored ${this.platform.vault.storage === 'keychain' ? 'in the iOS Keychain' : 'in memory for this session'} and only sent to ${profile.url}${profile.pinSha256 ? ' (certificate pinned)' : ''}.${host.protocol === 'http:' && isPrivateHost(host.hostname) ? ' Warning: plain HTTP is only encrypted if the network itself is (for example Tailscale).' : ''}`,
      placeholder: 'tma_…',
      allowedOrigins: [profile.url],
      pinSha256: profile.pinSha256,
    });
    if (!credential) throw new TerminiaError('CANCELLED', 'No token entered.');
  }

  async remove(ref: string): Promise<void> {
    const profile = this.require(ref);
    await this.platform.vault.remove(profile.credentialId);
    this.list = this.list.filter((p) => p.id !== profile.id);
    await this.save();
  }

  async setProjectPath(ref: string, project: string, remotePath: string): Promise<void> {
    const profile = this.require(ref);
    if (!remotePath.trim() || /[\r\n\0]/.test(remotePath)) throw new TerminiaError('INVALID_ARGUMENT', 'Invalid remote path.');
    profile.projectPaths[project] = remotePath.trim();
    await this.save();
  }

  async test(ref: string, signal?: AbortSignal): Promise<HostInfo> {
    const profile = this.require(ref);
    const info = await this.client(profile).info(signal);
    profile.lastConnectedAt = Date.now();
    await this.save();
    return info;
  }

  async openShell(ref: string): Promise<RemoteShell> {
    const profile = this.require(ref);
    const client = this.client(profile);
    const info = await client.info();
    const session = await client.createSession();
    profile.lastConnectedAt = Date.now();
    await this.save();
    return new RemoteShell(client, session.id, info.hostname, session.cwd);
  }

  /** Runs `program args...` on the host in `cwd` (structured, no shell string) and streams output. */
  async exec(ref: string, program: string, args: string[], cwd: string, sink: OutputSink, signal: AbortSignal): Promise<number> {
    const profile = this.require(ref);
    const client = this.client(profile);
    const started = await client.exec(program, args, cwd, signal);
    try {
      return (await followCommand(client, started.sessionId, started.commandId, sink, signal)).exitCode;
    } finally {
      await client.closeSession(started.sessionId).catch(() => undefined);
    }
  }
}
