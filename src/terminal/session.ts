import type { Services } from '../app/services';
import { toTerminiaError } from '../core/errors';
import { displayPath } from '../core/paths';
import { redact } from '../core/redact';
import { Emitter, newId } from '../core/util';
import { completeLocal, type CompletionResult } from './completion';
import { formatTable } from './help';
import { CommandHistory } from './history';
import type { Registry } from './registry';
import { EXIT, Shell } from './shell';
import { targetLabel, type ExecutionTarget, type OutputSink, type SessionApi, type Stream } from './types';

export interface OutputLine {
  stream: Stream;
  text: string;
  ts: number;
  action?: { label: string; run: () => void | Promise<void> };
}

export interface EntryTarget {
  command: string;
  label: string;
  kind: ExecutionTarget['kind'];
}

export interface TerminalEntry {
  id: string;
  input: string;
  cwd: string;
  prompt: string;
  mode: 'local' | 'remote';
  targets: EntryTarget[];
  lines: OutputLine[];
  /** Number of oldest lines dropped because the entry exceeded the line limit. */
  dropped: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  status: 'running' | 'done' | 'cancelled';
}

/** What the session needs from a remote PowerShell connection (implemented in src/remote). */
export interface RemoteShellLike {
  readonly profileId: string;
  readonly profileName: string;
  readonly host: string;
  cwd(): string | null;
  run(script: string, sink: OutputSink, signal: AbortSignal): Promise<{ exitCode: number }>;
  complete(input: string, cursor: number): Promise<CompletionResult>;
  close(): Promise<void>;
}

export interface SessionEvents extends Record<string, unknown> {
  start: TerminalEntry;
  line: { entry: TerminalEntry; line: OutputLine };
  end: TerminalEntry;
  cleared: undefined;
  state: undefined;
}

const MAX_LINES_PER_ENTRY = 20_000;
const MAX_ENTRIES = 300;

class EntrySink implements OutputSink {
  private pending = new Map<Stream, string>();

  constructor(
    private readonly entry: TerminalEntry,
    private readonly emit: (line: OutputLine) => void,
  ) {}

  private push(stream: Stream, text: string): void {
    const combined = (this.pending.get(stream) ?? '') + redact(text);
    const parts = combined.split(/\r?\n/);
    this.pending.set(stream, parts.pop() ?? '');
    for (const part of parts) this.line(stream, part);
  }

  private line(stream: Stream, text: string, action?: OutputLine['action']): void {
    const line: OutputLine = { stream, text, ts: Date.now(), action };
    this.entry.lines.push(line);
    if (this.entry.lines.length > MAX_LINES_PER_ENTRY) {
      const drop = this.entry.lines.length - MAX_LINES_PER_ENTRY;
      this.entry.lines.splice(0, drop);
      this.entry.dropped += drop;
    }
    this.emit(line);
  }

  flush(): void {
    for (const [stream, text] of this.pending) if (text) this.line(stream, text);
    this.pending.clear();
  }

  write(text: string): void {
    this.push('stdout', text);
  }
  writeln(text = ''): void {
    this.push('stdout', `${text}\n`);
  }
  error(text: string): void {
    this.push('stderr', text.endsWith('\n') ? text : `${text}\n`);
  }
  info(text: string): void {
    this.push('info', `${text}\n`);
  }
  warn(text: string): void {
    this.push('warn', `${text}\n`);
  }
  success(text: string): void {
    this.push('success', `${text}\n`);
  }
  muted(text: string): void {
    this.push('muted', `${text}\n`);
  }
  table(rows: string[][], headers?: string[]): void {
    this.push('stdout', `${formatTable(rows, headers)}\n`);
  }
  action(label: string, run: () => void | Promise<void>): void {
    this.line('info', '', { label, run });
  }
}

/** One terminal tab. Runs local command lines, or forwards them to a remote PowerShell host. */
export class TerminalSession extends Emitter<SessionEvents> implements SessionApi {
  readonly id = newId();
  title: string;
  entries: TerminalEntry[] = [];
  private currentDir: string;
  private remote: RemoteShellLike | null = null;
  private running: { entry: TerminalEntry; controller: AbortController } | null = null;
  private readonly shell: Shell;

  constructor(
    private readonly registry: Registry,
    private readonly services: Services,
    private readonly historyStore: CommandHistory,
    options: { title?: string; cwd?: string } = {},
  ) {
    super();
    this.title = options.title ?? 'Terminal';
    this.currentDir = options.cwd ?? services.vfs.home;
    this.shell = new Shell(registry, services);
  }

  cwd(): string {
    return this.currentDir;
  }

  setCwd(path: string): void {
    this.currentDir = path;
    this.emit('state', undefined);
  }

  history(): string[] {
    return this.historyStore.all();
  }

  get historyNavigator(): CommandHistory {
    return this.historyStore;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  runningEntry(): TerminalEntry | null {
    return this.running?.entry ?? null;
  }

  remoteProfile(): string | null {
    return this.remote?.profileId ?? null;
  }

  remoteInfo(): { name: string; host: string; cwd: string | null } | null {
    return this.remote ? { name: this.remote.profileName, host: this.remote.host, cwd: this.remote.cwd() } : null;
  }

  prompt(): string {
    if (this.remote) return `[${this.remote.profileName}] PS ${this.remote.cwd() ?? ''}>`;
    return `${displayPath(this.currentDir)} >`;
  }

  clearScreen(): void {
    this.entries = [];
    this.emit('cleared', undefined);
  }

  async enterRemote(profileId: string): Promise<void> {
    if (this.remote) await this.exitRemote();
    this.remote = await this.services.remote.openShell(profileId);
    this.emit('state', undefined);
  }

  async exitRemote(): Promise<void> {
    const remote = this.remote;
    this.remote = null;
    this.emit('state', undefined);
    await remote?.close().catch(() => undefined);
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.running.controller.abort();
    return true;
  }

  async complete(input: string, cursor: number): Promise<CompletionResult> {
    const trimmed = input.trimStart();
    if (this.remote && !trimmed.startsWith(':') && !/^terminia(\s|$)/i.test(trimmed)) {
      try {
        return await this.remote.complete(input, cursor);
      } catch {
        return { start: cursor, end: cursor, candidates: [] };
      }
    }
    if (this.remote && trimmed.startsWith(':')) {
      const offset = input.indexOf(':') + 1;
      const r = await completeLocal(input.slice(offset), cursor - offset, this.registry, this.services, this);
      return { ...r, start: r.start + offset, end: r.end + offset };
    }
    return completeLocal(input, cursor, this.registry, this.services, this);
  }

  /** Runs one input (possibly several lines). Resolves with the exit code. */
  async run(input: string): Promise<number> {
    if (this.running) throw new Error('A command is already running in this tab.');
    const trimmed = input.trim();
    this.historyStore.add(input);
    if (!trimmed) return EXIT.OK;

    const remote = this.remote;
    const forwardToRemote = !!remote && !trimmed.startsWith(':') && !/^terminia(\s|$)/i.test(trimmed) && !/^(exit|exit-pssession)$/i.test(trimmed);
    const entry: TerminalEntry = {
      id: newId(),
      input,
      cwd: remote ? (remote.cwd() ?? '') : this.currentDir,
      prompt: this.prompt(),
      mode: forwardToRemote ? 'remote' : 'local',
      targets: [],
      lines: [],
      dropped: 0,
      startedAt: Date.now(),
      status: 'running',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    const controller = new AbortController();
    this.running = { entry, controller };
    this.emit('start', entry);
    const sink = new EntrySink(entry, (line) => this.emit('line', { entry, line }));

    let code: number = EXIT.OK;
    try {
      if (remote && /^(exit|exit-pssession)$/i.test(trimmed)) {
        entry.targets.push({ command: 'exit', label: 'Local iPad', kind: 'local' });
        await this.exitRemote();
        sink.info(`Disconnected from ${remote.profileName}. Commands run locally again.`);
      } else if (forwardToRemote) {
        const target: ExecutionTarget = { kind: 'remote', profile: remote.profileName, host: remote.host };
        entry.targets.push({ command: 'PowerShell', label: targetLabel(target), kind: 'remote' });
        this.emit('state', undefined);
        code = (await remote.run(input, sink, controller.signal)).exitCode;
      } else {
        const local = trimmed.startsWith(':') ? input.slice(input.indexOf(':') + 1) : input;
        code = await this.shell.execute(local, {
          out: sink,
          signal: controller.signal,
          session: this,
          onCommand: (path, target) => {
            entry.targets.push({ command: path.join(' '), label: targetLabel(target), kind: target.kind });
            this.emit('state', undefined);
          },
        });
      }
    } catch (error) {
      const e = toTerminiaError(error);
      sink.error(e.message);
      if (e.hint) sink.info(e.hint);
      code = e.code === 'CANCELLED' ? EXIT.CANCELLED : EXIT.ERROR;
    } finally {
      sink.flush();
      entry.exitCode = controller.signal.aborted && code !== EXIT.OK ? EXIT.CANCELLED : code;
      entry.status = entry.exitCode === EXIT.CANCELLED ? 'cancelled' : 'done';
      entry.finishedAt = Date.now();
      this.running = null;
      this.emit('end', entry);
      this.emit('state', undefined);
    }
    return entry.exitCode ?? code;
  }

  /** Plain-text transcript of the session (for copy / export). */
  transcript(): string {
    return this.entries
      .map((e) => [`${e.prompt} ${e.input}`, ...e.lines.filter((l) => !l.action).map((l) => l.text)].join('\n'))
      .join('\n');
  }
}

export interface SessionsState {
  tabs: { title: string; cwd: string }[];
  history: string[];
}

/** Tabs plus the shared, persisted command history. */
export class SessionManager extends Emitter<{ changed: undefined; active: TerminalSession }> {
  readonly sessions: TerminalSession[] = [];
  private activeId: string | null = null;
  readonly history: CommandHistory;
  private counter = 0;

  constructor(
    private readonly registry: Registry,
    private readonly services: Services,
    initialHistory: string[] = [],
    private readonly persist: (state: SessionsState) => void = () => undefined,
  ) {
    super();
    this.history = new CommandHistory(initialHistory);
  }

  create(options: { title?: string; cwd?: string } = {}): TerminalSession {
    this.counter++;
    const session = new TerminalSession(this.registry, this.services, this.history, {
      title: options.title ?? (this.counter === 1 ? 'Terminal' : `Terminal ${this.counter}`),
      cwd: options.cwd,
    });
    session.on('end', () => this.save());
    session.on('state', () => this.save());
    this.sessions.push(session);
    this.activate(session.id);
    this.emit('changed', undefined);
    return session;
  }

  close(id: string): void {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index === -1) return;
    const [session] = this.sessions.splice(index, 1);
    session!.cancel();
    void session!.exitRemote();
    if (!this.sessions.length) this.create();
    else if (this.activeId === id) this.activate(this.sessions[Math.max(0, index - 1)]!.id);
    this.emit('changed', undefined);
    this.save();
  }

  activate(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    this.activeId = id;
    this.emit('active', session);
  }

  active(): TerminalSession {
    return this.sessions.find((s) => s.id === this.activeId) ?? this.sessions[0] ?? this.create();
  }

  private save(): void {
    this.persist({ tabs: this.sessions.map((s) => ({ title: s.title, cwd: s.cwd() })), history: this.history.all() });
  }
}
