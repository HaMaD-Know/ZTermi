import { describe, expect, it } from 'vitest';
import { editPackageJson, editPyproject, editRequirements } from '../../src/deps/edit';
import { npmLockVersions, parseGradleDependencies, parsePsd1RequiredModules, pnpmLockVersions, readManifests, yarnLockVersions } from '../../src/deps/manifests';
import { parseNpmSpecifier, validatePipSpecifier } from '../../src/deps/registry';
import { MemoryFsBackend } from '../../src/fs/backend';
import { detectProject } from '../../src/projects/detect';
import { parseConfig, parseRepoSlug, defaultConfig, serializeConfig } from '../../src/projects/config';
import { TEMPLATES } from '../../src/projects/templates';

function reader(files: Record<string, string>) {
  const fs = new MemoryFsBackend('p', files);
  return {
    list: (path: string) => fs.list(path),
    readText: async (path: string) => {
      try {
        return (await fs.readText(path)).text;
      } catch {
        return null;
      }
    },
  };
}

describe('dependency manifests', () => {
  it('reads package.json with locked versions from each lockfile format', async () => {
    const pkg = JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { vite: '8.3.4' } });
    const npm = await readManifests(reader({ 'package.json': pkg, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '19.1.0' }, 'node_modules/vite': { version: '8.3.4' }, 'node_modules/a/node_modules/react': { version: '1.0.0' } } }) }));
    expect(npm[0]).toMatchObject({ ecosystem: 'npm', lockfile: 'package-lock.json', editable: true });
    expect(npm[0]!.dependencies).toEqual([
      { name: 'react', spec: '^19.0.0', locked: '19.1.0', group: 'prod', source: 'registry.npmjs.org' },
      { name: 'vite', spec: '8.3.4', locked: '8.3.4', group: 'dev', source: 'registry.npmjs.org' },
    ]);
    expect(pnpmLockVersions("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^19.0.0\n        version: 19.1.0(typescript@6.0.3)\n").get('react')).toBe('19.1.0');
    const yarn1 = '# yarn lockfile v1\n\n"react@^19.0.0", react@~19:\n  version "19.1.0"\n  resolved "x"\n\n"@types/node@^24":\n  version "24.19.2"\n';
    expect(Object.fromEntries(yarnLockVersions(yarn1))).toEqual({ react: '19.1.0', '@types/node': '24.19.2' });
    const berry = '__metadata:\n  version: 8\n\n"react@npm:^19.0.0":\n  version: 19.1.0\n  resolution: "react@npm:19.1.0"\n';
    expect(yarnLockVersions(berry).get('react')).toBe('19.1.0');
    expect(npmLockVersions('not json').size).toBe(0);
  });

  it('reads Python requirements, pyproject and locks', async () => {
    const manifests = await readManifests(
      reader({
        'requirements.txt': '# deps\nrequests[socks]>=2.31 ; python_version > "3.8"\n-r other.txt\nflask==3.0.0\n',
        'pyproject.toml': '[project]\nname = "x"\ndependencies = ["httpx>=0.27"]\n[project.optional-dependencies]\ndev = ["pytest"]\n[build-system]\nrequires = ["setuptools>=69"]\n',
        'uv.lock': '[[package]]\nname = "httpx"\nversion = "0.28.1"\n',
      }),
    );
    expect(manifests.map((m) => m.manifest)).toEqual(['requirements.txt', 'pyproject.toml']);
    expect(manifests[0]!.dependencies.map((d) => [d.name, d.spec])).toEqual([
      ['requests[socks]', '>=2.31 ; python_version > "3.8"'],
      ['flask', '==3.0.0'],
    ]);
    expect(manifests[1]!.dependencies.map((d) => [d.name, d.group, d.locked])).toEqual([
      ['httpx', 'prod', '0.28.1'],
      ['pytest', 'optional', undefined],
      ['setuptools', 'build', undefined],
    ]);
  });

  it('parses Gradle, CocoaPods, SwiftPM and PowerShell manifests read-only', async () => {
    expect(parseGradleDependencies('dependencies {\n  implementation "androidx.core:core-ktx:1.15.0"\n  testImplementation("junit:junit:4.13.2")\n  implementation(libs.androidx.appcompat)\n}')).toEqual([
      { name: 'androidx.core:core-ktx', spec: '1.15.0', group: 'prod', source: 'Maven repositories' },
      { name: 'junit:junit', spec: '4.13.2', group: 'test', source: 'Maven repositories' },
      { name: 'libs.androidx.appcompat', spec: '(version catalog)', group: 'prod', source: 'gradle/libs.versions.toml' },
    ]);
    const manifests = await readManifests(
      reader({
        'ios/App/Podfile': "platform :ios, '15.0'\npod 'Alamofire', '~> 5.9'\n",
        'ios/App/Podfile.lock': 'PODS:\n  - Alamofire (5.9.1)\n',
        'Package.swift': '.package(url: "https://github.com/apple/swift-log.git", from: "1.6.0")',
        'Package.resolved': JSON.stringify({ pins: [{ identity: 'swift-log', location: 'https://github.com/apple/swift-log.git', state: { version: '1.6.2' } }] }),
        'Tools.psd1': "@{\n  RootModule = 'Tools.psm1'\n  RequiredModules = @('PSReadLine', @{ ModuleName = 'Pester'; ModuleVersion = '5.6.0' })\n  FunctionsToExport = @()\n}",
      }),
    );
    expect(manifests.find((m) => m.ecosystem === 'cocoapods')!.dependencies[0]).toMatchObject({ name: 'Alamofire', spec: '~> 5.9', locked: '5.9.1' });
    expect(manifests.find((m) => m.ecosystem === 'swiftpm')!.dependencies[0]).toMatchObject({ name: 'apple/swift-log', spec: 'from 1.6.0', locked: '1.6.2' });
    expect(parsePsd1RequiredModules("RequiredModules = @('PSReadLine', @{ ModuleName = 'Pester'; ModuleVersion = '5.6.0' })\n  X = 1").map((d) => [d.name, d.spec])).toEqual([
      ['Pester', '5.6.0'],
      ['PSReadLine', '(any)'],
    ]);
    expect(manifests.every((m) => !m.editable)).toBe(true);
  });

  it('edits package.json keeping indentation and moving between sections', () => {
    const text = '{\n    "name": "x",\n    "dependencies": {\n        "react": "^19.0.0"\n    },\n    "devDependencies": {\n        "lodash": "^4.0.0"\n    }\n}\n';
    const added = editPackageJson(text, 'add', [{ name: 'lodash', spec: '^4.17.21' }, { name: 'axios', spec: '^1.12.0' }]);
    expect(JSON.parse(added.text)).toEqual({ name: 'x', dependencies: { axios: '^1.12.0', lodash: '^4.17.21', react: '^19.0.0' } });
    expect(added.text.startsWith('{\n    "name"')).toBe(true);
    expect(added.changes).toEqual([
      { name: 'lodash', from: '^4.0.0', to: '^4.17.21' },
      { name: 'axios', from: undefined, to: '^1.12.0' },
    ]);
    expect(() => editPackageJson(text, 'remove', [{ name: 'nope' }])).toThrow(/not a dependency/);
  });

  it('edits requirements.txt and pyproject.toml', () => {
    const req = editRequirements('flask==2.0\n# keep\nrequests>=2\n', 'add', [{ name: 'Flask', spec: '==3.0.0' }, { name: 'httpx', spec: '>=0.27' }]);
    expect(req.text).toBe('Flask==3.0.0\n# keep\nrequests>=2\nhttpx>=0.27\n');
    expect(editRequirements(req.text, 'remove', [{ name: 'requests' }]).text).toBe('Flask==3.0.0\n# keep\nhttpx>=0.27\n');
    const py = '[project]\nname = "x"\ndependencies = [\n    "httpx>=0.27",\n]\n\n[tool.x]\ny = 1\n';
    const edited = editPyproject(py, 'add', [{ name: 'rich', spec: '==14.0.0' }]);
    expect(edited.text).toBe('[project]\nname = "x"\ndependencies = [\n    "httpx>=0.27",\n    "rich==14.0.0",\n]\n\n[tool.x]\ny = 1\n');
    expect(editPyproject(edited.text, 'remove', [{ name: 'httpx' }]).text).toContain('dependencies = [\n    "rich==14.0.0",\n]');
  });

  it('only accepts registry packages, never URLs or paths', () => {
    expect(parseNpmSpecifier('@types/node@^24')).toEqual({ name: '@types/node', spec: '^24' });
    expect(parseNpmSpecifier('lodash')).toEqual({ name: 'lodash', spec: undefined });
    for (const bad of ['git+https://x/y.git', 'Lodash', '../local', 'lodash@file:../x', 'x@github:a/b']) expect(() => parseNpmSpecifier(bad)).toThrow();
    expect(validatePipSpecifier('requests[socks]>=2.31,<3')).toEqual({ name: 'requests', extras: '[socks]', spec: '>=2.31,<3' });
    for (const bad of ['https://x/y.whl', './local', 'pkg @ git+https://x', 'requests>>2']) expect(() => validatePipSpecifier(bad)).toThrow();
  });
});

describe('project detection', () => {
  it('detects a Capacitor project without native folders and explains what the builder will do', async () => {
    const files = TEMPLATES.find((t) => t.id === 'capacitor')!.files('MyApp');
    const d = await detectProject(reader(files));
    expect(d.types).toEqual(['capacitor']);
    expect(d.capacitor).toMatchObject({ appId: 'com.example.myapp', webDir: 'www', version: '8.5.3' });
    expect(d.targets.find((t) => t.platform === 'ios')).toMatchObject({ viable: true });
    expect(d.targets.find((t) => t.platform === 'ios')!.notes.join(' ')).toContain('npx cap add ios');
    expect(d.targets.find((t) => t.platform === 'web')!.viable).toBe(false);
    expect(d.ambiguous).toBe(true);
    expect(d.hasLockfile).toBe(false);
  });

  it('refuses iOS for projects that cannot be built for iOS', async () => {
    const node = await detectProject(reader(TEMPLATES.find((t) => t.id === 'node')!.files('tool')));
    expect(node.targets.find((t) => t.platform === 'ios')).toMatchObject({ viable: false, reason: expect.stringContaining('Not an iOS-capable project') });
    expect(node.targets.find((t) => t.platform === 'web')!.viable).toBe(true);
    expect(node.ambiguous).toBe(false);
  });

  it('detects native Android, Xcode, Python and PowerShell projects', async () => {
    expect((await detectProject(reader({ 'settings.gradle': '', 'app/build.gradle': "plugins { id 'com.android.application' }" }))).types).toContain('android-gradle');
    const xcode = await detectProject(reader({ 'Demo.xcodeproj/project.pbxproj': '', 'Podfile': '' }));
    expect(xcode.types).toEqual(['xcode']);
    expect(xcode.ios).toMatchObject({ nativeProject: 'Demo.xcodeproj', usesCocoaPods: true });
    expect((await detectProject(reader(TEMPLATES.find((t) => t.id === 'python')!.files('tool')))).targets.find((t) => t.platform === 'web')!.viable).toBe(true);
    expect((await detectProject(reader(TEMPLATES.find((t) => t.id === 'powershell')!.files('Tools')))).types).toContain('powershell');
  });
});

describe('project configuration', () => {
  it('fills defaults and round-trips', () => {
    const config = parseConfig('{"github":{"owner":"ada","repo":"app"},"ios":{"exportMethod":"ad-hoc"}}');
    expect(config.github).toMatchObject({ owner: 'ada', repo: 'app', projectPath: '.', sync: 'commit' });
    expect(config.ios).toMatchObject({ exportMethod: 'ad-hoc', configuration: 'release', xcodeVersion: '26.5' });
    expect(parseConfig(serializeConfig(config))).toEqual(config);
    expect(defaultConfig().android.variant).toBe('debug');
  });

  it('rejects invalid or dangerous values with every problem listed', () => {
    expect(() => parseConfig('{"github":{"owner":"a b","projectPath":"../x"},"ios":{"workflow":"x.sh"}}')).toThrow(/owner 'a b'[\s\S]*projectPath[\s\S]*ios.workflow/);
    expect(() => parseConfig('{"profiles":[{"name":"p","target":"custom","env":{"bad-name":"x"}}]}')).toThrow(/environment variable name/);
    expect(() => parseConfig('{"ios":{"exportMethod":"magic"}}')).toThrow(/unsigned \| development/);
    expect(() => parseConfig('not json')).toThrow(/not valid JSON/);
  });

  it('parses repository slugs and URLs', () => {
    expect(parseRepoSlug('ada/app')).toEqual({ owner: 'ada', repo: 'app' });
    expect(parseRepoSlug('https://github.com/ada/app.git')).toEqual({ owner: 'ada', repo: 'app' });
    expect(() => parseRepoSlug('ada')).toThrow(/owner\/name/);
  });
});
