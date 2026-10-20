// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canTransition, fromGitHubRun, isActive, isTerminal, transition } from '../../src/build/state';
import { BUILD_STATUSES } from '../../src/build/types';
import { diffLines, unifiedDiff } from '../../src/core/diff';
import { isTerminiaError } from '../../src/core/errors';
import { GitHubClient, nextLink } from '../../src/github/client';
import { v } from '../../src/core/validate';
import { FetchHttpClient } from '../../src/net/http';
import { MemoryVault, isPrivateHost, validateOrigins } from '../../src/platform/vault';

describe('build state machine', () => {
  it('only moves forward and never leaves a terminal state', () => {
    expect(transition('ready', 'syncing')).toBe('syncing');
    expect(canTransition('dispatching', 'succeeded')).toBe(true);
    expect(canTransition('running', 'queued')).toBe(false);
    for (const terminal of ['succeeded', 'failed', 'cancelled', 'waiting_for_signing'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const s of BUILD_STATUSES) if (s !== terminal) expect(canTransition(terminal, s)).toBe(false);
    }
    expect(() => transition('succeeded', 'running')).toThrow(/Invalid build status change/);
    expect(isActive('queued')).toBe(true);
    expect(isActive('ready')).toBe(false);
  });

  it.each([
    [['queued', null], 'queued', undefined],
    [['waiting', null], 'queued', 'waiting for a deployment approval'],
    [['in_progress', null], 'running', undefined],
    [['completed', 'success'], 'succeeded', undefined],
    [['completed', 'cancelled'], 'cancelled', undefined],
    [['completed', 'timed_out'], 'failed', 'timed out'],
    [['completed', 'startup_failure'], 'failed', 'the workflow could not start (startup failure)'],
    [['completed', 'failure'], 'failed', 'failure'],
  ] as const)('maps GitHub %j to %s', ([status, conclusion], expected, detail) => {
    expect(fromGitHubRun(status, conclusion)).toEqual({ status: expected, detail });
  });
});

function client(responses: { status: number; body?: unknown; headers?: Record<string, string> }[], sleeps: number[] = []) {
  const calls: string[] = [];
  const vault = new MemoryVault();
  vault.store({ id: 'github', label: 'g', kind: 'github-classic', allowedOrigins: ['https://api.github.com'] }, `ghp_${'a'.repeat(36)}`);
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url} ${new Headers(init.headers).get('authorization')?.slice(0, 10)}`);
    const r = responses.shift() ?? { status: 500 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof globalThis.fetch;
  const gh = new GitHubClient({
    http: new FetchHttpClient({ vault, fetch }),
    credentialId: 'github',
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 1_000_000,
  });
  return { gh, calls };
}

describe('GitHub client', () => {
  const ok = v.object({ ok: v.boolean() });

  it('attaches the credential only for api.github.com and validates responses', async () => {
    const { gh, calls } = client([{ status: 200, body: { ok: true, extra: 'dropped' } }]);
    expect(await gh.get('/x', ok)).toEqual({ ok: true });
    expect(calls[0]).toBe('GET https://api.github.com/x Bearer ghp');
    const bad = client([{ status: 200, body: { ok: 'yes' } }]);
    await expect(bad.gh.get('/x', ok)).rejects.toThrow(/Invalid GitHub response.*ok: expected boolean/);
  });

  it('retries GET on 5xx with backoff, but not POST', async () => {
    const sleeps: number[] = [];
    const { gh } = client([{ status: 502 }, { status: 503 }, { status: 200, body: { ok: true } }], sleeps);
    expect(await gh.get('/x', ok)).toEqual({ ok: true });
    expect(sleeps).toHaveLength(2);
    const post = client([{ status: 502 }, { status: 200, body: { ok: true } }]);
    await expect(post.gh.post('/x', {}, ok)).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'PROVIDER'));
    expect(post.calls).toHaveLength(1);
  });

  it('waits for primary and secondary rate limits within bounds', async () => {
    const sleeps: number[] = [];
    const { gh } = client(
      [
        { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1005' } },
        { status: 429, body: { message: 'secondary' }, headers: { 'retry-after': '2' } },
        { status: 200, body: { ok: true } },
      ],
      sleeps,
    );
    expect(await gh.get('/x', ok)).toEqual({ ok: true });
    expect(sleeps).toEqual([5_000, 2_000]);
    const far = client([{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999' } }]);
    await expect(far.gh.get('/x', ok)).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'RATE_LIMITED'));
  });

  it('turns GitHub errors into actionable messages', async () => {
    const cases: [number, unknown, Record<string, string>, string, RegExp][] = [
      [401, { message: 'Bad credentials' }, {}, 'AUTH_FAILED', /Reconnect/],
      [403, { message: 'Resource not accessible by integration' }, { 'x-accepted-oauth-scopes': 'workflow', 'x-oauth-scopes': 'repo' }, 'PERMISSION_DENIED', /needs the OAuth scope\(s\) 'workflow'; your token has 'repo'/],
      [403, { message: 'Resource not accessible by personal access token' }, {}, 'PERMISSION_DENIED', /fine-grained token/],
      [404, { message: 'Not Found' }, {}, 'NOT_FOUND', /private repositories/],
      [422, { message: 'Validation Failed', errors: [{ resource: 'Ref', field: 'sha', code: 'invalid' }] }, {}, 'VALIDATION', /^/],
    ];
    for (const [status, body, headers, code, hint] of cases) {
      const { gh } = client([{ status, body, headers }]);
      const error = await gh.post('/x', {}, ok).catch((e: unknown) => e);
      expect(isTerminiaError(error, code as never), `${status}`).toBe(true);
      expect(`${(error as Error).message} ${(error as { hint?: string }).hint ?? ''}`).toMatch(hint);
    }
  });

  it('follows Link pagination', async () => {
    expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe('https://api.github.com/x?page=2');
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
  });
});

describe('credential binding', () => {
  it('never sends a credential to an origin it was not bound to', async () => {
    const vault = new MemoryVault();
    vault.store({ id: 'github', label: 'g', kind: 'github-classic', allowedOrigins: ['https://api.github.com'] }, 'ghp_secret_value_1234567890');
    const seen: (string | null)[] = [];
    const http = new FetchHttpClient({ vault, fetch: (async (_u: string, init: RequestInit) => (seen.push(new Headers(init.headers).get('authorization')), new Response('ok'))) as unknown as typeof fetch });
    await expect(http.request({ url: 'https://evil.example/steal', credentialId: 'github' })).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'PERMISSION_DENIED'));
    await http.request({ url: 'https://example.com/', headers: { Authorization: 'Bearer injected' } });
    expect(seen).toEqual([null]);
    await expect(http.request({ url: 'https://api.github.com/', credentialId: 'missing' })).rejects.toSatisfy((e: unknown) => isTerminiaError(e, 'AUTH_REQUIRED'));
  });

  it('only allows plain HTTP origins on private networks', () => {
    expect(validateOrigins(['https://api.github.com'])).toEqual(['https://api.github.com']);
    expect(validateOrigins(['http://192.168.1.20:8765'])).toEqual(['http://192.168.1.20:8765']);
    expect(validateOrigins(['http://100.101.102.103:8765'])).toEqual(['http://100.101.102.103:8765']);
    expect(() => validateOrigins(['http://203.0.113.5:8765'])).toThrow(/private network/);
    expect(() => validateOrigins(['https://api.github.com/repos'])).toThrow(/without a path/);
    expect(() => validateOrigins([])).toThrow(/at least one origin/);
    expect(isPrivateHost('devbox.local')).toBe(true);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });
});

describe('line diff', () => {
  it('finds a minimal edit script', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(ops.map((o) => `${o.type[0]}${o.line}`)).toEqual(['ea', 'db', 'ix', 'ec', 'ed', 'ie']);
    expect(diffLines([], ['x']).map((o) => o.type)).toEqual(['insert']);
    expect(diffLines(['x'], []).map((o) => o.type)).toEqual(['delete']);
  });

  it('formats unified hunks with correct ranges', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const next = old.replace('line 10', 'line ten');
    expect(unifiedDiff(old, next, 'a/f', 'b/f')).toBe(['--- a/f', '+++ b/f', '@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13'].join('\n'));
    expect(unifiedDiff('same\n', 'same\n', 'a', 'b')).toBe('');
    expect(unifiedDiff('', 'new\n', 'a', 'b')).toBe('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+new');
  });
});
