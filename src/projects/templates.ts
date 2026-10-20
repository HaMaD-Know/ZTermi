import { GITIGNORE_TEMPLATE } from '../core/ignore';

/**
 * Starter projects. Versions in templates are pinned to the same Capacitor
 * release Terminia itself is built with (see package.json), so a new project
 * builds with known-compatible native tooling.
 */

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  files(name: string): Record<string, string>;
}

export const CAPACITOR_VERSION = '8.5.3';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'app'
  );
}

export function bundleIdSegment(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z]/.test(s) ? s : `app${s}`;
}

function readme(name: string, body: string): string {
  return `# ${name}\n\n${body.trim()}\n`;
}

const capacitor: ProjectTemplate = {
  id: 'capacitor',
  name: 'Capacitor app',
  description: 'Web app packaged for iOS and Android with Capacitor 8',
  files: (name) => ({
    'package.json': `${JSON.stringify(
      {
        name: slugify(name),
        version: '1.0.0',
        private: true,
        description: `${name} - a Capacitor app`,
        scripts: {},
        dependencies: {
          '@capacitor/android': CAPACITOR_VERSION,
          '@capacitor/core': CAPACITOR_VERSION,
          '@capacitor/ios': CAPACITOR_VERSION,
        },
        devDependencies: { '@capacitor/cli': CAPACITOR_VERSION },
      },
      null,
      2,
    )}\n`,
    'capacitor.config.json': `${JSON.stringify({ appId: `com.example.${bundleIdSegment(name)}`, appName: name, webDir: 'www' }, null, 2)}\n`,
    'www/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${name}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p id="status">Built with Terminia.</p>
    <button id="tap" type="button">Tap me</button>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
    'www/styles.css': `:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); }
main { text-align: center; }
button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 1px solid currentColor; background: transparent; }
`,
    'www/app.js': `let taps = 0;
document.getElementById('tap').addEventListener('click', () => {
  taps += 1;
  document.getElementById('status').textContent = 'Tapped ' + taps + (taps === 1 ? ' time' : ' times');
});
`,
    '.gitignore': GITIGNORE_TEMPLATE,
    'README.md': readme(
      name,
      `A Capacitor ${CAPACITOR_VERSION} app created with Terminia.

Before signing a release, change \`appId\` in capacitor.config.json from
\`com.example.*\` to a bundle identifier you own.

Build it from Terminia:

    terminia github use <owner>/<repo>
    terminia ci install
    terminia ios build          # unsigned IPA from a macOS runner
    terminia android build      # debug APK from a Linux runner

There is no package-lock.json yet, so the builder runs \`npm install\`.
Run \`terminia deps install\` once to create a lockfile on GitHub Actions.`,
    ),
  }),
};

const web: ProjectTemplate = {
  id: 'web',
  name: 'Static web site',
  description: 'HTML, CSS and JavaScript - no build step',
  files: (name) => ({
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>${name}</h1>
  <p>Edit index.html to get started.</p>
  <script src="script.js"></script>
</body>
</html>
`,
    'styles.css': 'body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }\n',
    'script.js': "console.log('Hello from " + name.replace(/'/g, "\\'") + "');\n",
    '.gitignore': GITIGNORE_TEMPLATE,
    'README.md': readme(name, 'A static web site created with Terminia. `terminia build web` packages it as a zip artifact on GitHub Actions.'),
  }),
};

const node: ProjectTemplate = {
  id: 'node',
  name: 'Node.js project',
  description: 'Node.js package with a dependency-free build and test script',
  files: (name) => ({
    'package.json': `${JSON.stringify(
      {
        name: slugify(name),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { build: 'node build.mjs', test: 'node --test' },
        engines: { node: '>=22' },
      },
      null,
      2,
    )}\n`,
    'build.mjs': `import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('src', 'dist', { recursive: true });
console.log('Built dist/');
`,
    'src/index.js': `export function greet(name) {
  return \`Hello, \${name}!\`;
}

if (import.meta.url === \`file://\${process.argv[1]}\`) console.log(greet('world'));
`,
    'test/index.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/index.js';

test('greets', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
`,
    '.gitignore': GITIGNORE_TEMPLATE,
    'README.md': readme(name, 'Node.js project created with Terminia. Node.js does not run on the iPad: run it on a remote host, or build it with `terminia build web`.'),
  }),
};

const python: ProjectTemplate = {
  id: 'python',
  name: 'Python package',
  description: 'pyproject.toml package with a console entry point',
  files: (name) => {
    const pkg = slugify(name).replace(/-/g, '_');
    return {
      'pyproject.toml': `[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[project]
name = "${slugify(name)}"
version = "0.1.0"
description = "${name.replace(/"/g, '')}"
requires-python = ">=3.10"
dependencies = []

[project.scripts]
${slugify(name)} = "${pkg}.__main__:main"
`,
      [`src/${pkg}/__init__.py`]: `"""${name}."""\n\n__version__ = "0.1.0"\n`,
      [`src/${pkg}/__main__.py`]: `def main() -> None:\n    print("Hello from ${name.replace(/"/g, '')}")\n\n\nif __name__ == "__main__":\n    main()\n`,
      'tests/test_basic.py': `from ${pkg} import __version__\n\n\ndef test_version():\n    assert __version__ == "0.1.0"\n`,
      '.gitignore': GITIGNORE_TEMPLATE,
      'README.md': readme(name, 'Python package created with Terminia. Terminia has no embedded Python: run it on a remote host, or build a wheel with `terminia build python`.'),
    };
  },
};

const powershell: ProjectTemplate = {
  id: 'powershell',
  name: 'PowerShell module',
  description: 'Script module with a manifest - runs on a remote PowerShell host',
  files: (name) => {
    const mod = name.replace(/[^A-Za-z0-9]/g, '') || 'Module';
    return {
      [`${mod}.psm1`]: `function Get-${mod}Greeting {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    "Hello, $Name!"
}

Export-ModuleMember -Function Get-${mod}Greeting
`,
      [`${mod}.psd1`]: `@{
    RootModule        = '${mod}.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '${crypto.randomUUID()}'
    Description       = '${name.replace(/'/g, "''")}'
    PowerShellVersion = '5.1'
    FunctionsToExport = @('Get-${mod}Greeting')
    RequiredModules   = @()
}
`,
      'Main.ps1': `Import-Module (Join-Path $PSScriptRoot '${mod}.psd1') -Force
Get-${mod}Greeting -Name 'world'
`,
      '.gitignore': GITIGNORE_TEMPLATE,
      'README.md': readme(
        name,
        'PowerShell module created with Terminia. PowerShell does not run on the iPad: connect a remote host (`remote connect <profile>`) and run `./Main.ps1` there, with this folder available on that machine.',
      ),
    };
  },
};

const empty: ProjectTemplate = {
  id: 'empty',
  name: 'Empty project',
  description: 'A README and a .gitignore',
  files: (name) => ({ 'README.md': readme(name, 'Created with Terminia.'), '.gitignore': GITIGNORE_TEMPLATE }),
};

export const TEMPLATES: ProjectTemplate[] = [capacitor, web, node, python, powershell, empty];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id.toLowerCase());
}
