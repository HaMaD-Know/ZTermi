import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { ProjectReader } from '../projects/detect';

/**
 * Reads dependency manifests and lockfiles. This is static parsing on the
 * iPad: it shows what the project declares and, where a lockfile exists, the
 * exact versions that installs resolve to. Installing happens on a builder or
 * a remote host (see service.ts).
 */

export type Ecosystem = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'gradle' | 'cocoapods' | 'swiftpm' | 'powershell';
export type DependencyGroup = 'prod' | 'dev' | 'optional' | 'peer' | 'build' | 'test';

export interface Dependency {
  name: string;
  spec: string;
  locked?: string;
  group: DependencyGroup;
  source?: string;
}

export interface ManifestInfo {
  ecosystem: Ecosystem;
  manifest: string;
  lockfile?: string;
  dependencies: Dependency[];
  /** Where installations for this ecosystem actually run. */
  owner: string;
  /** Whether Terminia can add/remove entries in this manifest itself. */
  editable: boolean;
  notes: string[];
}

export const OWNER: Record<Ecosystem, string> = {
  npm: 'npm on a GitHub Actions Linux runner, or on your remote host (no Node.js on iPad)',
  pnpm: 'pnpm on a GitHub Actions Linux runner, or on your remote host',
  yarn: 'Yarn on a GitHub Actions Linux runner, or on your remote host',
  pip: 'pip in a virtual environment on a GitHub Actions runner, or on your remote host',
  gradle: 'Gradle on the Android builder',
  cocoapods: 'CocoaPods on the macOS builder',
  swiftpm: 'Swift Package Manager on the macOS builder',
  powershell: 'Install-Module / Install-PSResource on a remote PowerShell host',
};

async function read(reader: ProjectReader, path: string): Promise<string | null> {
  try {
    return await reader.readText(path);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ npm

export function npmLockVersions(lockText: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const lock = JSON.parse(lockText) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
      if (key.startsWith('node_modules/') && !key.slice(13).includes('node_modules/') && value.version) versions.set(key.slice(13), value.version);
    }
    for (const [name, value] of Object.entries(lock.dependencies ?? {})) {
      if (!versions.has(name) && value.version) versions.set(name, value.version);
    }
  } catch {
    // invalid lockfile: no locked versions
  }
  return versions;
}

export function pnpmLockVersions(lockText: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const lock = parseYaml(lockText) as Record<string, unknown>;
    const importer = ((lock.importers as Record<string, unknown> | undefined)?.['.'] ?? lock) as Record<string, unknown>;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = importer[section] as Record<string, unknown> | undefined;
      for (const [name, value] of Object.entries(deps ?? {})) {
        const version = typeof value === 'string' ? value : (value as { version?: string })?.version;
        if (version) versions.set(name, String(version).replace(/\(.*$/, ''));
      }
    }
  } catch {
    // ignore
  }
  return versions;
}

/** Splits "name@range" / "@scope/name@range" keys (also "name@npm:range"). */
function packageNameOfKey(key: string): string {
  const k = key.replace(/^"|"$/g, '').trim();
  const at = k.indexOf('@', 1);
  return at === -1 ? k : k.slice(0, at);
}

export function yarnLockVersions(lockText: string): Map<string, string> {
  const versions = new Map<string, string>();
  const lines = lockText.split(/\r?\n/);
  let names: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(' ') && line.endsWith(':')) {
      names = line
        .slice(0, -1)
        .split(/,\s*/)
        .map(packageNameOfKey)
        .filter((n) => n && n !== '__metadata');
      continue;
    }
    const match = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (match && names.length) {
      for (const name of names) if (!versions.has(name)) versions.set(name, match[1]!);
      names = [];
    }
  }
  return versions;
}

async function readNode(reader: ProjectReader): Promise<ManifestInfo | null> {
  const text = await read(reader, 'package.json');
  if (text === null) return null;
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { ecosystem: 'npm', manifest: 'package.json', dependencies: [], owner: OWNER.npm, editable: false, notes: ['package.json is not valid JSON.'] };
  }
  const pnpm = await read(reader, 'pnpm-lock.yaml');
  const yarn = pnpm === null ? await read(reader, 'yarn.lock') : null;
  const npm = pnpm === null && yarn === null ? await read(reader, 'package-lock.json') : null;
  const ecosystem: Ecosystem = pnpm !== null ? 'pnpm' : yarn !== null ? 'yarn' : 'npm';
  const locked = pnpm !== null ? pnpmLockVersions(pnpm) : yarn !== null ? yarnLockVersions(yarn) : npm !== null ? npmLockVersions(npm) : new Map<string, string>();
  const groups: [string, DependencyGroup][] = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['optionalDependencies', 'optional'],
    ['peerDependencies', 'peer'],
  ];
  const dependencies: Dependency[] = [];
  for (const [section, group] of groups) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      dependencies.push({ name, spec: String(spec), locked: locked.get(name), group, source: 'registry.npmjs.org' });
    }
  }
  const lockfile = pnpm !== null ? 'pnpm-lock.yaml' : yarn !== null ? 'yarn.lock' : npm !== null ? 'package-lock.json' : undefined;
  return {
    ecosystem,
    manifest: 'package.json',
    lockfile,
    dependencies,
    owner: OWNER[ecosystem],
    editable: true,
    notes: lockfile ? [] : ['No lockfile: versions are resolved freshly on every install. `terminia deps install` creates package-lock.json.'],
  };
}

// --------------------------------------------------------------- Python

interface PoetryTable {
  dependencies?: Record<string, unknown>;
  'dev-dependencies'?: Record<string, unknown>;
  group?: Record<string, { dependencies?: Record<string, unknown> }>;
}

interface PyProject {
  project?: { dependencies?: string[]; 'optional-dependencies'?: Record<string, string[]> };
  'dependency-groups'?: Record<string, unknown[]>;
  'build-system'?: { requires?: string[] };
  tool?: { poetry?: PoetryTable };
}

export interface PipRequirement {
  name: string;
  extras: string;
  spec: string;
  marker: string;
}

export function parsePipRequirement(line: string): PipRequirement | null {
  const clean = line.replace(/\s+#.*$/, '').trim();
  if (!clean || clean.startsWith('#') || clean.startsWith('-')) return null;
  const [body, marker = ''] = clean.split(';', 2);
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(body!.trim());
  if (!match) return null;
  return { name: match[1]!, extras: match[2] ?? '', spec: match[3]!.trim(), marker: marker.trim() };
}

export function normalizePipName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function tomlLockVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  try {
    const lock = parseToml(text) as { package?: { name?: string; version?: string }[] };
    for (const p of lock.package ?? []) if (p.name && p.version) versions.set(normalizePipName(p.name), p.version);
  } catch {
    // ignore
  }
  return versions;
}

function pipLockFromFreeze(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)/.exec(line.trim());
    if (m) versions.set(normalizePipName(m[1]!), m[2]!);
  }
  return versions;
}

async function readPython(reader: ProjectReader): Promise<ManifestInfo[]> {
  const out: ManifestInfo[] = [];
  const poetryLock = await read(reader, 'poetry.lock');
  const uvLock = await read(reader, 'uv.lock');
  const freeze = await read(reader, 'requirements.lock.txt');
  const locked = poetryLock ? tomlLockVersions(poetryLock) : uvLock ? tomlLockVersions(uvLock) : freeze ? pipLockFromFreeze(freeze) : new Map<string, string>();
  const lockfile = poetryLock ? 'poetry.lock' : uvLock ? 'uv.lock' : freeze ? 'requirements.lock.txt' : undefined;

  const requirements = await read(reader, 'requirements.txt');
  if (requirements !== null) {
    const dependencies = requirements
      .split(/\r?\n/)
      .map(parsePipRequirement)
      .filter((r): r is PipRequirement => r !== null)
      .map((r) => ({ name: r.name + r.extras, spec: r.spec + (r.marker ? ` ; ${r.marker}` : ''), locked: locked.get(normalizePipName(r.name)), group: 'prod' as const, source: 'pypi.org' }));
    out.push({ ecosystem: 'pip', manifest: 'requirements.txt', lockfile, dependencies, owner: OWNER.pip, editable: true, notes: [] });
  }

  const pyproject = await read(reader, 'pyproject.toml');
  if (pyproject !== null) {
    const dependencies: Dependency[] = [];
    const notes: string[] = [];
    try {
      const doc = parseToml(pyproject) as PyProject;
      const add = (spec: string, group: DependencyGroup) => {
        const r = parsePipRequirement(spec);
        if (r) dependencies.push({ name: r.name + r.extras, spec: r.spec, locked: locked.get(normalizePipName(r.name)), group, source: 'pypi.org' });
      };
      for (const d of doc.project?.dependencies ?? []) add(d, 'prod');
      for (const [, list] of Object.entries(doc.project?.['optional-dependencies'] ?? {})) for (const d of list) add(d, 'optional');
      for (const [group, list] of Object.entries(doc['dependency-groups'] ?? {})) {
        for (const d of list) if (typeof d === 'string') add(d, group === 'test' ? 'test' : 'dev');
      }
      for (const d of doc['build-system']?.requires ?? []) add(d, 'build');
      const poetry = doc.tool?.poetry;
      const poetryDeps = (table: Record<string, unknown> | undefined, group: DependencyGroup) => {
        for (const [name, value] of Object.entries(table ?? {})) {
          if (name.toLowerCase() === 'python') continue;
          const spec = typeof value === 'string' ? value : (value as { version?: string })?.version ?? '(table)';
          dependencies.push({ name, spec, locked: locked.get(normalizePipName(name)), group, source: 'pypi.org' });
        }
      };
      if (poetry) {
        poetryDeps(poetry.dependencies, 'prod');
        poetryDeps(poetry['dev-dependencies'], 'dev');
        for (const [group, value] of Object.entries(poetry.group ?? {})) {
          poetryDeps(value.dependencies, group === 'test' ? 'test' : 'dev');
        }
        notes.push('Poetry project: add or remove packages with `poetry add` on a remote host; Terminia edits only [project].dependencies.');
      }
    } catch (error) {
      notes.push(`pyproject.toml could not be parsed: ${(error as Error).message}`);
    }
    out.push({ ecosystem: 'pip', manifest: 'pyproject.toml', lockfile, dependencies, owner: OWNER.pip, editable: true, notes });
  }
  return out;
}

// --------------------------------------------------------------- Gradle

const GRADLE_CONFIGS = 'implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|releaseImplementation|kapt|ksp|annotationProcessor|classpath|coreLibraryDesugaring';

export function parseGradleDependencies(text: string): Dependency[] {
  const out: Dependency[] = [];
  const re = new RegExp(`\\b(${GRADLE_CONFIGS})\\s*\\(?\\s*["']([^"':\\s]+):([^"':\\s]+)(?::([^"'\\s]+))?["']`, 'g');
  for (const m of text.matchAll(re)) {
    const config = m[1]!;
    const group: DependencyGroup = /test/i.test(config) ? 'test' : config === 'classpath' || config === 'kapt' || config === 'ksp' || config === 'annotationProcessor' ? 'build' : 'prod';
    out.push({ name: `${m[2]}:${m[3]}`, spec: m[4] ?? '(managed)', group, source: 'Maven repositories' });
  }
  const catalogRe = new RegExp(`\\b(${GRADLE_CONFIGS})\\s*\\(\\s*libs\\.([A-Za-z0-9_.-]+)\\s*\\)`, 'g');
  for (const m of text.matchAll(catalogRe)) {
    out.push({ name: `libs.${m[2]}`, spec: '(version catalog)', group: /test/i.test(m[1]!) ? 'test' : 'prod', source: 'gradle/libs.versions.toml' });
  }
  return out;
}

function parseVersionCatalog(text: string): Map<string, { module: string; version: string }> {
  const out = new Map<string, { module: string; version: string }>();
  try {
    const doc = parseToml(text) as { versions?: Record<string, string>; libraries?: Record<string, unknown> };
    for (const [alias, value] of Object.entries(doc.libraries ?? {})) {
      if (typeof value === 'string') {
        const [g, a, ver] = value.split(':');
        out.set(alias, { module: `${g}:${a}`, version: ver ?? '' });
      } else if (value && typeof value === 'object') {
        const v = value as { module?: string; group?: string; name?: string; version?: string | { ref?: string } };
        const module = v.module ?? `${v.group}:${v.name}`;
        const version = typeof v.version === 'string' ? v.version : v.version?.ref ? (doc.versions?.[v.version.ref] ?? '') : '';
        out.set(alias, { module, version });
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function readGradle(reader: ProjectReader): Promise<ManifestInfo | null> {
  for (const base of ['android/', '']) {
    for (const file of ['app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts']) {
      const text = await read(reader, base + file);
      if (text === null) continue;
      const dependencies = parseGradleDependencies(text);
      const catalogText = await read(reader, `${base}gradle/libs.versions.toml`);
      if (catalogText) {
        const catalog = parseVersionCatalog(catalogText);
        for (const dep of dependencies) {
          const entry = dep.name.startsWith('libs.') ? catalog.get(dep.name.slice(5).replace(/\./g, '-')) ?? catalog.get(dep.name.slice(5)) : undefined;
          if (entry) {
            dep.name = entry.module;
            dep.spec = entry.version || dep.spec;
          }
        }
      }
      return {
        ecosystem: 'gradle',
        manifest: base + file,
        dependencies,
        owner: OWNER.gradle,
        editable: false,
        notes: ['Read statically from the build file. Gradle resolves the full graph on the Android builder (`terminia deps list --ecosystem gradle`).'],
      };
    }
  }
  return null;
}

// --------------------------------------------------------- CocoaPods/SPM

async function readCocoaPods(reader: ProjectReader): Promise<ManifestInfo | null> {
  for (const dir of ['ios/App/', 'ios/', '']) {
    const podfile = await read(reader, `${dir}Podfile`);
    if (podfile === null) continue;
    const lock = (await read(reader, `${dir}Podfile.lock`)) ?? '';
    const locked = new Map<string, string>();
    for (const m of lock.matchAll(/^\s{2}- ([^\s(]+) \(([^)]+)\)/gm)) locked.set(m[1]!, m[2]!);
    const dependencies: Dependency[] = [];
    for (const m of podfile.matchAll(/^\s*pod\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/gm)) {
      dependencies.push({ name: m[1]!, spec: m[2] ?? '(any)', locked: locked.get(m[1]!), group: 'prod', source: 'CocoaPods trunk' });
    }
    return { ecosystem: 'cocoapods', manifest: `${dir}Podfile`, lockfile: lock ? `${dir}Podfile.lock` : undefined, dependencies, owner: OWNER.cocoapods, editable: false, notes: [] };
  }
  return null;
}

async function readSwiftPm(reader: ProjectReader): Promise<ManifestInfo | null> {
  for (const path of ['Package.swift', 'ios/App/CapApp-SPM/Package.swift']) {
    const text = await read(reader, path);
    if (text === null) continue;
    const resolvedPath = path.replace('Package.swift', 'Package.resolved');
    const resolved = await read(reader, resolvedPath);
    const pins = new Map<string, string>();
    if (resolved) {
      try {
        const doc = JSON.parse(resolved) as { pins?: { identity?: string; location?: string; state?: { version?: string; revision?: string } }[]; object?: { pins?: { package?: string; repositoryURL?: string; state?: { version?: string } }[] } };
        for (const pin of doc.pins ?? []) if (pin.location) pins.set(pin.location.replace(/\.git$/, ''), pin.state?.version ?? pin.state?.revision?.slice(0, 7) ?? '');
        for (const pin of doc.object?.pins ?? []) if (pin.repositoryURL) pins.set(pin.repositoryURL.replace(/\.git$/, ''), pin.state?.version ?? '');
      } catch {
        // ignore
      }
    }
    const dependencies: Dependency[] = [];
    for (const m of text.matchAll(/\.package\(\s*url:\s*"([^"]+)"\s*,\s*([^)]*)\)/g)) {
      const url = m[1]!.replace(/\.git$/, '');
      const rule = /(from|exact|branch|revision):\s*"([^"]+)"/.exec(m[2]!);
      const range = /"([^"]+)"\s*\.\.(?:<|\.)\s*"([^"]+)"/.exec(m[2]!);
      dependencies.push({ name: url.replace(/^https:\/\/github\.com\//, ''), spec: rule ? `${rule[1]} ${rule[2]}` : range ? `${range[1]}..<${range[2]}` : m[2]!.trim(), locked: pins.get(url), group: 'prod', source: url });
    }
    for (const m of text.matchAll(/\.package\(\s*name:\s*"([^"]+)"\s*,\s*path:\s*"([^"]+)"\s*\)/g)) {
      dependencies.push({ name: m[1]!, spec: `local ${m[2]}`, group: 'prod', source: 'local package (from node_modules)' });
    }
    return {
      ecosystem: 'swiftpm',
      manifest: path,
      lockfile: resolved ? resolvedPath : undefined,
      dependencies,
      owner: OWNER.swiftpm,
      editable: false,
      notes: path.includes('CapApp-SPM') ? ['Managed by the Capacitor CLI (`npx cap sync`): change Capacitor plugins in package.json instead.'] : [],
    };
  }
  return null;
}

// ----------------------------------------------------------- PowerShell

export function parsePsd1RequiredModules(text: string): Dependency[] {
  const block = /RequiredModules\s*=\s*@\(([\s\S]*?)\)\s*(?:\r?\n\s*[A-Za-z]+\s*=|\r?\n\s*})/m.exec(text);
  if (!block) return [];
  const out: Dependency[] = [];
  const body = block[1]!;
  for (const m of body.matchAll(/@\{([^}]*)\}/g)) {
    const name = /ModuleName\s*=\s*['"]([^'"]+)['"]/.exec(m[1]!)?.[1];
    const version = /(?:Required|Module|Maximum)Version\s*=\s*['"]([^'"]+)['"]/.exec(m[1]!)?.[1];
    if (name) out.push({ name, spec: version ?? '(any)', group: 'prod', source: 'PowerShell Gallery' });
  }
  const withoutTables = body.replace(/@\{[^}]*\}/g, '');
  for (const m of withoutTables.matchAll(/['"]([A-Za-z0-9_.-]+)['"]/g)) out.push({ name: m[1]!, spec: '(any)', group: 'prod', source: 'PowerShell Gallery' });
  return out;
}

async function readPowerShell(reader: ProjectReader): Promise<ManifestInfo | null> {
  let entries;
  try {
    entries = await reader.list('');
  } catch {
    return null;
  }
  const psd1 = entries.find((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.psd1'));
  if (!psd1) return null;
  const text = (await read(reader, psd1.name)) ?? '';
  return { ecosystem: 'powershell', manifest: psd1.name, dependencies: parsePsd1RequiredModules(text), owner: OWNER.powershell, editable: false, notes: [] };
}

export async function readManifests(reader: ProjectReader): Promise<ManifestInfo[]> {
  const out: ManifestInfo[] = [];
  const node = await readNode(reader);
  if (node) out.push(node);
  out.push(...(await readPython(reader)));
  for (const fn of [readGradle, readCocoaPods, readSwiftPm, readPowerShell]) {
    const info = await fn(reader);
    if (info) out.push(info);
  }
  return out;
}
