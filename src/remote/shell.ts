import { TerminiaError, sleep as defaultSleep, toTerminiaError } from '../core/errors';
import type { CompletionResult } from '../terminal/completion';
import type { RemoteShellLike } from '../terminal/session';
import type { OutputSink } from '../terminal/types';
import type { RemoteHostClient } from './client';
import type { PollResponse } from './protocol';

export const EXIT_CANCELLED = 130;

/** Streams one remote command's output into a sink until it finishes. */
export async function followCommand(
  client: RemoteHostClient,
  sessionId: string,
  commandId: string,
  sink: OutputSink,
  signal: AbortSignal,
  options: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; onCwd?: (cwd: string) => void } = {},
): Promise<{ exitCode: number; result: NonNullable<PollResponse['result']> | null }> {
  const sleep = options.sleep ?? defaultSleep;
  let after = 0;
  let failures = 0;
  let cancelSent = false;
  const cancelDeadline = { at: 0 };
  const onAbort = () => {
    if (cancelSent) return;
    cancelSent = true;
    cancelDeadline.at = Date.now() + 15_000;
    sink.warn('Stopping the remote command…');
    void client.cancel(sessionId, commandId).catch((error) => sink.warn(`Could not send the stop request: ${toTerminiaError(error).message}`));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let response: PollResponse;
      try {
        // Long-poll; a separate signal so a Stop request does not abort the poll that will report the result.
        response = await client.poll(sessionId, commandId, after, cancelSent ? 2000 : 20_000);
        failures = 0;
      } catch (error) {
        const e = toTerminiaError(error);
        if (e.code === 'NOT_FOUND') {
          throw new TerminiaError('CONFLICT', `The remote session on ${client.profile.name} ended (the agent was restarted or the session timed out).`, {
            hint: 'Variables and the working directory of that session are gone. Run `remote connect` to start a new session.',
          });
        }
        if (e.code === 'AUTH_FAILED' || ++failures > 8) throw e;
        if (failures === 1) sink.warn(`Connection to ${client.profile.name} interrupted (${e.message}); retrying…`);
        await sleep(Math.min(15_000, 1000 * 2 ** failures));
        continue;
      }
      for (const chunk of response.chunks) {
        after = Math.max(after, chunk.seq);
        switch (chunk.stream) {
          case 'stdout':
          case 'information':
            sink.write(chunk.text);
            break;
          case 'stderr':
            sink.error(chunk.text.replace(/\n$/, ''));
            break;
          case 'warning':
            sink.warn(chunk.text.replace(/\n$/, ''));
            break;
          case 'system':
            sink.info(chunk.text.replace(/\n$/, ''));
            break;
          default:
            sink.muted(chunk.text.replace(/\n$/, ''));
        }
      }
      if (response.done) {
        const result = response.result ?? null;
        if (result?.cwd) options.onCwd?.(result.cwd);
        if (result?.truncated) sink.warn('Output was truncated by the agent (limit reached).');
        if (result?.error) sink.error(result.error);
        if (result?.cancelled) return { exitCode: EXIT_CANCELLED, result };
        const exitCode = result ? (result.exitCode ?? (result.success ? 0 : 1)) : 1;
        return { exitCode, result };
      }
      if (cancelSent && Date.now() > cancelDeadline.at) {
        sink.warn('The remote command did not stop in time; it may still be running on the host.');
        return { exitCode: EXIT_CANCELLED, result: null };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A persistent PowerShell session on a remote host, used by a terminal tab in remote mode. */
export class RemoteShell implements RemoteShellLike {
  private currentCwd: string | null;

  constructor(
    private readonly client: RemoteHostClient,
    private readonly sessionId: string,
    readonly host: string,
    cwd: string,
  ) {
    this.currentCwd = cwd;
  }

  get profileId(): string {
    return this.client.profile.id;
  }

  get profileName(): string {
    return this.client.profile.name;
  }

  cwd(): string | null {
    return this.currentCwd;
  }

  async run(script: string, sink: OutputSink, signal: AbortSignal): Promise<{ exitCode: number }> {
    const started = await this.client.runCommand(this.sessionId, script, signal);
    const { exitCode } = await followCommand(this.client, this.sessionId, started.id, sink, signal, { onCwd: (cwd) => (this.currentCwd = cwd) });
    return { exitCode };
  }

  async complete(input: string, cursor: number): Promise<CompletionResult> {
    const result = await this.client.complete(this.sessionId, input, cursor);
    return {
      start: result.replacementIndex,
      end: result.replacementIndex + result.replacementLength,
      candidates: result.matches.map((m) => ({ value: m.text, description: m.tooltip !== m.text ? m.tooltip : m.type, isDirectory: m.type === 'ProviderContainer' })),
    };
  }

  async close(): Promise<void> {
    await this.client.closeSession(this.sessionId);
  }
}
