// PowerShell sessions: one host process (host/terminia-host.ps1) per session.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'terminia-host.ps1');
const MARKER = '\u001eTERMINIA:';
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const KEEP_COMMANDS = 5;

/** Finds PowerShell: the configured path, else pwsh (7+), else Windows PowerShell 5.1. */
export function resolvePowerShell(configured = 'auto') {
  const candidates = configured && configured !== 'auto' ? [configured] : process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSEdition + " " + $PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    if (probe.status === 0 && probe.stdout.trim()) {
      const [edition, version] = probe.stdout.trim().split(/\s+/);
      return { path: candidate, edition, version };
    }
  }
  throw new Error(`PowerShell was not found (${candidates.join(', ')}). Install PowerShell 7 or set "powershell" in the agent configuration.`);
}

class Command {
  constructor(id) {
    this.id = id;
    this.chunks = [];
    this.seq = 0;
    this.bytes = 0;
    this.truncated = false;
    this.done = false;
    this.result = null;
    this.waiters = new Set();
    this.startedAt = Date.now();
  }

  push(stream, text) {
    if (this.done || !text) return;
    if (this.bytes + text.length > MAX_COMMAND_BYTES) {
      if (!this.truncated) {
        this.truncated = true;
        this.chunks.push({ seq: ++this.seq, stream: 'system', text: '[output truncated: limit reached]\n' });
      }
      return;
    }
    this.bytes += text.length;
    this.chunks.push({ seq: ++this.seq, stream, text });
    this.notify();
  }

  finish(result) {
    if (this.done) return;
    this.done = true;
    this.result = { ...result, truncated: this.truncated };
    this.notify();
  }

  notify() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  /** Long-poll: resolves when there is output after `after`, the command finished, or `waitMs` elapsed. */
  wait(after, waitMs) {
    const ready = () => this.done || this.chunks.some((c) => c.seq > after);
    if (ready() || waitMs <= 0) return Promise.resolve(this.snapshot(after));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(this.snapshot(after));
      }, waitMs);
      const wake = () => {
        clearTimeout(timer);
        // Coalesce bursts of output into one response.
        setTimeout(() => resolve(this.snapshot(after)), 40);
      };
      this.waiters.add(wake);
    });
  }

  snapshot(after) {
    return { chunks: this.chunks.filter((c) => c.seq > after), done: this.done, result: this.done ? this.result : undefined };
  }
}

export class Session extends EventEmitter {
  constructor({ powershell, cwd, width = 120, log }) {
    super();
    this.id = randomUUID();
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.commands = new Map();
    this.current = null;
    this.closed = false;
    this.completions = new Map();
    this.log = log;
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass');
    args.push('-File', HOST_SCRIPT);
    this.child = spawn(powershell, args, {
      cwd,
      env: { ...process.env, TERMINIA_CWD: cwd, TERMINIA_WIDTH: String(width) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.ready = new Promise((resolve, reject) => {
      this.once('ready', resolve);
      this.once('failed', reject);
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      if (this.current) this.current.push('stderr', `${line}\n`);
      else if (line.trim()) this.log?.(`[session ${this.id.slice(0, 8)}] ${line}`);
    });
    this.child.on('error', (error) => this.fail(`Could not start PowerShell: ${error.message}`));
    this.child.on('exit', (code) => this.fail(`The PowerShell host exited (code ${code}).`));
  }

  onLine(line) {
    if (!line.startsWith(MARKER)) {
      // Output a native program wrote straight to the inherited handle.
      if (this.current) this.current.push('stdout', `${line}\n`);
      return;
    }
    let message;
    try {
      message = JSON.parse(line.slice(MARKER.length));
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.cwd = message.cwd || this.cwd;
        this.powershell = { edition: message.edition, version: message.version };
        this.emit('ready', message);
        break;
      case 'out':
        this.commands.get(message.id)?.push(message.stream, message.text);
        break;
      case 'done': {
        const command = this.commands.get(message.id);
        if (message.cwd) this.cwd = message.cwd;
        command?.finish({
          success: !!message.success,
          exitCode: typeof message.exitCode === 'number' ? message.exitCode : null,
          cwd: message.cwd || this.cwd,
          durationMs: message.durationMs ?? Date.now() - (command?.startedAt ?? Date.now()),
          cancelled: !!message.cancelled,
          error: message.error ?? null,
        });
        if (this.current?.id === message.id) this.current = null;
        this.lastUsedAt = Date.now();
        break;
      }
      case 'completion': {
        const resolve = this.completions.get(message.id);
        this.completions.delete(message.id);
        resolve?.({ replacementIndex: message.replacementIndex, replacementLength: message.replacementLength, matches: Array.isArray(message.matches) ? message.matches : [] });
        break;
      }
      case 'log':
        this.log?.(`[session ${this.id.slice(0, 8)}] ${message.text}`);
        break;
    }
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    this.current?.push('system', `${reason}\n`);
    this.current?.finish({ success: false, exitCode: null, cwd: this.cwd, durationMs: 0, cancelled: false, error: reason });
    this.current = null;
    for (const resolve of this.completions.values()) resolve({ replacementIndex: 0, replacementLength: 0, matches: [] });
    this.completions.clear();
    this.emit('failed', new Error(reason));
    this.emit('closed');
  }

  get busy() {
    return this.current !== null && !this.current.done;
  }

  send(message) {
    if (this.closed) throw new Error('The session is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  start(kind, payload) {
    if (this.busy) {
      const error = new Error('A command is already running in this session.');
      error.status = 409;
      throw error;
    }
    const command = new Command(randomUUID());
    this.commands.set(command.id, command);
    while (this.commands.size > KEEP_COMMANDS) this.commands.delete(this.commands.keys().next().value);
    this.current = command;
    this.lastUsedAt = Date.now();
    this.send({ type: kind, id: command.id, ...payload });
    return command;
  }

  cancel(commandId) {
    if (this.current?.id !== commandId || this.current.done) return false;
    this.send({ type: 'cancel', id: commandId });
    const command = this.current;
    // If PowerShell cannot stop the pipeline (a blocking native call), end the whole session.
    setTimeout(() => {
      if (!command.done) {
        command.push('system', 'The command did not stop; the PowerShell session was terminated.\n');
        this.close();
      }
    }, 10_000).unref();
    return true;
  }

  complete(input, cursor) {
    if (this.busy || this.closed) return Promise.resolve({ replacementIndex: cursor, replacementLength: 0, matches: [] });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.completions.set(id, resolve);
      this.send({ type: 'complete', id, input, cursor });
      setTimeout(() => {
        if (this.completions.delete(id)) resolve({ replacementIndex: cursor, replacementLength: 0, matches: [] });
      }, 5000).unref();
    });
  }

  /** Asks the host to exit, kills it after 1.5 s, and resolves when the process is gone. */
  close() {
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once('exit', () => resolve());
    });
    if (!this.closed) {
      try {
        this.send({ type: 'exit' });
      } catch {
        // already gone
      }
      setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill();
      }, 1500).unref();
      this.fail('The session was closed.');
    }
    return exited;
  }
}

export class SessionManager {
  constructor({ powershell, maxSessions, idleMinutes, log }) {
    this.powershell = powershell;
    this.maxSessions = maxSessions;
    this.idleMs = idleMinutes * 60_000;
    this.log = log;
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async create(cwd, options = {}) {
    if (this.sessions.size >= this.maxSessions) {
      const error = new Error(`The agent allows ${this.maxSessions} sessions; close one first.`);
      error.status = 409;
      throw error;
    }
    const session = new Session({ powershell: this.powershell, cwd, log: this.log });
    session.transient = !!options.transient;
    this.sessions.set(session.id, session);
    session.on('closed', () => this.sessions.delete(session.id));
    try {
      await Promise.race([session.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('PowerShell did not start within 30 seconds.')), 30_000).unref())]);
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()];
  }

  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      const idle = now - session.lastUsedAt;
      if (!session.busy && (idle > this.idleMs || (session.transient && idle > 120_000))) {
        this.log?.(`Closing idle session ${session.id.slice(0, 8)}`);
        session.close();
      }
    }
  }

  closeAll() {
    clearInterval(this.sweeper);
    return Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
