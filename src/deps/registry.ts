import { TerminiaError } from '../core/errors';
import { parse, v } from '../core/validate';
import type { HttpClient } from '../net/http';
import { normalizePipName, parsePipRequirement } from './manifests';

/**
 * Package name / version validation and read-only registry lookups. Lookups
 * only fetch metadata (they never download or run package code); the source
 * registry is always reported to the user.
 */

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function validateNpmName(name: string): string {
  if (!name || name.length > 214) throw new TerminiaError('INVALID_ARGUMENT', `'${name}' is not a valid npm package name (length).`);
  if (!NPM_NAME.test(name)) {
    throw new TerminiaError('INVALID_ARGUMENT', `'${name}' is not a valid npm package name.`, {
      hint: 'npm names are lowercase and URL-safe, optionally scoped (@scope/name). Git URLs and local paths are not accepted.',
    });
  }
  if (name.startsWith('.') || name.startsWith('_')) throw new TerminiaError('INVALID_ARGUMENT', `npm package names cannot start with '.' or '_'.`);
  return name;
}

const NPM_RANGE = /^[0-9A-Za-z.^~<>=*|xX +-]+$/;
const DIST_TAG = /^[a-z][a-z0-9._-]{0,50}$/;

export function validateNpmSpec(spec: string): string {
  const s = spec.trim();
  if (!s) throw new TerminiaError('INVALID_ARGUMENT', 'Empty version range.');
  if (/^(git|https?|file|link|workspace|npm):/i.test(s) || s.includes('/')) {
    throw new TerminiaError('INVALID_ARGUMENT', `'${s}' is not a registry version. Terminia only adds packages from the npm registry.`);
  }
  if (!NPM_RANGE.test(s) && !DIST_TAG.test(s)) throw new TerminiaError('INVALID_ARGUMENT', `'${s}' is not a valid version range.`);
  return s;
}

/** "lodash", "lodash@^4.17.0", "@types/node@22" -> { name, spec? } */
export function parseNpmSpecifier(input: string): { name: string; spec?: string } {
  const at = input.indexOf('@', 1);
  const name = at === -1 ? input : input.slice(0, at);
  const spec = at === -1 ? undefined : input.slice(at + 1);
  return { name: validateNpmName(name), spec: spec === undefined ? undefined : validateNpmSpec(spec) };
}

const PEP440_CLAUSE = /^(===|==|~=|!=|<=|>=|<|>)\s*[0-9A-Za-z.*+!_-]+$/;

export function validatePipSpecifier(input: string): { name: string; extras: string; spec: string } {
  if (/[:@]|\/|\\/.test(input) && !/;/.test(input)) {
    throw new TerminiaError('INVALID_ARGUMENT', `'${input}' is not a PyPI requirement. URLs and local paths are not accepted.`);
  }
  const req = parsePipRequirement(input);
  if (!req || !/^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/.test(req.name)) {
    throw new TerminiaError('INVALID_ARGUMENT', `'${input}' is not a valid Python requirement (PEP 508).`);
  }
  if (req.marker) throw new TerminiaError('INVALID_ARGUMENT', 'Environment markers are not supported here; edit the file directly.');
  if (req.spec) {
    for (const clause of req.spec.split(',')) {
      if (!PEP440_CLAUSE.test(clause.trim())) throw new TerminiaError('INVALID_ARGUMENT', `'${clause.trim()}' is not a valid version specifier (PEP 440).`);
    }
  }
  return { name: req.name, extras: req.extras, spec: req.spec };
}

export interface RegistryInfo {
  ecosystem: 'npm' | 'pip';
  name: string;
  latest: string;
  description: string;
  versions: number;
  registry: string;
  deprecated?: string;
  homepage?: string;
}

const npmSchema = v.object({
  name: v.string(),
  'dist-tags': v.record(v.string()),
  versions: v.record(v.object({ deprecated: v.optional(v.string()) })),
  description: v.optional(v.string()),
  homepage: v.optional(v.string()),
});

const pypiSchema = v.object({
  info: v.object({
    name: v.string(),
    version: v.string(),
    summary: v.nullable(v.string()),
    home_page: v.nullable(v.string()),
    yanked: v.withDefault(v.boolean(), false),
  }),
  releases: v.record(v.unknown()),
});

export async function npmInfo(http: HttpClient, name: string, signal?: AbortSignal): Promise<RegistryInfo> {
  validateNpmName(name);
  const url = `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
  const response = await http.request({ url, headers: { Accept: 'application/json' }, signal, maxBytes: 20 * 1024 * 1024 });
  if (response.status === 404) throw new TerminiaError('NOT_FOUND', `npm has no package named '${name}'.`);
  if (response.status >= 400) throw new TerminiaError('NETWORK', `registry.npmjs.org answered ${response.status}.`, { retryable: true });
  const doc = parse(npmSchema, JSON.parse(response.text), 'npm registry response');
  const latest = doc['dist-tags'].latest;
  if (!latest) throw new TerminiaError('NOT_FOUND', `'${name}' has no published "latest" version.`);
  return {
    ecosystem: 'npm',
    name: doc.name,
    latest,
    description: doc.description ?? '',
    versions: Object.keys(doc.versions).length,
    registry: 'registry.npmjs.org',
    deprecated: doc.versions[latest]?.deprecated,
    homepage: doc.homepage,
  };
}

export async function pypiInfo(http: HttpClient, name: string, signal?: AbortSignal): Promise<RegistryInfo> {
  const normalized = normalizePipName(name);
  const response = await http.request({ url: `https://pypi.org/pypi/${encodeURIComponent(normalized)}/json`, headers: { Accept: 'application/json' }, signal, maxBytes: 20 * 1024 * 1024 });
  if (response.status === 404) throw new TerminiaError('NOT_FOUND', `PyPI has no project named '${name}'.`);
  if (response.status >= 400) throw new TerminiaError('NETWORK', `pypi.org answered ${response.status}.`, { retryable: true });
  const doc = parse(pypiSchema, JSON.parse(response.text), 'PyPI response');
  return {
    ecosystem: 'pip',
    name: doc.info.name,
    latest: doc.info.version,
    description: doc.info.summary ?? '',
    versions: Object.keys(doc.releases).length,
    registry: 'pypi.org',
    deprecated: doc.info.yanked ? 'latest release is yanked' : undefined,
    homepage: doc.info.home_page ?? undefined,
  };
}
