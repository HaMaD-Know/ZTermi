#!/usr/bin/env node
// terminia-template: ios-configure-signing v1
/**
 * Sets manual code signing on ONE target and ONE configuration of an Xcode
 * project. Passing signing settings on the xcodebuild command line would apply
 * them to every target, including Swift package and CocoaPods targets that
 * cannot take a provisioning profile.
 *
 * Usage: ios-configure-signing.mjs <project.pbxproj> <target name> <configuration>
 * Environment: SIGN_TEAM_ID, SIGN_IDENTITY, SIGN_PROFILE_NAME, TERMINIA_TOOLS
 * (folder where the `xcode` npm package was installed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [file, targetName, configuration] = process.argv.slice(2);
if (!file || !targetName || !configuration) {
  console.error('::error::usage: ios-configure-signing.mjs <project.pbxproj> <target> <configuration>');
  process.exit(1);
}
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`::error::${name} is not set`);
    process.exit(1);
  }
  return value;
};
const require = createRequire(path.join(env('TERMINIA_TOOLS'), 'node_modules', 'noop.js'));
const xcode = require('xcode');
const quote = (value) => `"${value.replace(/"/g, '\\"')}"`;
const unquote = (value) => String(value ?? '').replace(/^"|"$/g, '');

const project = xcode.project(file);
project.parseSync();
const objects = project.hash.project.objects;
const targets = Object.values(objects.PBXNativeTarget).filter((t) => typeof t === 'object');
const target =
  targets.find((t) => unquote(t.name).replace(/ /g, '_') === targetName) ??
  targets.find((t) => unquote(t.productType) === 'com.apple.product-type.application');
if (!target) {
  console.error(`::error::Target '${targetName}' was not found in ${file}`);
  process.exit(1);
}
const list = objects.XCConfigurationList[target.buildConfigurationList];
let changed = 0;
for (const ref of list.buildConfigurations) {
  const config = objects.XCBuildConfiguration[ref.value];
  if (unquote(config.name) !== configuration) continue;
  Object.assign(config.buildSettings, {
    CODE_SIGN_STYLE: 'Manual',
    DEVELOPMENT_TEAM: env('SIGN_TEAM_ID'),
    CODE_SIGN_IDENTITY: quote(env('SIGN_IDENTITY')),
    PROVISIONING_PROFILE_SPECIFIER: quote(env('SIGN_PROFILE_NAME')),
  });
  changed += 1;
}
if (changed !== 1) {
  console.error(`::error::Configuration '${configuration}' of target '${unquote(target.name)}' was not found`);
  process.exit(1);
}
const before = readFileSync(file, 'utf8');
writeFileSync(file, project.writeSync());
console.log(`Manual signing set on ${unquote(target.name)}/${configuration} (team ${process.env.SIGN_TEAM_ID}); project file ${before.length} -> ${readFileSync(file, 'utf8').length} bytes.`);
