import { TerminiaError } from '../core/errors';
import type { DirEntry } from '../fs/backend';

/**
 * Project detection from the files in a project's root (and a few well-known
 * sub-folders). It answers two questions honestly: what kind of project this
 * is, and which build targets can actually be built from it.
 */

export type ProjectType = 'capacitor' | 'node' | 'web' | 'python' | 'android-gradle' | 'xcode' | 'powershell' | 'static-web';
export type BuildPlatform = 'ios' | 'android' | 'web';

export interface TargetAssessment {
  platform: BuildPlatform;
  viable: boolean;
  reason: string;
  notes: string[];
}

export interface Detection {
  types: ProjectType[];
  capacitor?: { appId?: string; appName?: string; webDir?: string; configFile: string; version?: string };
  packageManager?: 'npm' | 'pnpm' | 'yarn';
  hasLockfile: boolean;
  buildScript?: string;
  ios: { nativeProject?: string; workspace?: string; usesCocoaPods: boolean; usesSpm: boolean };
  android: { nativeProject?: string; gradleKts: boolean; hasWrapper: boolean };
  python?: { manifest: string };
  targets: TargetAssessment[];
  /** True when more than one build target is viable and none was chosen explicitly. */
  ambiguous: boolean;
}

export interface ProjectReader {
  list(path: string): Promise<DirEntry[]>;
  readText(path: string): Promise<string | null>;
}

async function safeList(reader: ProjectReader, path: string): Promise<DirEntry[]> {
  try {
    return await reader.list(path);
  } catch (error) {
    if (error instanceof TerminiaError && (error.code === 'NOT_FOUND' || error.code === 'NOT_A_DIRECTORY')) return [];
    throw error;
  }
}

function capacitorField(source: string, field: string): string | undefined {
  const match = new RegExp(`["']?${field}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(source);
  return match?.[1];
}

export async function detectProject(reader: ProjectReader): Promise<Detection> {
  const root = await safeList(reader, '');
  const names = new Set(root.map((e) => e.name));
  const dirs = new Set(root.filter((e) => e.type === 'directory').map((e) => e.name));
  const types: ProjectType[] = [];

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null = null;
  if (names.has('package.json')) {
    const text = await reader.readText('package.json');
    try {
      pkg = text ? JSON.parse(text) : null;
    } catch {
      pkg = null;
    }
  }
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  // Capacitor
  const capConfigFile = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json'].find((f) => names.has(f));
  let capacitor: Detection['capacitor'];
  if (capConfigFile || '@capacitor/core' in allDeps) {
    types.push('capacitor');
    capacitor = { configFile: capConfigFile ?? '(missing)', version: allDeps['@capacitor/core'] };
    if (capConfigFile) {
      const source = (await reader.readText(capConfigFile)) ?? '';
      if (capConfigFile.endsWith('.json')) {
        try {
          const json = JSON.parse(source) as Record<string, unknown>;
          capacitor.appId = typeof json.appId === 'string' ? json.appId : undefined;
          capacitor.appName = typeof json.appName === 'string' ? json.appName : undefined;
          capacitor.webDir = typeof json.webDir === 'string' ? json.webDir : undefined;
        } catch {
          // reported through the missing appId note below
        }
      } else {
        capacitor.appId = capacitorField(source, 'appId');
        capacitor.appName = capacitorField(source, 'appName');
        capacitor.webDir = capacitorField(source, 'webDir');
      }
    }
  }

  const packageManager: Detection['packageManager'] = names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : pkg ? 'npm' : undefined;
  const hasLockfile = names.has('package-lock.json') || names.has('pnpm-lock.yaml') || names.has('yarn.lock');
  const buildScript = pkg?.scripts?.build;
  if (pkg && !types.includes('capacitor')) types.push(buildScript ? 'web' : 'node');
  if (pkg && types.includes('capacitor') && buildScript) types.push('web');

  // iOS native project
  const ios: Detection['ios'] = { usesCocoaPods: false, usesSpm: false };
  const findXcode = (entries: DirEntry[], prefix: string) => {
    const ws = entries.find((e) => e.name.endsWith('.xcworkspace') && e.type === 'directory');
    const proj = entries.find((e) => e.name.endsWith('.xcodeproj') && e.type === 'directory');
    if (proj && !ios.nativeProject) ios.nativeProject = prefix + proj.name;
    if (ws && !ios.workspace) ios.workspace = prefix + ws.name;
    if (entries.some((e) => e.name === 'Podfile')) ios.usesCocoaPods = true;
    if (entries.some((e) => e.name === 'Package.swift' || e.name === 'CapApp-SPM')) ios.usesSpm = true;
  };
  findXcode(root, '');
  if (dirs.has('ios')) {
    findXcode(await safeList(reader, 'ios'), 'ios/');
    findXcode(await safeList(reader, 'ios/App'), 'ios/App/');
  }
  if (ios.nativeProject && !types.includes('capacitor')) types.push('xcode');

  // Android
  const android: Detection['android'] = { gradleKts: false, hasWrapper: false };
  const gradleIn = async (dir: string) => {
    const entries = dir ? await safeList(reader, dir) : root;
    const build = entries.find((e) => e.name === 'build.gradle' || e.name === 'build.gradle.kts');
    const settings = entries.find((e) => e.name === 'settings.gradle' || e.name === 'settings.gradle.kts');
    return { build, settings, wrapper: entries.some((e) => e.name === 'gradlew') };
  };
  if (dirs.has('android')) {
    const g = await gradleIn('android');
    if (g.build || g.settings) {
      android.nativeProject = 'android';
      android.gradleKts = g.build?.name.endsWith('.kts') ?? false;
      android.hasWrapper = g.wrapper;
    }
  }
  if (!android.nativeProject) {
    const g = await gradleIn('');
    if (g.settings || g.build) {
      const appBuild = (await reader.readText('app/build.gradle')) ?? (await reader.readText('app/build.gradle.kts')) ?? (await reader.readText(g.build?.name ?? 'build.gradle')) ?? '';
      if (/com\.android\.application|android\s*\{/.test(appBuild)) {
        types.push('android-gradle');
        android.nativeProject = '.';
        android.gradleKts = g.build?.name.endsWith('.kts') ?? false;
        android.hasWrapper = g.wrapper;
      }
    }
  }

  // Python
  let python: Detection['python'];
  const pyManifest = ['pyproject.toml', 'setup.py', 'requirements.txt'].find((f) => names.has(f));
  if (pyManifest) {
    types.push('python');
    python = { manifest: pyManifest };
  }

  // PowerShell
  if (root.some((e) => /\.(ps1|psm1|psd1)$/i.test(e.name))) types.push('powershell');

  // Plain static site
  if (!pkg && names.has('index.html')) types.push('static-web');

  const targets = assessTargets({ types, capacitor, ios, android, buildScript, hasLockfile, python, packageManager });
  const viable = targets.filter((t) => t.viable);
  return {
    types,
    capacitor,
    packageManager,
    hasLockfile,
    buildScript,
    ios,
    android,
    python,
    targets,
    ambiguous: viable.length > 1,
  };
}

function assessTargets(d: Pick<Detection, 'types' | 'capacitor' | 'ios' | 'android' | 'buildScript' | 'hasLockfile' | 'python' | 'packageManager'>): TargetAssessment[] {
  const out: TargetAssessment[] = [];
  const isCap = d.types.includes('capacitor');

  // iOS
  if (isCap) {
    const notes: string[] = [];
    if (!d.capacitor?.appId) notes.push('No appId found in the Capacitor config; the bundle identifier will come from the Xcode project.');
    if (d.ios.nativeProject) notes.push(`Native project: ${d.ios.nativeProject}`);
    else notes.push('No ios/ folder. The builder will run `npx cap add ios` (enable/disable with ios.generateNative).');
    if (!d.hasLockfile) notes.push('No lockfile: the builder runs `npm install`, so dependency versions are not reproducible. `terminia deps install` can create one.');
    out.push({ platform: 'ios', viable: true, reason: 'Capacitor project - built with Xcode on a macOS runner.', notes });
  } else if (d.types.includes('xcode')) {
    out.push({
      platform: 'ios',
      viable: true,
      reason: 'Xcode project - built on a macOS runner.',
      notes: [`Project: ${d.ios.workspace ?? d.ios.nativeProject}`, ...(d.ios.usesCocoaPods ? ['CocoaPods will be installed on the builder.'] : [])],
    });
  } else {
    out.push({ platform: 'ios', viable: false, reason: 'Not an iOS-capable project: no Capacitor configuration and no Xcode project.', notes: [] });
  }

  // Android
  if (isCap) {
    out.push({
      platform: 'android',
      viable: true,
      reason: 'Capacitor project - built with Gradle on a Linux runner.',
      notes: d.android.nativeProject ? [`Native project: ${d.android.nativeProject}`] : ['No android/ folder. The builder will run `npx cap add android`.'],
    });
  } else if (d.types.includes('android-gradle')) {
    out.push({
      platform: 'android',
      viable: true,
      reason: 'Android Gradle project - built on a Linux runner.',
      notes: d.android.hasWrapper ? [] : ['No Gradle wrapper (gradlew); the builder uses its preinstalled Gradle.'],
    });
  } else {
    out.push({ platform: 'android', viable: false, reason: 'Not an Android project: no Capacitor configuration and no Android Gradle build.', notes: [] });
  }

  // Web / Node / Python
  if (d.buildScript) {
    out.push({ platform: 'web', viable: true, reason: `package.json has a build script (\`${d.buildScript}\`).`, notes: [] });
  } else if (d.python) {
    out.push({
      platform: 'web',
      viable: d.python.manifest !== 'requirements.txt',
      reason: d.python.manifest === 'requirements.txt' ? 'Python project without pyproject.toml/setup.py: nothing to package.' : 'Python package - built with `python -m build`.',
      notes: [],
    });
  } else if (d.types.includes('static-web')) {
    out.push({ platform: 'web', viable: true, reason: 'Static web site - packaged as a zip artifact.', notes: [] });
  } else if (d.packageManager) {
    out.push({ platform: 'web', viable: false, reason: 'package.json has no build script. Add one, or use a custom build profile.', notes: [] });
  } else {
    out.push({ platform: 'web', viable: false, reason: 'No web, Node.js or Python build found.', notes: [] });
  }
  return out;
}

export function describeTypes(types: ProjectType[]): string {
  const labels: Record<ProjectType, string> = {
    capacitor: 'Capacitor',
    node: 'Node.js',
    web: 'Web app',
    python: 'Python',
    'android-gradle': 'Android (Gradle)',
    xcode: 'Xcode',
    powershell: 'PowerShell',
    'static-web': 'Static site',
  };
  return types.length ? types.map((t) => labels[t]).join(', ') : 'Unknown';
}
