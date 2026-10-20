import { TerminiaError } from '../core/errors';
import { normalizePipName, parsePipRequirement } from './manifests';

/**
 * Edits dependency manifests as text, keeping the file's own formatting where
 * possible. These edits only change what the project DECLARES; nothing is
 * installed until an install runs on a builder or remote host.
 */

export type NodeSection = 'dependencies' | 'devDependencies';
const NODE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function detectIndent(text: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(text);
  if (!match) return 2;
  return match[0].includes('\t') ? '\t' : match[0].length;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

export interface EditResult {
  text: string;
  changes: { name: string; from?: string; to?: string }[];
}

export function editPackageJson(text: string, operation: 'add' | 'remove', packages: { name: string; spec?: string }[], section: NodeSection = 'dependencies'): EditResult {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new TerminiaError('VALIDATION', 'package.json is not valid JSON.');
  }
  const indent = detectIndent(text);
  const changes: EditResult['changes'] = [];
  for (const { name, spec } of packages) {
    let from: string | undefined;
    for (const s of NODE_SECTIONS) {
      const deps = pkg[s] as Record<string, string> | undefined;
      if (deps && name in deps) {
        from ??= deps[name];
        if (operation === 'remove' || s !== section) delete deps[name];
        if (deps && !Object.keys(deps).length && s !== section) delete pkg[s];
      }
    }
    if (operation === 'add') {
      if (!spec) throw new TerminiaError('INVALID_ARGUMENT', `No version for ${name}.`);
      const target = { ...((pkg[section] as Record<string, string> | undefined) ?? {}), [name]: spec };
      pkg[section] = sortKeys(target);
      changes.push({ name, from, to: spec });
    } else {
      if (from === undefined) throw new TerminiaError('NOT_FOUND', `${name} is not a dependency in package.json.`);
      changes.push({ name, from });
    }
  }
  return { text: `${JSON.stringify(pkg, null, indent)}${text.endsWith('\n') ? '\n' : ''}`, changes };
}

export function editRequirements(text: string, operation: 'add' | 'remove', packages: { name: string; extras?: string; spec?: string }[]): EditResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.length ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const changes: EditResult['changes'] = [];
  for (const p of packages) {
    const target = normalizePipName(p.name);
    let from: string | undefined;
    let replaced = false;
    const next: string[] = [];
    for (const line of lines) {
      const req = parsePipRequirement(line);
      if (req && normalizePipName(req.name) === target) {
        from = req.spec || '(any)';
        if (operation === 'add' && !replaced) {
          next.push(`${p.name}${p.extras ?? ''}${p.spec ?? ''}${req.marker ? ` ; ${req.marker}` : ''}`);
          replaced = true;
        }
        continue;
      }
      next.push(line);
    }
    if (operation === 'add' && !replaced) next.push(`${p.name}${p.extras ?? ''}${p.spec ?? ''}`);
    if (operation === 'remove' && from === undefined) throw new TerminiaError('NOT_FOUND', `${p.name} is not listed in requirements.txt.`);
    lines = next;
    changes.push({ name: p.name, from, to: operation === 'add' ? p.spec || '(any)' : undefined });
  }
  return { text: lines.join(eol) + eol, changes };
}

/**
 * Edits the `dependencies = [ ... ]` array of the [project] table in
 * pyproject.toml without reformatting the rest of the file.
 */
export function editPyproject(text: string, operation: 'add' | 'remove', packages: { name: string; extras?: string; spec?: string }[]): EditResult {
  const project = /^\[project\]\s*$/m.exec(text);
  if (!project) throw new TerminiaError('UNSUPPORTED', 'pyproject.toml has no [project] table.', { hint: 'For Poetry projects, run `poetry add` on a remote host.' });
  const tableStart = project.index + project[0].length;
  const nextTable = /^\[/m.exec(text.slice(tableStart));
  const tableEnd = nextTable ? tableStart + nextTable.index : text.length;
  const table = text.slice(tableStart, tableEnd);
  const deps = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(table);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let items: string[] = [];
  let multiline = true;
  if (deps) {
    items = [...deps[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    multiline = deps[1]!.includes('\n');
  }
  const changes: EditResult['changes'] = [];
  for (const p of packages) {
    const target = normalizePipName(p.name);
    const index = items.findIndex((item) => {
      const req = parsePipRequirement(item);
      return req ? normalizePipName(req.name) === target : false;
    });
    const from = index === -1 ? undefined : (parsePipRequirement(items[index]!)?.spec || '(any)');
    if (operation === 'add') {
      const value = `${p.name}${p.extras ?? ''}${p.spec ?? ''}`;
      if (index === -1) items.push(value);
      else items[index] = value;
      changes.push({ name: p.name, from, to: p.spec || '(any)' });
    } else {
      if (index === -1) throw new TerminiaError('NOT_FOUND', `${p.name} is not in [project].dependencies.`);
      items.splice(index, 1);
      changes.push({ name: p.name, from });
    }
  }
  const rendered = !items.length
    ? 'dependencies = []'
    : multiline || items.length > 2
      ? `dependencies = [${eol}${items.map((i) => `    "${i.replace(/"/g, '\\"')}",`).join(eol)}${eol}]`
      : `dependencies = [${items.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(', ')}]`;
  let newTable: string;
  if (deps) newTable = table.slice(0, deps.index) + rendered + table.slice(deps.index + deps[0].length);
  else newTable = `${table.replace(/\s*$/, '')}${eol}${rendered}${eol}${eol}`;
  return { text: text.slice(0, tableStart) + newTable + text.slice(tableEnd), changes };
}
