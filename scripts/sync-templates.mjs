#!/usr/bin/env node
/**
 * Terminia builds itself with the same CI templates it installs into user
 * projects. This copies templates/github/workflows/* to .github/workflows/
 * and templates/terminia-ci/* to .terminia/ci/. With --check it only verifies
 * that the copies are identical (used by `npm run verify` and CI).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const pairs = [
  ['templates/github/workflows', '.github/workflows'],
  ['templates/terminia-ci', '.terminia/ci'],
];
const normalize = (text) => text.replace(/\r\n/g, '\n');
let problems = 0;
let copied = 0;
for (const [from, to] of pairs) {
  mkdirSync(path.join(root, to), { recursive: true });
  for (const name of readdirSync(path.join(root, from))) {
    const source = path.join(root, from, name);
    const target = path.join(root, to, name);
    const same = existsSync(target) && normalize(readFileSync(source, 'utf8')) === normalize(readFileSync(target, 'utf8'));
    if (same) continue;
    if (check) {
      console.error(`out of date: ${to}/${name} (run npm run sync:templates)`);
      problems++;
    } else {
      copyFileSync(source, target);
      copied++;
      console.log(`copied ${from}/${name} -> ${to}/${name}`);
    }
  }
}
if (check) {
  console.log(problems ? `${problems} file(s) out of date` : 'CI templates and their copies are identical');
  process.exit(problems ? 1 : 0);
}
console.log(`${copied} file(s) updated`);
