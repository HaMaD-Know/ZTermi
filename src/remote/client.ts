import { TerminiaError } from '../core/errors';
import { redact } from '../core/redact';
import { parseJson, type Validator } from '../core/validate';
import type { HttpClient } from '../net/http';
import {
  PROTOCOL_VERSION,
  commandStartedSchema,
  completionSchema,
  execStartedSchema,
  infoSchema,
  pollSchema,
  sessionListSchema,
  sessionSchema,
  type HostInfo,
  type PollResponse,
} from './protocol';

export interface RemoteProfile {
  id: string;
  name: string;
  /** Origin of the agent, e.g. https://devbox.tailnet.ts.net:8765 */
  url: string;
  pinSha256?: string;
  credentialId: string;
  createdAt: number;
  lastConnectedAt?: number;
  /** Remote path of each Terminia project on this host (for dependency installs). */
  projectPaths: Record<string, string>;
}

/** HTTP client for one Terminia agent. The agent token is attached natively. */
export class RemoteHostClient {
  constructor(
    private readonly http: HttpClient,
    readonly profile: RemoteProfile,
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, validator: Validator<T> | null, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number; expect?: number[] } = {}): Promise<T> {
    const response = await this.http.request({
      url: `${this.profile.url}${path}`,
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentialId: this.profile.credentialId,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    const expect = options.expect ?? [200, 201, 202, 204];
    if (!expect.includes(response.status)) {
      let message = `HTTP ${response.status}`;
      try {
        message = (JSON.parse(response.text) as { error?: string }).error ?? message;
      } catch {
        // not JSON
      }
      message = redact(message);
      if (response.status === 401) throw new TerminiaError('AUTH_FAILED', `${this.profile.name} rejected the token.`, { hint: 'Run `remote token <profile>` to enter the current agent token.' });
      if (response.status === 429) throw new TerminiaError('RATE_LIMITED', `${this.profile.name} is temporarily refusing connections after failed sign-ins.`, { retryable: false });
      if (response.status === 404) throw new TerminiaError('NOT_FOUND', `${this.profile.name}: ${message}`);
      if (response.status === 409) throw new TerminiaError('CONFLICT', `${this.profile.name}: ${message}`);
      if (response.status === 400 || response.status === 403 || response.status === 413) throw new TerminiaError('INVALID_ARGUMENT', `${this.profile.name}: ${message}`);
      throw new TerminiaError('PROVIDER', `${this.profile.name}: ${message}`, { retryable: response.status >= 500 });
    }
    if (!validator) return undefined as T;
    return parseJson(validator, response.text, `response from ${this.profile.name}`);
  }

  async info(signal?: AbortSignal): Promise<HostInfo> {
    const info = await this.call('GET', '/v1/info', infoSchema, undefined, { signal });
    if (info.protocol !== PROTOCOL_VERSION) {
      throw new TerminiaError('UNSUPPORTED', `${this.profile.name} speaks protocol ${info.protocol}; this Terminia needs ${PROTOCOL_VERSION}.`, { hint: 'Update the Terminia agent on the host.' });
    }
    return info;
  }

  createSession(cwd?: string, signal?: AbortSignal) {
    return this.call('POST', '/v1/sessions', sessionSchema, { cwd: cwd || undefined }, { signal, timeoutMs: 30_000 });
  }

  listSessions(signal?: AbortSignal) {
    return this.call('GET', '/v1/sessions', sessionListSchema, undefined, { signal });
  }

  closeSession(id: string) {
    return this.call('DELETE', `/v1/sessions/${encodeURIComponent(id)}`, null, undefined, { expect: [204, 404] });
  }

  runCommand(sessionId: string, script: string, signal?: AbortSignal) {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/commands`, commandStartedSchema, { script }, { signal });
  }

  poll(sessionId: string, commandId: string, after: number, waitMs: number, signal?: AbortSignal): Promise<PollResponse> {
    return this.call(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}?after=${after}&wait=${waitMs}`,
      pollSchema,
      undefined,
      { signal, timeoutMs: waitMs + 15_000 },
    );
  }

  cancel(sessionId: string, commandId: string) {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}/cancel`, null, {});
  }

  complete(sessionId: string, input: string, cursor: number, signal?: AbortSignal) {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/complete`, completionSchema, { input, cursor }, { signal, timeoutMs: 8000 });
  }

  /** Structured execution: program + argument array, never a shell string. */
  exec(program: string, args: string[], cwd: string, signal?: AbortSignal) {
    return this.call('POST', '/v1/exec', execStartedSchema, { program, args, cwd }, { signal });
  }
}
