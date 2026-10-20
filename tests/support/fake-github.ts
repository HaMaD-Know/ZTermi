/**
 * MOCK GitHub REST API for integration tests. It is NOT GitHub and nothing a
 * test does with it is a real cloud build. It implements the subset Terminia
 * uses closely enough to exercise real client code paths, including error
 * injection (rate limits, outages, auth failures).
 *
 * Workflow dispatch is validated against the YAML of the workflow file in the
 * dispatched ref (the real templates when a test installs them), and run
 * titles are computed from its `run-name`, as GitHub does.
 */
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';

type Json = Record<string, unknown>;

interface Entry {
  path: string;
  mode: string;
  sha: string;
}

export interface RunScript {
  outcome: 'success' | 'failure';
  /** Number of GET /runs/:id calls before the run is in progress / completed. */
  pollsUntilRunning: number;
  pollsUntilDone: number;
  artifacts: { name: string; data: Uint8Array; zipped: boolean; expired?: boolean; digest?: 'correct' | 'wrong' | 'none' }[];
  result?: Json;
  failure?: { title: string; message: string };
  log?: string;
}

interface Run {
  id: number;
  number: number;
  workflowFile: string;
  workflowId: number;
  ref: string;
  headSha: string;
  inputs: Record<string, string>;
  title: string;
  createdAt: string;
  polls: number;
  status: string;
  conclusion: string | null;
  cancelRequested: boolean;
  script: RunScript;
  jobId: number;
  artifactIds: number[];
}

interface Repo {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  push: boolean;
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string; date: string }>;
  trees: Map<string, Entry[]>;
  blobs: Map<string, Uint8Array>;
  workflows: Map<string, { id: number; name: string; path: string; state: string }>;
  runs: Run[];
  secrets: Set<string>;
}

const sha1 = (data: Uint8Array | string) => createHash('sha1').update(data).digest('hex');
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

export function blobSha(data: Uint8Array): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${data.byteLength}\0`), Buffer.from(data)]));
}

export const DEFAULT_SCRIPT: RunScript = { outcome: 'success', pollsUntilRunning: 1, pollsUntilDone: 3, artifacts: [] };

export class FakeGitHub {
  readonly token = `ghp_${'T'.repeat(36)}`;
  readonly repos = new Map<string, Repo>();
  readonly requests: { method: string; path: string; body?: Json }[] = [];
  readonly artifacts = new Map<number, { repo: string; runId: number; name: string; data: Uint8Array; zipped: boolean; expired: boolean; digest: 'correct' | 'wrong' | 'none' }>();
  dispatchMode: 'run-details' | 'no-content' = 'no-content';
  nextScript: RunScript = DEFAULT_SCRIPT;
  private failures: { match: RegExp; method?: string; status: number; headers?: Record<string, string>; body?: Json; times: number }[] = [];
  private ids = 1000;
  private clock = Date.parse('2026-10-20T10:00:00Z');

  failNext(match: RegExp, status: number, options: { times?: number; method?: string; headers?: Record<string, string>; body?: Json } = {}): void {
    this.failures.push({ match, status, times: options.times ?? 1, method: options.method, headers: options.headers, body: options.body ?? { message: `injected ${status}` } });
  }

  addRepo(owner: string, name: string, options: { empty?: boolean; push?: boolean; files?: Record<string, string>; secrets?: string[]; defaultBranch?: string } = {}): Repo {
    const repo: Repo = {
      owner,
      name,
      defaultBranch: options.defaultBranch ?? 'main',
      private: true,
      push: options.push ?? true,
      refs: new Map(),
      commits: new Map(),
      trees: new Map(),
      blobs: new Map(),
      workflows: new Map(),
      runs: [],
      secrets: new Set(options.secrets ?? []),
    };
    this.repos.set(`${owner}/${name}`, repo);
    if (!options.empty) {
      const files = options.files ?? { 'README.md': `# ${name}\n` };
      const entries = Object.entries(files).map(([path, content]) => ({ path, mode: '100644', sha: this.putBlob(repo, new TextEncoder().encode(content)) }));
      const tree = this.putTree(repo, entries);
      const commit = this.putCommit(repo, tree, [], 'Initial commit');
      repo.refs.set(repo.defaultBranch, commit);
      this.registerWorkflows(repo);
    }
    return repo;
  }

  fileAt(repoName: string, branch: string, path: string): string | null {
    const repo = this.repos.get(repoName)!;
    const head = repo.refs.get(branch);
    if (!head) return null;
    const entry = repo.trees.get(repo.commits.get(head)!.tree)!.find((e) => e.path === path);
    return entry ? new TextDecoder().decode(repo.blobs.get(entry.sha)!) : null;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private putBlob(repo: Repo, data: Uint8Array): string {
    const sha = blobSha(data);
    repo.blobs.set(sha, data);
    return sha;
  }

  private putTree(repo: Repo, entries: Entry[]): string {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    const sha = sha1(JSON.stringify(sorted));
    repo.trees.set(sha, sorted);
    return sha;
  }

  private putCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const sha = sha1(`${tree}:${parents.join(',')}:${message}:${this.ids++}`);
    repo.commits.set(sha, { tree, parents, message, date: this.now() });
    return sha;
  }

  /** Like GitHub: workflows become known once they are on the default branch. */
  private registerWorkflows(repo: Repo): void {
    const head = repo.refs.get(repo.defaultBranch);
    if (!head) return;
    for (const entry of repo.trees.get(repo.commits.get(head)!.tree)!) {
      const match = /^\.github\/workflows\/([^/]+\.ya?ml)$/.exec(entry.path);
      if (!match || repo.workflows.has(match[1]!)) continue;
      const doc = parseYaml(new TextDecoder().decode(repo.blobs.get(entry.sha)!)) as { name?: string };
      repo.workflows.set(match[1]!, { id: this.ids++, name: doc.name ?? match[1]!, path: entry.path, state: 'active' });
    }
  }

  private workflowYaml(repo: Repo, ref: string, file: string): Json | null {
    const head = repo.refs.get(ref);
    if (!head) return null;
    const entry = repo.trees.get(repo.commits.get(head)!.tree)!.find((e) => e.path === `.github/workflows/${file}`);
    return entry ? (parseYaml(new TextDecoder().decode(repo.blobs.get(entry.sha)!)) as Json) : null;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body: Json | undefined;
    if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body) as Json;
    this.requests.push({ method, path: url.pathname + url.search, body });

    if (url.origin !== 'https://api.github.com') return this.json(404, { message: `unexpected origin ${url.origin}` });
    if (headers.get('authorization') !== `Bearer ${this.token}`) return this.json(401, { message: 'Bad credentials' });
    const failure = this.failures.find((f) => f.times > 0 && f.match.test(url.pathname) && (!f.method || f.method === method));
    if (failure) {
      failure.times--;
      return this.json(failure.status, failure.body!, failure.headers);
    }
    try {
      return this.route(method, url, body);
    } catch (error) {
      return this.json(500, { message: (error as Error).message });
    }
  };

  private json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
    if (status === 204) return new Response(null, { status, headers });
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1792500000', ...headers },
    });
  }

  private repoJson(repo: Repo): Json {
    return {
      id: 1,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
      archived: false,
      pushed_at: '2026-10-19T10:00:00Z',
      owner: { login: repo.owner },
      permissions: { admin: true, push: repo.push, pull: true },
    };
  }

  private runJson(repo: Repo, run: Run): Json {
    return {
      id: run.id,
      name: 'workflow',
      display_title: run.title,
      run_number: run.number,
      run_attempt: 1,
      event: 'workflow_dispatch',
      status: run.status,
      conclusion: run.conclusion,
      head_branch: run.ref,
      head_sha: run.headSha,
      html_url: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${run.id}`,
      created_at: run.createdAt,
      updated_at: run.createdAt,
      run_started_at: run.createdAt,
      workflow_id: run.workflowId,
      path: `.github/workflows/${run.workflowFile}`,
    };
  }

  private advance(run: Run): void {
    if (run.status === 'completed') return;
    run.polls++;
    if (run.cancelRequested) {
      run.status = 'completed';
      run.conclusion = 'cancelled';
    } else if (run.polls >= run.script.pollsUntilDone) {
      run.status = 'completed';
      run.conclusion = run.script.outcome;
    } else if (run.polls >= run.script.pollsUntilRunning) run.status = 'in_progress';
  }

  private route(method: string, url: URL, body: Json | undefined): Response {
    const p = url.pathname;
    if (method === 'GET' && p === '/user') return this.json(200, { login: 'ada', id: 1, name: 'Ada', avatar_url: '', html_url: 'https://github.com/ada' }, { 'x-oauth-scopes': 'repo, workflow' });
    if (method === 'GET' && p === '/user/repos') return this.json(200, [...this.repos.values()].map((r) => this.repoJson(r)));

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return this.json(404, { message: 'Not Found' });
    const repo = this.repos.get(`${m[1]}/${m[2]}`);
    if (!repo) return this.json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    const empty = repo.refs.size === 0;

    if (method === 'GET' && rest === '') return this.json(200, this.repoJson(repo));
    if (method === 'GET' && rest === '/branches') return this.json(200, [...repo.refs].map(([name, sha]) => ({ name, commit: { sha }, protected: false })));

    // ---- git data
    let g = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && g) {
      if (empty) return this.json(409, { message: 'Git Repository is empty.' });
      const sha = repo.refs.get(decodeURIComponent(g[1]!));
      return sha ? this.json(200, { ref: `refs/heads/${g[1]}`, object: { sha, type: 'commit' } }) : this.json(404, { message: 'Not Found' });
    }
    g = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
    if (method === 'GET' && g) {
      const c = repo.commits.get(g[1]!);
      return c ? this.json(200, { sha: g[1], tree: { sha: c.tree }, html_url: '', message: c.message }) : this.json(404, { message: 'Not Found' });
    }
    g = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (method === 'GET' && g) {
      const t = repo.trees.get(g[1]!);
      if (!t) return this.json(404, { message: 'Not Found' });
      const dirs = new Set<string>();
      for (const e of t) {
        const parts = e.path.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      const tree = [...[...dirs].map((d) => ({ path: d, mode: '040000', type: 'tree', sha: sha1(d) })), ...t.map((e) => ({ ...e, type: 'blob', size: repo.blobs.get(e.sha)!.byteLength }))];
      return this.json(200, { sha: g[1], truncated: false, tree });
    }
    g = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (method === 'GET' && g) {
      const b = repo.blobs.get(g[1]!);
      return b ? this.json(200, { content: Buffer.from(b).toString('base64'), encoding: 'base64', size: b.byteLength }) : this.json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === '/git/blobs') {
      if (empty) return this.json(409, { message: 'Git Repository is empty.' });
      return this.json(201, { sha: this.putBlob(repo, new Uint8Array(Buffer.from(String(body!.content), 'base64'))) });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const base = body!.base_tree ? [...(repo.trees.get(String(body!.base_tree)) ?? [])] : [];
      const map = new Map(base.map((e) => [e.path, e]));
      for (const e of body!.tree as { path: string; mode: string; sha: string | null }[]) {
        if (e.sha === null) map.delete(e.path);
        else {
          if (!repo.blobs.has(e.sha)) return this.json(422, { message: `tree.sha ${e.sha} is not a valid blob` });
          map.set(e.path, { path: e.path, mode: e.mode, sha: e.sha });
        }
      }
      return this.json(201, { sha: this.putTree(repo, [...map.values()]) });
    }
    if (method === 'POST' && rest === '/git/commits') {
      if (!repo.trees.has(String(body!.tree))) return this.json(422, { message: 'Tree not found' });
      const sha = this.putCommit(repo, String(body!.tree), body!.parents as string[], String(body!.message));
      return this.json(201, { sha, tree: { sha: body!.tree }, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`, message: body!.message });
    }
    g = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === 'PATCH' && g) {
      const branch = decodeURIComponent(g[1]!);
      const current = repo.refs.get(branch);
      if (!current) return this.json(422, { message: 'Reference does not exist' });
      const next = String(body!.sha);
      if (!body!.force && !repo.commits.get(next)?.parents.includes(current)) return this.json(422, { message: 'Update is not a fast forward' });
      repo.refs.set(branch, next);
      if (branch === repo.defaultBranch) this.registerWorkflows(repo);
      return this.json(200, { ref: `refs/heads/${branch}`, object: { sha: next, type: 'commit' } });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const branch = String(body!.ref).replace('refs/heads/', '');
      if (repo.refs.has(branch)) return this.json(422, { message: 'Reference already exists' });
      repo.refs.set(branch, String(body!.sha));
      return this.json(201, { ref: body!.ref, object: { sha: body!.sha, type: 'commit' } });
    }
    g = /^\/contents\/(.+)$/.exec(rest);
    if (g && method === 'PUT') {
      const path = decodeURIComponent(g[1]!);
      const branch = String(body!.branch ?? repo.defaultBranch);
      const sha = this.putBlob(repo, new Uint8Array(Buffer.from(String(body!.content), 'base64')));
      const parent = repo.refs.get(branch);
      const base = parent ? repo.trees.get(repo.commits.get(parent)!.tree)! : [];
      const tree = this.putTree(repo, [...base.filter((e) => e.path !== path), { path, mode: '100644', sha }]);
      const commit = this.putCommit(repo, tree, parent ? [parent] : [], String(body!.message));
      repo.refs.set(branch, commit);
      if (branch === repo.defaultBranch) this.registerWorkflows(repo);
      return this.json(201, { commit: { sha: commit } });
    }
    if (g && method === 'GET') {
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const head = repo.refs.get(ref);
      const entry = head ? repo.trees.get(repo.commits.get(head)!.tree)!.find((e) => e.path === decodeURIComponent(g![1]!)) : undefined;
      return entry ? this.json(200, { type: 'file', path: entry.path, sha: entry.sha, size: repo.blobs.get(entry.sha)!.byteLength }) : this.json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && rest === '/commits') {
      const out: Json[] = [];
      let sha = repo.refs.get(url.searchParams.get('sha') ?? repo.defaultBranch);
      while (sha && out.length < Number(url.searchParams.get('per_page') ?? 30)) {
        const c = repo.commits.get(sha)!;
        out.push({ sha, html_url: '', commit: { message: c.message, author: { name: 'Ada', date: c.date } } });
        sha = c.parents[0];
      }
      return this.json(200, out);
    }

    // ---- actions
    if (method === 'GET' && rest === '/actions/secrets') return this.json(200, { total_count: repo.secrets.size, secrets: [...repo.secrets].map((name) => ({ name })) });
    if (method === 'GET' && rest === '/actions/workflows') return this.json(200, { total_count: repo.workflows.size, workflows: [...repo.workflows.values()].map((w) => ({ ...w, html_url: '' })) });
    g = /^\/actions\/workflows\/([^/]+)$/.exec(rest);
    if (method === 'GET' && g) {
      const w = repo.workflows.get(decodeURIComponent(g[1]!));
      return w ? this.json(200, { ...w, html_url: '' }) : this.json(404, { message: 'Not Found' });
    }
    g = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest);
    if (method === 'POST' && g) return this.dispatch(repo, decodeURIComponent(g[1]!), body!);
    g = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest);
    if (method === 'GET' && g) {
      const file = decodeURIComponent(g[1]!);
      const branch = url.searchParams.get('branch');
      const runs = repo.runs.filter((r) => r.workflowFile === file && (!branch || r.ref === branch)).reverse();
      return this.json(200, { total_count: runs.length, workflow_runs: runs.map((r) => this.runJson(repo, r)) });
    }
    g = /^\/actions\/runs\/(\d+)(\/[a-z]+)?$/.exec(rest);
    if (g) {
      const run = repo.runs.find((r) => r.id === Number(g![1]));
      if (!run) return this.json(404, { message: 'Not Found' });
      const sub = g[2];
      if (method === 'GET' && !sub) {
        this.advance(run);
        return this.json(200, this.runJson(repo, run));
      }
      if (method === 'GET' && sub === '/jobs') return this.json(200, { total_count: 1, jobs: [this.jobJson(run)] });
      if (method === 'POST' && sub === '/cancel') {
        if (run.status === 'completed') return this.json(409, { message: 'Cannot cancel a workflow run that is completed.' });
        run.cancelRequested = true;
        return this.json(202, {});
      }
      if (method === 'GET' && sub === '/artifacts') {
        const list = run.status === 'completed' ? run.artifactIds.map((id) => this.artifactJson(id)) : [];
        return this.json(200, { total_count: list.length, artifacts: list });
      }
    }
    g = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (method === 'GET' && g) {
      const run = repo.runs.find((r) => r.jobId === Number(g![1]));
      if (!run || run.status !== 'completed') return this.json(404, { message: 'Not Found' });
      return new Response(run.script.log ?? `2026-10-20T10:00:01.0000000Z ##[group]Run build\n2026-10-20T10:00:02.0000000Z building...\n2026-10-20T10:00:03.0000000Z ##[endgroup]\n`, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    g = /^\/check-runs\/(\d+)\/annotations$/.exec(rest);
    if (method === 'GET' && g) {
      const run = repo.runs.find((r) => r.jobId === Number(g![1]));
      if (!run) return this.json(404, { message: 'Not Found' });
      const out: Json[] = [];
      if (run.status === 'completed' && run.conclusion === 'success' && run.script.result) {
        out.push({ path: '.github', start_line: 1, annotation_level: 'notice', title: 'terminia-result', message: JSON.stringify(run.script.result), raw_details: null });
      }
      if (run.status === 'completed' && run.conclusion === 'failure' && run.script.failure) {
        out.push({ path: '.github', start_line: 1, annotation_level: 'failure', title: run.script.failure.title, message: run.script.failure.message, raw_details: null });
      }
      return this.json(200, out);
    }
    g = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest);
    if (method === 'GET' && g) {
      const a = this.artifacts.get(Number(g[1]));
      if (!a) return this.json(404, { message: 'Not Found' });
      if (a.expired) return this.json(410, { message: 'Artifact has expired' });
      const served = this.served(a);
      return new Response(served as BodyInit, { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(served.byteLength) } });
    }
    return this.json(404, { message: `Not Found: ${method} ${p}` });
  }

  private served(a: { name: string; data: Uint8Array; zipped: boolean }): Uint8Array {
    return a.zipped ? zipSync({ [a.name]: a.data }) : a.data;
  }

  private artifactJson(id: number): Json {
    const a = this.artifacts.get(id)!;
    const served = this.served(a);
    return {
      id,
      name: a.name,
      size_in_bytes: served.byteLength,
      archive_download_url: `https://api.github.com/repos/${a.repo}/actions/artifacts/${id}/zip`,
      expired: a.expired,
      created_at: '2026-10-20T10:05:00Z',
      expires_at: '2026-11-03T10:05:00Z',
      updated_at: '2026-10-20T10:05:00Z',
      digest: a.digest === 'none' ? null : `sha256:${a.digest === 'correct' ? sha256(served) : '0'.repeat(64)}`,
    };
  }

  private jobJson(run: Run): Json {
    const done = run.status === 'completed';
    const running = run.status === 'in_progress';
    const steps = ['Set up job', 'Detect project', 'Build', 'Upload'].map((name, i) => ({
      name,
      number: i + 1,
      status: done ? 'completed' : running && i < 2 ? 'completed' : running && i === 2 ? 'in_progress' : 'queued',
      conclusion: done ? (run.conclusion === 'failure' && i === 2 ? 'failure' : run.conclusion === 'failure' && i > 2 ? 'skipped' : run.conclusion === 'cancelled' && i >= 2 ? 'cancelled' : 'success') : running && i < 2 ? 'success' : null,
      started_at: '2026-10-20T10:00:00Z',
      completed_at: done ? '2026-10-20T10:01:00Z' : null,
    }));
    return {
      id: run.jobId,
      run_id: run.id,
      name: 'build',
      status: run.status === 'in_progress' || run.status === 'completed' ? run.status : 'queued',
      conclusion: run.conclusion,
      started_at: '2026-10-20T10:00:00Z',
      completed_at: done ? '2026-10-20T10:01:00Z' : null,
      html_url: '',
      runner_name: 'GitHub Actions 1',
      labels: ['macos-26'],
      steps,
    };
  }

  private dispatch(repo: Repo, file: string, body: Json): Response {
    const workflow = repo.workflows.get(file);
    if (!workflow) return this.json(404, { message: 'Not Found' });
    const ref = String(body.ref);
    if (!repo.refs.has(ref)) return this.json(422, { message: `No ref found for: ${ref}` });
    const yaml = this.workflowYaml(repo, ref, file);
    if (!yaml) return this.json(404, { message: 'Not Found' });
    const on = yaml.on as { workflow_dispatch?: { inputs?: Record<string, { type?: string; options?: string[]; default?: unknown }> } } | undefined;
    if (!on?.workflow_dispatch) return this.json(422, { message: "Workflow does not have 'workflow_dispatch' trigger" });
    const declared = on.workflow_dispatch.inputs ?? {};
    const inputs = (body.inputs ?? {}) as Record<string, string>;
    const unexpected = Object.keys(inputs).filter((k) => !(k in declared));
    if (unexpected.length) return this.json(422, { message: `Unexpected inputs provided: ${JSON.stringify(unexpected)}` });
    for (const [key, spec] of Object.entries(declared)) {
      if (spec.type === 'choice' && key in inputs && !spec.options!.includes(inputs[key]!)) {
        return this.json(422, { message: `Provided value '${inputs[key]}' for input '${key}' not in the list of allowed values` });
      }
      if (spec.type === 'boolean' && key in inputs && !['true', 'false'].includes(inputs[key]!)) {
        return this.json(422, { message: `Provided value '${inputs[key]}' for input '${key}' is not a boolean` });
      }
    }
    const values: Record<string, string> = {};
    for (const [key, spec] of Object.entries(declared)) values[key] = inputs[key] ?? String(spec.default ?? '');
    const title = String(yaml['run-name'] ?? yaml.name).replace(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, (_, k: string) => values[k] ?? '');
    const script = this.nextScript;
    const run: Run = {
      id: this.ids++,
      number: repo.runs.length + 1,
      workflowFile: file,
      workflowId: workflow.id,
      ref,
      headSha: repo.refs.get(ref)!,
      inputs: values,
      title,
      createdAt: this.now(),
      polls: 0,
      status: 'queued',
      conclusion: null,
      cancelRequested: false,
      script,
      jobId: this.ids++,
      artifactIds: [],
    };
    for (const a of script.artifacts) {
      const id = this.ids++;
      this.artifacts.set(id, { repo: `${repo.owner}/${repo.name}`, runId: run.id, name: a.name, data: a.data, zipped: a.zipped, expired: a.expired ?? false, digest: a.digest ?? 'correct' });
      run.artifactIds.push(id);
    }
    repo.runs.push(run);
    if (this.dispatchMode === 'run-details' && body.return_run_details) {
      return this.json(200, { workflow_run_id: run.id, run_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs/${run.id}`, html_url: '' });
    }
    return this.json(204, null);
  }
}
