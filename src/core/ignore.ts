/**
 * .gitignore-compatible matching, used to decide which project files are
 * synchronised to a repository and which are included in exported archives.
 *
 * Supported: comments, blank lines, negation (!), directory-only patterns
 * (trailing /), anchored patterns (containing /), *, ?, [...] classes, **,
 * escaped characters, and nested .gitignore files (rules of a deeper file
 * apply to its own directory and override shallower ones). As in Git, a file
 * inside an ignored directory cannot be re-included.
 */

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

interface RuleSet {
  base: string;
  rules: Rule[];
}

/** Defaults applied to every sync and export, before the project's own .gitignore. */
export const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  '.DS_Store',
  'Thumbs.db',
  '.gradle/',
  '/android/app/build/',
  '/android/build/',
  '/android/.idea/',
  '/android/local.properties',
  '/ios/App/Pods/',
  '/ios/App/build/',
  '/ios/App/App/public/',
  'DerivedData/',
  'xcuserdata/',
  '__pycache__/',
  '*.pyc',
  '.venv/',
  '.terminia/cache/',
].join('\n');

export class IgnoreRules {
  private sets: RuleSet[] = [];

  /** Adds the rules of an ignore file located in directory `base` ("" for the project root). */
  add(base: string, text: string): this {
    const rules = parseIgnore(text);
    if (rules.length) this.sets.push({ base: base.replace(/^\/+|\/+$/g, ''), rules });
    // Shallower directories first, so deeper rules are evaluated later and win.
    this.sets.sort((a, b) => depth(a.base) - depth(b.base));
    return this;
  }

  /** Whether `path` itself matches (does not check parent directories). */
  matches(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const set of this.sets) {
      let relative: string;
      if (set.base === '') relative = path;
      else if (path.startsWith(`${set.base}/`)) relative = path.slice(set.base.length + 1);
      else continue;
      for (const rule of set.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(relative)) ignored = !rule.negate;
      }
    }
    return ignored;
  }

  /** Whether `path` or any of its parent directories is ignored. */
  isIgnored(path: string, isDir = false): boolean {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      if (this.matches(parts.slice(0, i).join('/'), true)) return true;
    }
    return this.matches(parts.join('/'), isDir);
  }
}

function depth(base: string): number {
  return base === '' ? 0 : base.split('/').length;
}

export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    const body = translate(line);
    const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
    rules.push({ regex: new RegExp(source), negate, dirOnly });
  }
  return rules;
}

function translate(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0;
        const prevSlash = i > 0 && pattern[i - 1] === '/';
        const nextSlash = pattern[i + 2] === '/';
        const atEnd = i + 2 >= pattern.length;
        if ((atStart || prevSlash) && nextSlash) {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (prevSlash && atEnd) {
          out += '.*';
          i += 2;
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      out += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = end + 1;
    } else if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]!);
      i += 2;
    } else {
      out += escapeRegex(c);
      i += 1;
    }
  }
  return out;
}

function escapeRegex(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** The .gitignore written into new projects and offered by `terminia ci install`. */
export const GITIGNORE_TEMPLATE = `# Dependencies
node_modules/
.venv/
venv/
__pycache__/
*.pyc

# Build output
dist/
build/
.gradle/
android/app/build/
ios/App/Pods/
ios/App/build/
DerivedData/
*.ipa
*.apk
*.aab

# Capacitor-generated web assets
ios/App/App/public/
android/app/src/main/assets/public/

# Secrets - never commit these
.env
.env.*
!.env.example
*.p12
*.pfx
*.p8
*.mobileprovision
*.jks
*.keystore
keystore.properties
key.properties

# Editor and OS files
.DS_Store
Thumbs.db
.idea/
.vscode/*
!.vscode/extensions.json
xcuserdata/
`;
