#!/usr/bin/env node
/**
 * Static checks of the iOS project wiring - what can be verified without Xcode
 * (Swift is compiled on the macOS runner by the iOS workflow):
 *  - every Swift file in ios/App/App/Terminia is compiled by the App target
 *  - the bridge view controller registers every plugin and is the root view controller
 *  - Swift plugin methods match the TypeScript contracts exactly, each with an @objc implementation
 *  - Swift rejection codes are ones the TypeScript side maps
 *  - Info.plist keys, bundle id, Capacitor version pin, and no signing material in ios/
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xcode from 'xcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
let failures = 0;
let passed = 0;
const check = (ok, label) => {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}`);
};

const nativeDir = 'ios/App/App/Terminia';
if (!existsSync(path.join(root, nativeDir))) {
  console.error('ios/App/App/Terminia is missing. Run "npx cap add ios" and "node scripts/wire-ios.mjs".');
  process.exit(1);
}
const swiftFiles = readdirSync(path.join(root, nativeDir)).filter((f) => f.endsWith('.swift'));
const swift = Object.fromEntries(swiftFiles.map((f) => [f, read(`${nativeDir}/${f}`)]));

// 1. Compiled by the App target
const project = xcode.project(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'));
project.parseSync();
const objects = project.hash.project.objects;
const appTarget = Object.values(objects.PBXNativeTarget).find((t) => typeof t === 'object' && t.name === 'App');
const sourcesPhase = appTarget.buildPhases.map((p) => objects.PBXSourcesBuildPhase?.[p.value]).find(Boolean);
const compiled = new Set(sourcesPhase.files.map((f) => objects.PBXBuildFile[f.value].fileRef_comment));
for (const file of swiftFiles) check(compiled.has(file), `${file} is compiled by the App target`);
for (const file of ['AppDelegate.swift', 'SceneDelegate.swift']) check(compiled.has(file), `${file} is compiled by the App target`);

// 2. Registration and root view controller
const bridge = swift['TerminiaBridgeViewController.swift'] ?? '';
const plugins = [];
for (const [file, text] of Object.entries(swift)) {
  for (const m of text.matchAll(/@objc\((\w+)\)\s*public class (\w+): CAPPlugin/g)) plugins.push({ file, cls: m[2], text });
}
check(plugins.length === 3, `three plugins found (${plugins.map((p) => p.cls).join(', ')})`);
for (const p of plugins) check(bridge.includes(`registerPluginInstance(${p.cls}())`), `${p.cls} is registered in TerminiaBridgeViewController`);
check(read('ios/App/App/SceneDelegate.swift').includes('rootViewController = TerminiaBridgeViewController()'), 'SceneDelegate uses TerminiaBridgeViewController');
check(read('ios/App/App/Base.lproj/Main.storyboard').includes('customClass="TerminiaBridgeViewController" customModule="App"'), 'Main.storyboard uses TerminiaBridgeViewController');

// 3. Method parity with src/platform/plugins.ts
const ts = read('src/platform/plugins.ts');
const tsMethods = (iface) => {
  const body = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(ts)?.[1] ?? '';
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'addListener');
};
const jsNames = Object.fromEntries([...ts.matchAll(/registerPlugin<(\w+)>\('(\w+)'\)/g)].map((m) => [m[2], m[1]]));
for (const p of plugins) {
  const jsName = /jsName = "(\w+)"/.exec(p.text)?.[1];
  const iface = jsNames[jsName];
  check(!!iface, `${p.cls} jsName '${jsName}' is registered in plugins.ts`);
  if (!iface) continue;
  const declared = [...p.text.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
  const expected = tsMethods(iface).sort();
  check(JSON.stringify(declared) === JSON.stringify(expected), `${p.cls} methods match ${iface} (${expected.join(', ')})`);
  for (const method of declared) check(new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)`).test(p.text), `${p.cls}.${method} has an @objc implementation`);
}
check(/notifyListeners\("downloadProgress"/.test(swift['TerminiaHttpPlugin.swift'] ?? '') && ts.includes("'downloadProgress'"), 'downloadProgress event names match');

// 4. Rejection codes understood by TypeScript
const known = new Set([
  ...[...read('src/core/errors.ts').matchAll(/\| '([A-Z_]+)'/g)].map((m) => m[1]),
  'ROOT_NOT_OPEN',
  'NOT_DOWNLOADED',
  'NO_SPACE',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_ORIGIN',
  'PIN_MISMATCH',
]);
const used = new Set();
for (const text of Object.values(swift)) {
  for (const m of text.matchAll(/(?:reject\([^;\n]*?, |TerminiaFileError\.code\(|failure = \()"([A-Z_]+)"/g)) used.add(m[1]);
}
const unknown = [...used].filter((c) => !known.has(c));
check(unknown.length === 0, `Swift error codes are known to TypeScript${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ` (${used.size} codes)`}`);

// 5. Info.plist, bundle id, versions
const plist = read('ios/App/App/Info.plist');
for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace', 'NSLocalNetworkUsageDescription', 'NSAllowsLocalNetworking', 'ITSAppUsesNonExemptEncryption']) {
  check(plist.includes(`<key>${key}</key>`), `Info.plist has ${key}`);
}
check(!plist.includes('<string>armv7</string>'), 'Info.plist requires arm64, not armv7');
const appId = /appId: '([^']+)'/.exec(read('capacitor.config.ts'))?.[1];
const bundleIds = [...read('ios/App/App.xcodeproj/project.pbxproj').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
check(bundleIds.length > 0 && bundleIds.every((b) => b === appId), `bundle identifier matches capacitor.config.ts (${appId})`);
const pkg = JSON.parse(read('package.json'));
const capIos = pkg.dependencies['@capacitor/ios'];
check(read('ios/App/CapApp-SPM/Package.swift').includes(`capacitor-swift-pm.git", exact: "${capIos}"`), `Package.swift pins capacitor-swift-pm ${capIos}`);
check(pkg.dependencies['@capacitor/core'] === capIos && pkg.devDependencies['@capacitor/cli'] === capIos, 'Capacitor core, CLI and iOS versions are identical');

// 6. No signing material in the native project
const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'public' || name === 'DerivedData' || name === 'build') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(p12|pfx|mobileprovision|p8|jks|keystore|cer)$/i.test(name)) bad.push(path.relative(root, p));
  }
};
walk(path.join(root, 'ios'));
check(bad.length === 0, `no signing material inside ios/${bad.length ? ` (${bad.join(', ')})` : ''}`);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
