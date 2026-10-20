import type { Server } from 'node:http';

export const AGENT_VERSION: string;
export const PROTOCOL: number;
export function certificateFingerprint(certPem: string | Buffer): string;
export interface AgentHandle {
  server: Server;
  fingerprint: string | null;
  listen(host: string, port: number): Promise<{ port: number; address: string }>;
  close(): Promise<void>;
}
export function createAgent(
  config: Record<string, unknown>,
  options: { powershell: { path: string; edition: string; version: string }; log?: (line: string) => void; allowLanHttp?: boolean },
): AgentHandle;
