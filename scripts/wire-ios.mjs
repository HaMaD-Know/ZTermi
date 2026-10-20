#!/usr/bin/env node
/**
 * Wires Terminia's native code into the Capacitor-generated iOS project.
 * Idempotent: safe to run after `npx cap add ios` or `npx cap sync ios`.
 *
 *  - adds ios/App/App/Terminia/*.swift to the App target (deterministic ids)
 *  - makes TerminiaBridgeViewController the root view controller
 *  - sets the Info.plist keys Terminia needs (Files app access, local network)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xcode from 'xcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'ios', 'App', 'App');
const pbxPath = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
if (!existsSync(pbxPath)) {
  console.error('ios/App/App.xcodeproj not found. Run `npx cap add ios` first.');
  process.exit(1);
}

const swiftFiles = readdirSync(path.join(app, 'Terminia'))
  .filter((f) => f.endsWith('.swift'))
  .sort();
const id = (kind, index) => `7E4A1${kind}${String(index).padStart(18, '0')}`.slice(0, 24).toUpperCase();
const GROUP_ID = id('A', 0);

let pbx = readFileSync(pbxPath, 'utf8');
const insertAfter = (marker, text) => {
  const at = pbx.indexOf(marker);
  if (at === -1) throw new Error(`Marker not found in project.pbxproj: ${marker}`);
  pbx = pbx.slice(0, at + marker.length) + text + pbx.slice(at + marker.length);
};

let added = 0;
if (!pbx.includes(`${GROUP_ID} /* Terminia */`)) {
  insertAfter(
    '/* Begin PBXGroup section */\n',
    `\t\t${GROUP_ID} /* Terminia */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t);\n\t\t\tpath = Terminia;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`,
  );
  const appGroup = /(504EC3061FED79650016851F \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/;
  if (!appGroup.test(pbx)) throw new Error('App group not found in project.pbxproj');
  pbx = pbx.replace(appGroup, `$1\t\t\t\t${GROUP_ID} /* Terminia */,\n`);
}
swiftFiles.forEach((file, index) => {
  const fileRef = id('F', index + 1);
  const buildFile = id('B', index + 1);
  if (pbx.includes(`/* ${file} */ = {isa = PBXFileReference`)) return;
  insertAfter('/* Begin PBXFileReference section */\n', `\t\t${fileRef} /* ${file} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${file}; sourceTree = "<group>"; };\n`);
  insertAfter('/* Begin PBXBuildFile section */\n', `\t\t${buildFile} /* ${file} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${file} */; };\n`);
  pbx = pbx.replace(
    new RegExp(`(${GROUP_ID} \\/\\* Terminia \\*\\/ = \\{\\n\\t\\t\\tisa = PBXGroup;\\n\\t\\t\\tchildren = \\(\\n)`),
    `$1\t\t\t\t${fileRef} /* ${file} */,\n`,
  );
  pbx = pbx.replace(
    /(\/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = \d+;\n\t\t\tfiles = \(\n)/,
    `$1\t\t\t\t${buildFile} /* ${file} in Sources */,\n`,
  );
  added++;
});
writeFileSync(pbxPath, pbx);

// Validate that the edited project still parses and contains every file in the App target.
const project = xcode.project(pbxPath);
project.parseSync();
const sources = Object.values(project.hash.project.objects.PBXBuildFile).filter((v) => typeof v === 'object').map((v) => v.fileRef_comment);
for (const file of swiftFiles) if (!sources.includes(file)) throw new Error(`${file} is not compiled by the project`);

// Root view controller
const scenePath = path.join(app, 'SceneDelegate.swift');
let scene = readFileSync(scenePath, 'utf8');
if (scene.includes('rootViewController = CAPBridgeViewController()')) {
  scene = scene.replace('rootViewController = CAPBridgeViewController()', 'rootViewController = TerminiaBridgeViewController()');
  writeFileSync(scenePath, scene);
}
const storyboardPath = path.join(app, 'Base.lproj', 'Main.storyboard');
let storyboard = readFileSync(storyboardPath, 'utf8');
if (storyboard.includes('customClass="CAPBridgeViewController" customModule="Capacitor"')) {
  storyboard = storyboard.replace(
    'customClass="CAPBridgeViewController" customModule="Capacitor"',
    'customClass="TerminiaBridgeViewController" customModule="App" customModuleProvider="target"',
  );
  writeFileSync(storyboardPath, storyboard);
}

// Info.plist
const plistPath = path.join(app, 'Info.plist');
let plist = readFileSync(plistPath, 'utf8');
// Terminia is an arm64-only app; the template still lists armv7.
plist = plist.replace('<string>armv7</string>', '<string>arm64</string>');
const keys = [
  ['UIFileSharingEnabled', '<true/>'],
  ['LSSupportsOpeningDocumentsInPlace', '<true/>'],
  ['ITSAppUsesNonExemptEncryption', '<false/>'],
  [
    'NSLocalNetworkUsageDescription',
    '<string>Terminia connects to the Terminia agent on computers in your network when you run commands on a remote PowerShell host.</string>',
  ],
  ['NSAppTransportSecurity', '<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>'],
];
for (const [key, value] of keys) {
  if (plist.includes(`<key>${key}</key>`)) continue;
  plist = plist.replace(/\n<\/dict>\n<\/plist>\s*$/, `\n\t<key>${key}</key>\n\t${value}\n</dict>\n</plist>\n`);
}
writeFileSync(plistPath, plist);

console.log(`iOS project wired: ${swiftFiles.length} Swift files (${added} newly added), TerminiaBridgeViewController, Info.plist keys.`);
