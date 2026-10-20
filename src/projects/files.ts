import { DEFAULT_IGNORES, IgnoreRules } from '../core/ignore';
import { joinPath } from '../core/paths';
import { applyAllowlist, parseSecretAllowlist, scanFile, type SecretFinding } from '../core/secrets';
import type { Vfs, WalkFile } from '../fs/vfs';

/**
 * The set of project files that may leave the device (repository sync,
 * archive export): defaults + .gitignore (nested) + .terminiaignore, minus
 * detected secrets.
 */

export interface CollectOptions {
  includeIgnored?: boolean;
  signal?: AbortSignal;
  maxFiles?: number;
}

export interface CollectedFiles {
  files: WalkFile[];
  ignored: number;
}

async function readOptional(vfs: Vfs, path: string): Promise<string | null> {
  try {
    return (await vfs.readText(path)).text;
  } catch {
    return null;
  }
}

export async function collectProjectFiles(vfs: Vfs, root: string, options: CollectOptions = {}): Promise<CollectedFiles> {
  const rules = new IgnoreRules().add('', DEFAULT_IGNORES);
  const terminiaIgnore = await readOptional(vfs, joinPath(root, '.terminiaignore'));
  if (terminiaIgnore) rules.add('', terminiaIgnore);
  let ignored = 0;
  const files = await vfs.walk(root, {
    signal: options.signal,
    maxFiles: options.maxFiles,
    onDirectory: async (dir) => {
      if (options.includeIgnored) return;
      const gitignore = await readOptional(vfs, joinPath(root, dir, '.gitignore'));
      if (gitignore) rules.add(dir, gitignore);
    },
    ignore: (path, isDir) => {
      // .git and node_modules are always skipped, even with includeIgnored.
      if (/(^|\/)(\.git|node_modules)$/.test(path) && isDir) {
        ignored++;
        return true;
      }
      if (options.includeIgnored) return false;
      const skip = rules.matches(path, isDir);
      if (skip) ignored++;
      return skip;
    },
  });
  return { files, ignored };
}

export interface ScannedFiles {
  allowed: WalkFile[];
  findings: SecretFinding[];
}

/** Reads and scans each file. Files with findings are excluded (blocked always; suspicious unless allowlisted). */
export async function scanForSecrets(
  vfs: Vfs,
  root: string,
  files: WalkFile[],
  read: (path: string) => Promise<Uint8Array | null> = async (p) => vfs.readBytes(joinPath(root, p)),
): Promise<ScannedFiles> {
  const allowlistText = await readOptional(vfs, joinPath(root, '.terminia/allow-secrets.txt'));
  const allowlist = allowlistText ? parseSecretAllowlist(allowlistText) : new Set<string>();
  const findings: SecretFinding[] = [];
  const allowed: WalkFile[] = [];
  for (const file of files) {
    const content = file.size <= 1024 * 1024 ? await read(file.path) : null;
    const fileFindings = applyAllowlist(scanFile(file.path, content), allowlist);
    if (fileFindings.length) findings.push(...fileFindings);
    else allowed.push(file);
  }
  return { allowed, findings };
}
