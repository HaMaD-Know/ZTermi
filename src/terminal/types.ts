import type { Services } from '../app/services';
import type { CompletionKind, OptionSpec, ParsedArgs, PositionalSpec } from './args';

/**
 * Where a command actually runs. Every command declares its target and the
 * terminal shows it next to the command, so nothing silently runs elsewhere.
 */
export type ExecutionTarget =
  | { kind: 'local'; detail?: string }
  | { kind: 'network'; service: string }
  | { kind: 'remote'; profile: string; host: string }
  | { kind: 'cloud'; provider: 'GitHub Actions'; runner: 'macOS' | 'Linux' | 'macOS or Linux'; purpose?: string };

export const LOCAL: ExecutionTarget = { kind: 'local' };

export function targetLabel(target: ExecutionTarget): string {
  switch (target.kind) {
    case 'local':
      return target.detail ? `Local iPad · ${target.detail}` : 'Local iPad';
    case 'network':
      return `Network · ${target.service}`;
    case 'remote':
      return `Remote PowerShell · ${target.profile}`;
    case 'cloud':
      return `${target.provider} · ${target.runner} builder${target.purpose ? ` · ${target.purpose}` : ''}`;
  }
}

export function targetKey(target: ExecutionTarget): string {
  return target.kind === 'remote' ? `remote:${target.profile}` : target.kind === 'cloud' ? `cloud:${target.runner}` : target.kind;
}

export type Stream = 'stdout' | 'stderr' | 'info' | 'warn' | 'success' | 'muted' | 'command';

export interface OutputSink {
  /** Standard output. Captured by pipes and > redirection. */
  write(text: string): void;
  writeln(text?: string): void;
  /** Standard error. */
  error(text: string): void;
  /** Status messages: shown in the terminal, never piped. */
  info(text: string): void;
  warn(text: string): void;
  success(text: string): void;
  muted(text: string): void;
  /** Writes an aligned table to standard output. */
  table(rows: string[][], headers?: string[]): void;
  /** A button in the terminal output (for example "Open in Builds"). Ignored when output is captured. */
  action(label: string, run: () => void | Promise<void>): void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Optional detail lines (file lists, destinations). */
  details?: string[];
  confirmLabel?: string;
  danger?: boolean;
}

export interface SessionApi {
  readonly id: string;
  cwd(): string;
  setCwd(path: string): void;
  history(): string[];
  clearScreen(): void;
  /** Switches the session into remote PowerShell mode. */
  enterRemote(profileId: string): Promise<void>;
  exitRemote(): Promise<void>;
  remoteProfile(): string | null;
}

export interface CommandContext {
  /** Words after the command path, before option parsing. */
  argv: string[];
  args: ParsedArgs;
  stdin: string | null;
  out: OutputSink;
  signal: AbortSignal;
  session: SessionApi;
  services: Services;
  spec: CommandSpec;
  /** For example ['terminia', 'ios', 'build']. */
  commandPath: string[];
  /** The command name exactly as typed (an alias such as 'dir' or 'Select-String'). */
  invokedAs: string;
}

export interface CompletionRequest {
  services: Services;
  session: SessionApi;
  spec: CommandSpec;
  /** The word being completed. */
  word: string;
  /** Completed words after the command path. */
  previous: string[];
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  summary: string;
  description?: string;
  usage?: string[];
  examples?: string[];
  options?: OptionSpec[];
  positionals?: PositionalSpec[];
  subcommands?: CommandSpec[];
  target: ExecutionTarget | ((args: ParsedArgs, services: Services) => ExecutionTarget);
  hidden?: boolean;
  /** Help topic group used by `help`. */
  group?: string;
  run?(ctx: CommandContext): Promise<number | void>;
  complete?(request: CompletionRequest): Promise<string[]> | string[];
}

export type { CompletionKind };
