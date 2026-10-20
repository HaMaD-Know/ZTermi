// @vitest-environment node
/**
 * REAL integration test: starts the Terminia agent in-process, which spawns a
 * real PowerShell (pwsh, or Windows PowerShell 5.1), and drives it through
 * Terminia's own client code (RemoteHostClient / RemoteShell / FetchHttpClient
 * with the in-memory vault). Skipped when no PowerShell is installed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfig } from '../../agent/lib/config.mjs';
import { createAgent, type AgentHandle } from '../../agent/lib/server.mjs';
import { resolvePowerShell } from '../../agent/lib/sessions.mjs';
import { isTerminiaError } from '../../src/core/errors';
import { FetchHttpClient } from '../../src/net/http';
import { MemoryVault } from '../../src/platform/vault';
import { RemoteHostClient, type RemoteProfile } from '../../src/remote/client';
import { RemoteShell, followCommand } from '../../src/remote/shell';
import { RecordingSink } from '../support/sink';

let powershell: { path: string; edition: string; version: string } | null = null;
try {
  powershell = resolvePowerShell();
} catch {
  powershell = null;
}

describe.skipIf(!powershell)(`remote PowerShell agent (real ${powershell?.edition ?? ''} ${powershell?.version ?? ''})`, () => {
  let agent: AgentHandle;
  let dir: string;
  let client: RemoteHostClient;
  let profile: RemoteProfile;
  let token: string;
  let origin: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'terminia-agent-'));
    const created = initConfig(path.join(dir, 'config.json'), { roots: [dir] });
    token = created.token;
    agent = createAgent(created.config, { powershell: powershell!, log: () => undefined });
    const address = await agent.listen('127.0.0.1', 0);
    origin = `http://127.0.0.1:${address.port}`;
    const vault = new MemoryVault();
    vault.store({ id: 'remote:test', label: 'test', kind: 'remote-agent', allowedOrigins: [origin] }, token);
    profile = { id: 'test', name: 'test-host', url: origin, credentialId: 'remote:test', createdAt: Date.now(), projectPaths: {} };
    client = new RemoteHostClient(new FetchHttpClient({ vault }), profile);
  }, 60_000);

  afterAll(async () => {
    await agent?.close();
    // PowerShell processes may still hold the folder for a moment on Windows.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  async function shell(): Promise<RemoteShell> {
    const info = await client.info();
    const session = await client.createSession();
    return new RemoteShell(client, session.id, info.hostname, session.cwd);
  }

  async function run(sh: RemoteShell, script: string, signal = new AbortController().signal) {
    const sink = new RecordingSink();
    const { exitCode } = await sh.run(script, sink, signal);
    return { exitCode, sink };
  }

  it('reports the real PowerShell version and protocol', async () => {
    const info = await client.info();
    expect(info.protocol).toBe(1);
    expect(info.powershell.edition).toBe(powershell!.edition);
    expect(info.powershell.version).toBe(powershell!.version);
  });

  it('rejects a wrong token with AUTH_FAILED', async () => {
    const vault = new MemoryVault();
    vault.store({ id: 'remote:bad', label: 'bad', kind: 'remote-agent', allowedOrigins: [origin] }, 'tma_wrong_token_value_123456789');
    const bad = new RemoteHostClient(new FetchHttpClient({ vault }), { ...profile, credentialId: 'remote:bad' });
    await expect(bad.info()).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'AUTH_FAILED'));
  });

  it('keeps variables, functions and location between commands', async () => {
    const sh = await shell();
    expect((await run(sh, '$answer = 21; function Double($n) { $n * 2 }')).exitCode).toBe(0);
    const result = await run(sh, 'Double $answer');
    expect(result.exitCode).toBe(0);
    expect(result.sink.text('stdout').trim()).toBe('42');
    await run(sh, `New-Item -ItemType Directory -Path '${path.join(dir, 'sub')}' -Force | Out-Null; Set-Location '${path.join(dir, 'sub')}'`);
    expect(sh.cwd()?.toLowerCase()).toBe(path.join(dir, 'sub').toLowerCase());
    await sh.close();
  });

  it('separates error, warning and host output and sets the exit code', async () => {
    const sh = await shell();
    const result = await run(sh, "Write-Output 'out'; Write-Warning 'careful'; Write-Host 'from host'; Write-Error 'boom'");
    expect(result.sink.text('stdout')).toContain('out');
    expect(result.sink.text('stdout')).toContain('from host');
    expect(result.sink.text('warn')).toContain('WARNING: careful');
    expect(result.sink.text('stderr')).toContain('boom');
    expect(result.exitCode).toBe(1);
    await sh.close();
  });

  it('reports native exit codes through $LASTEXITCODE', async () => {
    const sh = await shell();
    const script = process.platform === 'win32' ? 'cmd /c exit 3' : "sh -c 'exit 3'";
    expect((await run(sh, script)).exitCode).toBe(3);
    await sh.close();
  });

  it('reports a terminating error', async () => {
    const sh = await shell();
    const result = await run(sh, "throw 'fatal problem'");
    expect(result.exitCode).toBe(1);
    expect(result.sink.text('stderr')).toContain('fatal problem');
    await sh.close();
  });

  it('stops a running command when the terminal cancels it', async () => {
    const sh = await shell();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 1500);
    const result = await run(sh, 'Start-Sleep -Seconds 60; "not reached"', controller.signal);
    expect(result.exitCode).toBe(130);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.sink.text('stdout')).not.toContain('not reached');
    // The session is still usable afterwards.
    expect((await run(sh, '1 + 1')).sink.text('stdout').trim()).toBe('2');
    await sh.close();
  }, 30_000);

  it('completes with PowerShell\'s own TabExpansion2', async () => {
    const sh = await shell();
    const completion = await sh.complete('Get-ChildIt', 11);
    expect(completion.candidates.map((c) => c.value)).toContain('Get-ChildItem');
    expect(completion.start).toBe(0);
    await sh.close();
  });

  async function exec(args: string[]) {
    const sink = new RecordingSink();
    const started = await client.exec('node', args, dir);
    const { exitCode } = await followCommand(client, started.sessionId, started.commandId, sink, new AbortController().signal);
    return { exitCode, sink };
  }

  it('runs allowlisted programs with argument arrays, no shell parsing', async () => {
    const { exitCode, sink } = await exec(['-e', "console.log(process.argv.slice(1).join('|'))", 'a b', '$(not-expanded)', 'semi;colon', '&&echo injected']);
    expect(exitCode).toBe(0);
    expect(sink.text('stdout')).toContain('a b|$(not-expanded)|semi;colon|&&echo injected');
    expect(sink.text('stdout')).not.toMatch(/^injected$/m);
  });

  it('handles double quotes honestly for the PowerShell edition in use', async () => {
    const { exitCode, sink } = await exec(['-e', "console.log(process.argv[1])", 'say "hi"']);
    if (powershell!.edition === 'Desktop') {
      // Windows PowerShell 5.1 would silently drop the quotes, so the host refuses instead.
      expect(exitCode).toBe(1);
      expect(sink.text('stderr')).toContain('cannot pass double quotes');
    } else {
      expect(exitCode).toBe(0);
      expect(sink.text('stdout')).toContain('say "hi"');
    }
  });

  it('refuses programs outside the allowlist and folders outside the roots', async () => {
    await expect(client.exec('rm', ['-rf', '/'], dir)).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'INVALID_ARGUMENT'));
    await expect(client.exec('node', ['-v'], os.homedir() === dir ? '/' : os.homedir())).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'INVALID_ARGUMENT'));
  });
});
