import { TerminiaError } from '../core/errors';
import { basename, joinPath } from '../core/paths';
import type { Vfs } from '../fs/vfs';

/**
 * The CI templates shipped inside the app (templates/ in this repository).
 * `terminia ci install` writes them into a project as .github/workflows/*.yml
 * and .terminia/ci/*, where they are visible, editable and synced like any
 * other project file.
 */

const RAW = import.meta.glob('../../templates/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface TemplateFile {
  /** Destination inside the project. */
  path: string;
  content: string;
  id: string;
  version: number;
}

const MARKER = /terminia-template:\s*([a-z0-9-]+)\s+v(\d+)/;

function parseMarker(content: string): { id: string; version: number } | null {
  const match = MARKER.exec(content.slice(0, 400));
  return match ? { id: match[1]!, version: Number(match[2]) } : null;
}

function destinationFor(source: string): string | null {
  const rel = source.replace(/^.*\/templates\//, '');
  if (rel.startsWith('github/workflows/')) return `.github/workflows/${basename(rel)}`;
  if (rel.startsWith('terminia-ci/')) return `.terminia/ci/${basename(rel)}`;
  return null;
}

export const TEMPLATE_FILES: TemplateFile[] = Object.entries(RAW)
  .map(([source, content]) => {
    const path = destinationFor(source);
    const marker = parseMarker(content);
    if (!path || !marker) return null;
    return { path, content: content.replace(/\r\n/g, '\n'), id: marker.id, version: marker.version };
  })
  .filter((t): t is TemplateFile => t !== null)
  .sort((a, b) => a.path.localeCompare(b.path));

export const WORKFLOW_FILES = {
  ios: 'terminia-ios.yml',
  android: 'terminia-android.yml',
  web: 'terminia-build.yml',
  deps: 'terminia-deps.yml',
} as const;

export function templateFor(path: string): TemplateFile | undefined {
  return TEMPLATE_FILES.find((t) => t.path === path);
}

export type TemplateState = 'missing' | 'current' | 'outdated' | 'modified' | 'foreign';

export interface TemplateStatus {
  path: string;
  state: TemplateState;
  installedVersion?: number;
  bundledVersion: number;
}

export function compareTemplate(template: TemplateFile, existing: string | null): TemplateStatus {
  const base = { path: template.path, bundledVersion: template.version };
  if (existing === null) return { ...base, state: 'missing' };
  const normalized = existing.replace(/\r\n/g, '\n');
  if (normalized === template.content) return { ...base, state: 'current', installedVersion: template.version };
  const marker = parseMarker(normalized);
  if (!marker || marker.id !== template.id) return { ...base, state: 'foreign' };
  if (marker.version < template.version) return { ...base, state: 'outdated', installedVersion: marker.version };
  return { ...base, state: 'modified', installedVersion: marker.version };
}

async function readOptional(vfs: Vfs, path: string): Promise<string | null> {
  try {
    return (await vfs.readText(path)).text;
  } catch (error) {
    if (error instanceof TerminiaError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function templateStatus(vfs: Vfs, projectRoot: string): Promise<TemplateStatus[]> {
  const out: TemplateStatus[] = [];
  for (const template of TEMPLATE_FILES) out.push(compareTemplate(template, await readOptional(vfs, joinPath(projectRoot, template.path))));
  return out;
}

export interface InstallResult {
  written: string[];
  unchanged: string[];
  /** Files edited locally (or not Terminia's) that were left alone; use force to replace them. */
  skipped: TemplateStatus[];
}

export async function installTemplates(vfs: Vfs, projectRoot: string, options: { force?: boolean } = {}): Promise<InstallResult> {
  const result: InstallResult = { written: [], unchanged: [], skipped: [] };
  for (const status of await templateStatus(vfs, projectRoot)) {
    const template = templateFor(status.path)!;
    if (status.state === 'current') {
      result.unchanged.push(status.path);
      continue;
    }
    if ((status.state === 'modified' || status.state === 'foreign') && !options.force) {
      result.skipped.push(status);
      continue;
    }
    await vfs.writeText(joinPath(projectRoot, template.path), template.content);
    result.written.push(template.path);
  }
  return result;
}

/** Workflow inputs each template declares (checked against what Terminia sends, in tests). */
export function workflowTemplate(name: string): TemplateFile | undefined {
  return TEMPLATE_FILES.find((t) => t.path === `.github/workflows/${name}`);
}
