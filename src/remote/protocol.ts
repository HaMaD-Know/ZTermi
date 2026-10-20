import { v, type Infer } from '../core/validate';

/**
 * Terminia remote-host protocol, version 1 (see docs/REMOTE-PROTOCOL.md).
 * JSON over HTTPS (or HTTP on private networks) with a bearer token, served by
 * agent/terminia-agent.mjs, which runs commands in a real PowerShell runspace.
 */
export const PROTOCOL_VERSION = 1;

export const infoSchema = v.object({
  protocol: v.number(),
  agent: v.string(),
  version: v.string(),
  hostname: v.string(),
  platform: v.string(),
  powershell: v.object({ edition: v.string(), version: v.string() }),
  roots: v.withDefault(v.array(v.string()), []),
  exec: v.withDefault(v.array(v.string()), []),
  sessions: v.object({ max: v.number(), active: v.number() }),
  tls: v.withDefault(v.boolean(), false),
});
export type HostInfo = Infer<typeof infoSchema>;

export const sessionSchema = v.object({ id: v.string(), cwd: v.string(), createdAt: v.number() });
export const sessionListSchema = v.object({
  sessions: v.array(v.object({ id: v.string(), cwd: v.string(), busy: v.boolean(), createdAt: v.number(), lastUsedAt: v.number() })),
});

export const commandStartedSchema = v.object({ id: v.string() });
export const execStartedSchema = v.object({ sessionId: v.string(), commandId: v.string() });

export const STREAMS = ['stdout', 'stderr', 'warning', 'verbose', 'information', 'debug', 'system'] as const;
export type RemoteStream = (typeof STREAMS)[number];

export const pollSchema = v.object({
  chunks: v.array(v.object({ seq: v.number(), stream: v.oneOfOr(STREAMS, 'stdout'), text: v.string() }), { max: 100_000 }),
  done: v.boolean(),
  result: v.optional(
    v.object({
      success: v.boolean(),
      exitCode: v.nullable(v.number()),
      cwd: v.string(),
      durationMs: v.number(),
      cancelled: v.withDefault(v.boolean(), false),
      truncated: v.withDefault(v.boolean(), false),
      error: v.nullable(v.string()),
    }),
  ),
});
export type PollResponse = Infer<typeof pollSchema>;

export const completionSchema = v.object({
  replacementIndex: v.number(),
  replacementLength: v.number(),
  matches: v.array(v.object({ text: v.string(), type: v.withDefault(v.string(), ''), tooltip: v.withDefault(v.string(), '') }), { max: 2000 }),
});
