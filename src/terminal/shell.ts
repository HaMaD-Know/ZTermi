import type { Services } from '../app/services';
import { isAbortError, toTerminiaError } from '../core/errors';
import { redact } from '../core/redact';
import { resolvePath } from '../core/paths';
import { suggest } from '../core/util';
import { parseArgs } from './args';
import { commandHelp, formatTable } from './help';
import type { Registry } from './registry';
import { parseScript, type Pipeline, type SimpleCommand } from './tokenizer';
import type { CommandContext, ExecutionTarget, OutputSink, SessionApi } from './types';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, UNSUPPORTED: 126, NOT_FOUND: 127, CANCELLED: 130 } as const;

export interface ExecEnv {
  out: OutputSink;
  signal: AbortSignal;
  session: SessionApi;
  /** Called before each command runs, with its resolved execution target. */
  onCommand?: (path: string[], target: ExecutionTarget) => void;
}

/** Tools people type out of habit that do not exist on iPad, with what to use instead. */
const UNAVAILABLE_TOOLS: Record<string, string> = {
  npm: 'Node.js and npm are not available on iPad. Manage packages with `terminia deps` (installs run on GitHub Actions or your remote host), or run npm on a remote host (`remote connect <profile>`).',
  npx: 'Node.js is not available on iPad. Run it on a remote host (`remote connect <profile>`), or in a build workflow.',
  node: 'Node.js is not available on iPad. Run it on a remote host (`remote connect <profile>`).',
  pnpm: 'pnpm is not available on iPad. Use `terminia deps` or a remote host.',
  yarn: 'Yarn is not available on iPad. Use `terminia deps` or a remote host.',
  python: 'Terminia does not embed a Python interpreter. Run Python on a remote host (`remote connect <profile>`), or use `terminia deps` for pip packages.',
  python3: 'Terminia does not embed a Python interpreter. Run Python on a remote host (`remote connect <profile>`).',
  pip: 'pip is not available on iPad. Use `terminia deps` (installs run on GitHub Actions or your remote host).',
  pip3: 'pip is not available on iPad. Use `terminia deps`.',
  git: 'There is no git CLI on iPad. Terminia talks to GitHub directly: `terminia git status`, `terminia git sync`. For other git commands use a remote host.',
  xcodebuild: 'Xcode does not run on iPad. iOS builds run on a GitHub Actions macOS runner: `terminia ios build`.',
  xcrun: 'Xcode does not run on iPad. Use `terminia ios build`.',
  pod: 'CocoaPods runs on the macOS builder during `terminia ios build`, or via `terminia deps install --ecosystem cocoapods`.',
  swift: 'The Swift toolchain does not run on iPad. Use `terminia ios build`.',
  gradle: 'Gradle runs on the Android builder: `terminia android build`.',
  gradlew: 'Gradle runs on the Android builder: `terminia android build`.',
  './gradlew': 'Gradle runs on the Android builder: `terminia android build`.',
  java: 'There is no JVM on iPad. Android builds run on GitHub Actions: `terminia android build`.',
  adb: 'adb is not available on iPad. Download the APK with `terminia android download` and install it from an Android device.',
  powershell: 'PowerShell runs on a remote host: `remote connect <profile>` (see `help remote`).',
  pwsh: 'PowerShell runs on a remote host: `remote connect <profile>` (see `help remote`).',
  cmd: 'cmd.exe is not available on iPad. Connect a remote Windows host: `remote connect <profile>`.',
  bash: 'There is no Unix shell on iPad. Connect a remote host: `remote connect <profile>`.',
  sh: 'There is no Unix shell on iPad. Connect a remote host: `remote connect <profile>`.',
  ssh: 'SSH is not available. Terminia connects to remote hosts through the Terminia agent: `help remote`.',
  sudo: 'There is no administrator account or system package manager on iPad.',
  brew: 'There is no system package manager on iPad.',
  apt: 'There is no system package manager on iPad.',
  'apt-get': 'There is no system package manager on iPad.',
  code: 'Open files in Terminia\'s editor with `edit <file>`.',
  vim: 'Open files in Terminia\'s editor with `edit <file>`.',
  nano: 'Open files in Terminia\'s editor with `edit <file>`.',
};

const POWERSHELL_VERBS = /^(get|set|new|remove|add|clear|copy|move|rename|start|stop|restart|invoke|import|export|install|uninstall|update|test|write|read|out|select|where|foreach|sort|measure|format|convertto|convertfrom|enter|exit|connect|disconnect|enable|disable|register|unregister|wait|push|pop|resolve|split|join|compare|group|tee|find|save|show|use|send|receive)-[a-z]/i;

class CaptureSink implements OutputSink {
  stdout = '';
  stderr = '';

  constructor(
    private readonly inner: OutputSink,
    private readonly mode: { stdout: boolean; stderr: 'terminal' | 'capture' | 'merge' },
  ) {}

  write(text: string): void {
    if (this.mode.stdout) this.stdout += text;
    else this.inner.write(text);
  }
  writeln(text = ''): void {
    this.write(`${text}\n`);
  }
  error(text: string): void {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    if (this.mode.stderr === 'merge') this.write(line);
    else if (this.mode.stderr === 'capture') this.stderr += line;
    else this.inner.error(text);
  }
  info(text: string): void {
    this.inner.info(text);
  }
  warn(text: string): void {
    this.inner.warn(text);
  }
  success(text: string): void {
    this.inner.success(text);
  }
  muted(text: string): void {
    this.inner.muted(text);
  }
  table(rows: string[][], headers?: string[]): void {
    if (this.mode.stdout) this.stdout += `${formatTable(rows, headers)}\n`;
    else this.inner.table(rows, headers);
  }
  action(label: string, run: () => void | Promise<void>): void {
    if (!this.mode.stdout) this.inner.action(label, run);
  }
}

/** Executes local command lines: sequences (; && ||), pipelines and redirections. */
export class Shell {
  constructor(
    private readonly registry: Registry,
    private readonly services: Services,
  ) {}

  async execute(input: string, env: ExecEnv): Promise<number> {
    let script;
    try {
      script = parseScript(input);
    } catch (error) {
      return this.report(error, env.out, ['terminia']);
    }
    let status: number = EXIT.OK;
    for (const item of script.items) {
      if (env.signal.aborted) return EXIT.CANCELLED;
      if (item.connector === '&&' && status !== 0) continue;
      if (item.connector === '||' && status === 0) continue;
      status = await this.runPipeline(item.pipeline, env);
      if (status === EXIT.CANCELLED) return status;
    }
    return status;
  }

  private async runPipeline(pipeline: Pipeline, env: ExecEnv): Promise<number> {
    let stdin: string | null = null;
    let status: number = EXIT.OK;
    for (let i = 0; i < pipeline.commands.length; i++) {
      const command = pipeline.commands[i]!;
      const isLast = i === pipeline.commands.length - 1;
      const stdoutFile = command.redirects.find((r) => r.op === '>' || r.op === '>>');
      const stderrFile = command.redirects.find((r) => r.op === '2>' || r.op === '2>>');
      const merge = command.redirects.some((r) => r.op === '2>&1');
      const capture = !isLast || !!stdoutFile;
      const sink =
        capture || stderrFile || merge
          ? new CaptureSink(env.out, { stdout: capture, stderr: merge ? 'merge' : stderrFile ? 'capture' : 'terminal' })
          : null;
      status = await this.runCommand(command, stdin, { ...env, out: sink ?? env.out });
      if (status === EXIT.CANCELLED) return status;
      if (sink) {
        try {
          if (stdoutFile?.target) await this.writeRedirect(stdoutFile.target, sink.stdout, stdoutFile.op === '>>', env);
          if (stderrFile?.target) await this.writeRedirect(stderrFile.target, sink.stderr, stderrFile.op === '2>>', env);
        } catch (error) {
          return this.report(error, env.out, ['redirect']);
        }
        stdin = stdoutFile ? '' : sink.stdout;
      } else stdin = null;
    }
    return status;
  }

  private async writeRedirect(target: string, text: string, append: boolean, env: ExecEnv): Promise<void> {
    const path = resolvePath(env.session.cwd(), target);
    let content = text;
    if (append && (await this.services.vfs.exists(path))) content = (await this.services.vfs.readText(path)).text + text;
    await this.services.vfs.writeText(path, content);
  }

  private async runCommand(command: SimpleCommand, stdin: string | null, env: ExecEnv): Promise<number> {
    const resolved = this.registry.resolve(command.argv);
    const name = command.argv[0]!;
    if (!resolved) return this.notFound(name, env.out);
    const { spec, path, rest } = resolved;

    const restIndex = rest.indexOf('--');
    const flags = restIndex === -1 ? rest : rest.slice(0, restIndex);
    if (flags.some((a) => a === '--help' || a === '-h' || a === '-?')) {
      env.out.writeln(commandHelp(spec, path, this.services));
      return EXIT.OK;
    }
    if (!spec.run) {
      if (rest.length) {
        const subs = (spec.subcommands ?? []).filter((s) => !s.hidden).map((s) => s.name);
        const hint = suggest(rest[0]!, subs);
        env.out.error(`${path.join(' ')}: unknown command '${rest[0]}'.${hint ? ` Did you mean '${hint}'?` : ''}`);
        env.out.info(`Run '${path.join(' ')} --help' to see the available commands.`);
        return EXIT.USAGE;
      }
      env.out.writeln(commandHelp(spec, path, this.services));
      return EXIT.OK;
    }

    let args;
    try {
      args = parseArgs(rest, spec.options, spec.positionals);
    } catch (error) {
      const code = this.report(error, env.out, path);
      env.out.info(`Usage: run '${path.join(' ')} --help'.`);
      return code === EXIT.ERROR ? EXIT.USAGE : code;
    }

    let target: ExecutionTarget;
    try {
      target = typeof spec.target === 'function' ? spec.target(args, this.services) : spec.target;
    } catch (error) {
      return this.report(error, env.out, path);
    }
    env.onCommand?.(path, target);

    const ctx: CommandContext = {
      argv: rest,
      args,
      stdin,
      out: env.out,
      signal: env.signal,
      session: env.session,
      services: this.services,
      spec,
      commandPath: path,
      invokedAs: name,
    };
    try {
      const result = await spec.run(ctx);
      return typeof result === 'number' ? result : EXIT.OK;
    } catch (error) {
      if (env.signal.aborted || isAbortError(error)) {
        env.out.warn('Cancelled.');
        return EXIT.CANCELLED;
      }
      return this.report(error, env.out, path);
    }
  }

  private notFound(name: string, out: OutputSink): number {
    const known = UNAVAILABLE_TOOLS[name.toLowerCase()];
    if (known) {
      out.error(`${name}: not available on iPad.`);
      out.info(known);
      return EXIT.NOT_FOUND;
    }
    if (POWERSHELL_VERBS.test(name)) {
      out.error(`${name}: this looks like a PowerShell cmdlet. Terminia's local commands are not PowerShell.`);
      out.info('Run PowerShell on a remote host: `remote connect <profile>`, then type the command there. See `help remote`.');
      return EXIT.NOT_FOUND;
    }
    const hint = suggest(name, this.registry.names());
    out.error(`${name}: command not found.${hint ? ` Did you mean '${hint}'?` : ''}`);
    out.info("Type 'help' to list local commands.");
    return EXIT.NOT_FOUND;
  }

  private report(error: unknown, out: OutputSink, path: string[]): number {
    const e = toTerminiaError(error);
    if (e.code === 'CANCELLED') {
      out.warn('Cancelled.');
      return EXIT.CANCELLED;
    }
    out.error(redact(`${path.join(' ')}: ${e.message}`));
    if (e.hint) out.info(redact(e.hint));
    if (e.code === 'INVALID_ARGUMENT') return EXIT.USAGE;
    if (e.code === 'UNSUPPORTED') return EXIT.UNSUPPORTED;
    return EXIT.ERROR;
  }
}
