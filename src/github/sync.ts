import { TerminiaError, throwIfAborted } from '../core/errors';
import { bytesToBase64, gitBlobSha } from '../core/hash';
import { DEFAULT_IGNORES, IgnoreRules } from '../core/ignore';
import { basename, joinPath } from '../core/paths';
import type { SecretFinding } from '../core/secrets';
import { formatBytes, mapLimit } from '../core/util';
import type { Vfs } from '../fs/vfs';
import { collectProjectFiles, scanForSecrets } from '../projects/files';
import { encodePath, type GitHubClient } from './client';
import {
  blobCreatedSchema,
  contentPutSchema,
  gitCommitSchema,
  gitRefSchema,
  gitTreeSchema,
  repoSchema,
  treeCreatedSchema,
} from './schemas';

/**
 * Pushes a project to a GitHub branch without a git client, through the Git
 * Data API: local Git blob ids are compared with the remote tree, only changed
 * files are uploaded, and the branch is fast-forwarded (never force-pushed).
 *
 * Nothing is uploaded until the caller has shown the plan to the user and the
 * user confirmed it.
 */

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface SyncChange {
  status: ChangeStatus;
  /** Path inside the repository. */
  repoPath: string;
  /** Path inside the project (empty for deletions of remote-only files). */
  localPath: string;
  size: number;
  sha?: string;
  mode: string;
}

export interface SyncPlan {
  owner: string;
  repo: string;
  branch: string;
  /** Branch the new branch is created from, when `branch` does not exist yet. */
  baseBranch?: string;
  createsBranch: boolean;
  emptyRepository: boolean;
  headSha: string | null;
  baseTreeSha: string | null;
  projectPath: string;
  changes: SyncChange[];
  unchanged: number;
  /** Remote files under the project path that are not in the local project (kept unless deleteRemoved). */
  remoteOnly: string[];
  blocked: SecretFinding[];
  tooLarge: string[];
  ignored: number;
  uploadBytes: number;
  deleteRemoved: boolean;
}

export interface SyncOptions {
  owner: string;
  repo: string;
  branch?: string;
  /** Sub-folder of the repository that holds the project ('.' or '' for the root). */
  projectPath?: string;
  deleteRemoved?: boolean;
  /** Only sync project files for which this returns true (other remote files are left alone). */
  include?: (localPath: string) => boolean;
  signal?: AbortSignal;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

function executableMode(path: string): boolean {
  const name = basename(path);
  return name === 'gradlew' || name.endsWith('.sh');
}

function cleanProjectPath(path: string | undefined): string {
  const p = (path ?? '').replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
  if (p.includes('..')) throw new TerminiaError('INVALID_ARGUMENT', 'projectPath must stay inside the repository.');
  return p;
}

async function readRemoteState(gh: GitHubClient, owner: string, repo: string, branch: string | undefined, signal?: AbortSignal) {
  const info = await gh.get(`/repos/${owner}/${repo}`, repoSchema, { signal });
  if (info.archived) throw new TerminiaError('PERMISSION_DENIED', `${owner}/${repo} is archived and read-only.`);
  if (info.permissions && !info.permissions.push) {
    throw new TerminiaError('PERMISSION_DENIED', `Your GitHub account cannot push to ${owner}/${repo}.`, { hint: 'Ask for write access, or use a repository you own.' });
  }
  const target = branch || info.default_branch;
  const headOf = async (name: string): Promise<string | null> => {
    try {
      return (await gh.get(`/repos/${owner}/${repo}/git/ref/heads/${encodePath(name)}`, gitRefSchema, { signal })).object.sha;
    } catch (error) {
      if (error instanceof TerminiaError && (error.code === 'NOT_FOUND' || error.code === 'CONFLICT')) return null;
      throw error;
    }
  };
  let head = await headOf(target);
  let createsBranch = false;
  let baseBranch: string | undefined;
  let emptyRepository = false;
  if (!head) {
    const defaultHead = target === info.default_branch ? null : await headOf(info.default_branch);
    if (defaultHead) {
      head = defaultHead;
      createsBranch = true;
      baseBranch = info.default_branch;
    } else {
      // No commits at all (or the default branch is missing): the first file is created through the Contents API.
      emptyRepository = true;
      createsBranch = target !== info.default_branch;
    }
  }
  let tree: { path: string; mode: string; sha: string; type: string }[] = [];
  let baseTreeSha: string | null = null;
  if (head) {
    const commit = await gh.get(`/repos/${owner}/${repo}/git/commits/${head}`, gitCommitSchema, { signal });
    baseTreeSha = commit.tree.sha;
    const remoteTree = await gh.get(`/repos/${owner}/${repo}/git/trees/${baseTreeSha}`, gitTreeSchema, { query: { recursive: 1 }, signal });
    if (remoteTree.truncated) {
      throw new TerminiaError('TOO_LARGE', `${owner}/${repo} has too many files for the GitHub tree API.`, { hint: 'Sync into a smaller repository, or set github.projectPath to a sub-folder.' });
    }
    tree = remoteTree.tree;
  }
  return { branch: target, head, createsBranch, baseBranch, emptyRepository, baseTreeSha, tree };
}

export async function planSync(gh: GitHubClient, vfs: Vfs, projectRoot: string, options: SyncOptions): Promise<SyncPlan> {
  const projectPath = cleanProjectPath(options.projectPath);
  const remote = await readRemoteState(gh, options.owner, options.repo, options.branch, options.signal);
  const { files, ignored } = await collectProjectFiles(vfs, projectRoot, { signal: options.signal });

  const selected = options.include ? files.filter((f) => options.include!(f.path)) : files;
  const tooLarge = selected.filter((f) => f.size > MAX_FILE_BYTES).map((f) => f.path);
  const candidates = selected.filter((f) => f.size <= MAX_FILE_BYTES);
  const contents = new Map<string, Uint8Array>();
  const read = async (path: string) => {
    throwIfAborted(options.signal);
    const data = await vfs.readBytes(joinPath(projectRoot, path), MAX_FILE_BYTES);
    contents.set(path, data);
    return data;
  };
  const { allowed, findings } = await scanForSecrets(vfs, projectRoot, candidates, read);

  const toRepo = (local: string) => (projectPath ? `${projectPath}/${local}` : local);
  const remoteBlobs = new Map(remote.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
  const changes: SyncChange[] = [];
  let unchanged = 0;
  const localRepoPaths = new Set<string>();

  await mapLimit(allowed, 8, async (file) => {
    const data = contents.get(file.path) ?? (await read(file.path));
    const sha = await gitBlobSha(data);
    const repoPath = toRepo(file.path);
    localRepoPaths.add(repoPath);
    const existing = remoteBlobs.get(repoPath);
    if (existing?.sha === sha) {
      unchanged++;
      return;
    }
    const mode = existing?.mode ?? (executableMode(file.path) ? '100755' : '100644');
    changes.push({ status: existing ? 'modified' : 'added', repoPath, localPath: file.path, size: data.byteLength, sha, mode });
  });

  // Remote files the project does not have. Never treat locally ignored or blocked paths as deletions.
  const rules = new IgnoreRules().add('', DEFAULT_IGNORES);
  const blockedPaths = new Set(findings.map((f) => toRepo(f.path)));
  const remoteOnly: string[] = [];
  for (const [path, entry] of remoteBlobs) {
    if (projectPath && !path.startsWith(`${projectPath}/`)) continue;
    if (localRepoPaths.has(path) || blockedPaths.has(path) || tooLarge.some((t) => toRepo(t) === path)) continue;
    const local = projectPath ? path.slice(projectPath.length + 1) : path;
    if (options.include && !options.include(local)) continue;
    if (rules.isIgnored(local)) continue;
    if (await isLocallyIgnored(vfs, projectRoot, local)) continue;
    remoteOnly.push(path);
    if (options.deleteRemoved) changes.push({ status: 'deleted', repoPath: path, localPath: '', size: 0, mode: entry.mode });
  }

  changes.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  const uploadBytes = changes.reduce((sum, c) => sum + (c.status === 'deleted' ? 0 : c.size), 0);
  if (uploadBytes > MAX_UPLOAD_BYTES) {
    throw new TerminiaError('TOO_LARGE', `This sync would upload ${formatBytes(uploadBytes)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`, {
      hint: 'Add generated or large files to .gitignore.',
    });
  }
  return {
    owner: options.owner,
    repo: options.repo,
    branch: remote.branch,
    baseBranch: remote.baseBranch,
    createsBranch: remote.createsBranch,
    emptyRepository: remote.emptyRepository,
    headSha: remote.head,
    baseTreeSha: remote.baseTreeSha,
    projectPath,
    changes,
    unchanged,
    remoteOnly: remoteOnly.sort(),
    blocked: findings,
    tooLarge,
    ignored,
    uploadBytes,
    deleteRemoved: options.deleteRemoved ?? false,
  };
}

/** Whether a path is ignored by the project's own .gitignore files (checked lazily, only for remote-only paths). */
async function isLocallyIgnored(vfs: Vfs, root: string, path: string): Promise<boolean> {
  const rules = new IgnoreRules();
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    try {
      rules.add(dir, (await vfs.readText(joinPath(root, dir, '.gitignore'))).text);
    } catch {
      // no .gitignore here
    }
  }
  return rules.isIgnored(path);
}

/** Human-readable preview lines for the confirmation dialog and the terminal. */
export function describePlan(plan: SyncPlan): string[] {
  const lines = [`Destination: github.com/${plan.owner}/${plan.repo} · branch ${plan.branch}${plan.createsBranch ? ` (new, from ${plan.baseBranch ?? 'nothing'})` : ''}`];
  if (plan.projectPath) lines.push(`Repository folder: ${plan.projectPath}/`);
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const c of plan.changes) counts[c.status]++;
  lines.push(`Changes: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted · ${plan.unchanged} unchanged · upload ${formatBytes(plan.uploadBytes)}`);
  for (const c of plan.changes.slice(0, 200)) lines.push(`  ${c.status === 'added' ? 'A' : c.status === 'modified' ? 'M' : 'D'}  ${c.repoPath}${c.status === 'deleted' ? '' : `  (${formatBytes(c.size)})`}`);
  if (plan.changes.length > 200) lines.push(`  … and ${plan.changes.length - 200} more`);
  if (plan.remoteOnly.length && !plan.deleteRemoved) lines.push(`Kept on GitHub (not in this project): ${plan.remoteOnly.length} file(s). Use --delete to remove them.`);
  if (plan.blocked.length) {
    lines.push(`Not uploaded - secrets detected (${plan.blocked.length}):`);
    for (const f of plan.blocked) lines.push(`  !  ${f.path}: ${f.reason}${f.line ? ` (line ${f.line})` : ''}`);
  }
  if (plan.tooLarge.length) lines.push(`Not uploaded - larger than 50 MB: ${plan.tooLarge.join(', ')}`);
  if (plan.ignored) lines.push(`Ignored by .gitignore / defaults: ${plan.ignored} item(s).`);
  return lines;
}

export interface SyncResult {
  commitSha: string;
  branch: string;
  uploaded: number;
  deleted: number;
  noChanges: boolean;
  commitUrl: string;
}

/** Uploads the plan's changes and moves the branch. Throws CONFLICT if the branch moved since planning. */
export async function executeSync(
  gh: GitHubClient,
  vfs: Vfs,
  projectRoot: string,
  plan: SyncPlan,
  options: { message: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<SyncResult> {
  const base = `/repos/${plan.owner}/${plan.repo}`;
  const uploads = plan.changes.filter((c) => c.status !== 'deleted');
  const deletions = plan.changes.filter((c) => c.status === 'deleted');
  const commitUrl = (sha: string) => `https://github.com/${plan.owner}/${plan.repo}/commit/${sha}`;
  if (!plan.changes.length && !plan.createsBranch && plan.headSha) {
    return { commitSha: plan.headSha, branch: plan.branch, uploaded: 0, deleted: 0, noChanges: true, commitUrl: commitUrl(plan.headSha) };
  }

  let headSha = plan.headSha;
  let baseTreeSha = plan.baseTreeSha;
  let pending = uploads;
  let createsBranch = plan.createsBranch;

  if (plan.emptyRepository) {
    // The Git Data API cannot write to a repository without commits; create the first commit with one file.
    const first = uploads.find((c) => c.localPath.toLowerCase() === 'readme.md') ?? uploads[0];
    if (!first) throw new TerminiaError('VALIDATION', 'Nothing to upload to the empty repository.');
    const data = await vfs.readBytes(joinPath(projectRoot, first.localPath));
    const created = await gh.put(
      `${base}/contents/${encodePath(first.repoPath)}`,
      { message: options.message, content: bytesToBase64(data), branch: plan.branch },
      contentPutSchema,
    );
    headSha = created.commit.sha;
    baseTreeSha = (await gh.get(`${base}/git/commits/${headSha}`, gitCommitSchema, { signal: options.signal })).tree.sha;
    pending = uploads.filter((c) => c !== first);
    createsBranch = false;
    if (!pending.length && !deletions.length) {
      return { commitSha: headSha, branch: plan.branch, uploaded: 1, deleted: 0, noChanges: false, commitUrl: commitUrl(headSha) };
    }
  }

  let done = 0;
  const total = pending.length;
  options.onProgress?.(0, total);
  const entries = await mapLimit(pending, 4, async (change) => {
    throwIfAborted(options.signal);
    const data = await vfs.readBytes(joinPath(projectRoot, change.localPath), MAX_FILE_BYTES);
    const sha = await gitBlobSha(data);
    if (sha !== change.sha) {
      throw new TerminiaError('CONFLICT', `${change.localPath} changed after the preview. Review the sync again.`);
    }
    const blob = await gh.post(`${base}/git/blobs`, { content: bytesToBase64(data), encoding: 'base64' }, blobCreatedSchema, { signal: options.signal, retries: 2 });
    if (blob.sha !== sha) throw new TerminiaError('PROVIDER', `GitHub stored ${change.repoPath} with an unexpected id; aborting before committing.`);
    done++;
    options.onProgress?.(done, total);
    return { path: change.repoPath, mode: change.mode, type: 'blob', sha };
  });
  const tree = [...entries, ...deletions.map((d) => ({ path: d.repoPath, mode: d.mode, type: 'blob', sha: null }))];

  throwIfAborted(options.signal);
  const newTree = await gh.post(`${base}/git/trees`, { ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree }, treeCreatedSchema, { signal: options.signal });
  const commit = await gh.post(
    `${base}/git/commits`,
    { message: options.message, tree: newTree.sha, parents: headSha ? [headSha] : [] },
    gitCommitSchema,
    { signal: options.signal },
  );
  try {
    if (createsBranch) {
      await gh.post(`${base}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit.sha }, gitRefSchema);
    } else {
      await gh.patch(`${base}/git/refs/heads/${encodePath(plan.branch)}`, { sha: commit.sha, force: false }, gitRefSchema);
    }
  } catch (error) {
    if (error instanceof TerminiaError && (error.code === 'VALIDATION' || error.code === 'CONFLICT')) {
      throw new TerminiaError('CONFLICT', `${plan.branch} changed on GitHub after the preview, so the branch was not updated (no force push).`, {
        hint: 'Run the sync again to review the new state.',
      });
    }
    throw error;
  }
  return {
    commitSha: commit.sha,
    branch: plan.branch,
    uploaded: entries.length + (plan.emptyRepository ? 1 : 0),
    deleted: deletions.length,
    noChanges: false,
    commitUrl: commitUrl(commit.sha),
  };
}
