# Verification report

What was actually executed while building Terminia 1.0.0, on what, and what was **not**. Environment: Windows 11, Node.js 24.18.1, Windows PowerShell 5.1.26100, Git Bash, JDK 21, Android SDK (build-tools 37). No Mac, no iPad, no GitHub account connected.

## Automated checks - executed, passing

`npm run verify` (exit code 0) and `npm run build` (exit code 0):

| Step | Result |
| --- | --- |
| `eslint .` | no errors |
| `tsc --noEmit` (strict) | no errors |
| `vitest run` | **176 passed, 0 failed, 0 skipped**, 13 files |
| `check:templates` | `templates/` and the copies in `.github/workflows` / `.terminia/ci` identical |
| `check:ios` | 64 of 64 static checks on the Xcode project (files in the target, plugin method lists match TypeScript, error codes, Info.plist keys, versions, no signing material) |
| `vite build` | `dist/` produced (main bundle 1.26 MB, 423 kB gzip) |

| Test file | Tests | What it exercises |
| --- | --- | --- |
| `integration/remote-agent.test.ts` | 11 | **Real** agent + **real Windows PowerShell 5.1**: auth and lockout, persistent runspace, streams, `$LASTEXITCODE`, cancel, `TabExpansion2`, structured exec, allowlist, roots, quoting rules, no leftover processes |
| `integration/github-build.test.ts` | 19 | Full build flow against a **mock** GitHub API (sync, dispatch validated against the real workflow inputs, run correlation with and without `return_run_details`, status, logs, annotations, artifacts, digests, cancel, signing preflight, rate limits, outages, conflicts, empty repos, dependency jobs) |
| `integration/web-storage.test.ts` | 3 | Capacitor Filesystem web implementation (text and binary round trips, legacy data) |
| `unit/*` | 143 | tokenizer, arguments, shell, completion, history, paths, redaction, secret detection, ignore rules, zip safety, hashing, detection, configuration, manifests and lockfiles, manifest editing, registry validation, build state machine, GitHub client errors and rate limits, credential origin binding, diff, workflow-template safety rules, generated command reference |

## Manual runs - executed

**Browser preview** (`npm run dev`, built-in browser): created a Capacitor project from the template; `ls`, `cat`, `grep`, pipes and redirection; Tab completion; editor open/edit/save; every view (Terminal, Projects, Files, Dependencies, Builds, Artifacts, Settings) rendered with no console errors; `terminia ios build` reported the correct preflight failures (no GitHub connection). This found and fixed: text files stored in a form the web backend could not read back, a badge showing "0", a squeezed remote prompt, iOS-specific wording in the browser, an unexpanded file tree.

**Real remote PowerShell from the UI**: agent started locally, profile added with a test token, connected from the browser preview: `$answer = 42` then `$answer` in a later command returned 42 (state persists), errors/warnings shown in their streams, `:pwd` ran locally, `exit` disconnected. After stopping the agent no PowerShell processes were left.

**Android CI scripts** (`.terminia/ci/android-build.sh` and helpers, Git Bash on Windows) on a project generated from Terminia's Capacitor template: `npm install`, web build, `npx cap add android`, `npx cap sync android`, Gradle `assembleDebug` and `bundleDebug`, output verification and the result annotation all succeeded:

- `app-debug.apk` 4,117,580 bytes, passed `apksigner verify`, application id `com.example.demoapp` read with `aapt2`;
- `app-debug.aab` 3,589,682 bytes, `base/manifest/AndroidManifest.xml` present.

This run found and fixed real bugs: `unzip -l … | grep -q` and `| head -n 1` failing under `set -o pipefail` (SIGPIPE), and the `apksigner` output format of build-tools 37.

**Dependency script** (`deps.sh`): `npm add` produced an updated `package.json`, `package-lock.json` and the result report; package names with shell metacharacters and newlines were rejected.

**Web build script** (`web-build.sh`): Node.js project (`npm run build` → archive), Python package (wheel + sdist), static site - all produced their artifacts.

## Not executed

| Item | Why | What happens first time |
| --- | --- | --- |
| Swift plugins (TerminiaFiles, TerminiaVault, TerminiaHttp) - compile and run | no macOS / Xcode available | first compile in the `terminia-ios.yml` run of this repository; then test on an iPad: document picker, bookmarks, Keychain entry, device sign-in, downloads |
| iOS workflow (`terminia-ios.yml`, `ios-build.sh`, signing import/export) | needs a macOS runner and a GitHub repository | syntax-checked only (`bash -n`); xcodebuild, IPA packaging and signed exports untested |
| Any real GitHub API call (sync, dispatch, logs, artifacts) | no GitHub account/token was connected, and pushing requires your consent | the mock implements the documented API; behaviour differences may appear |
| Android / web / deps workflows on `ubuntu-24.04` | same | the scripts themselves were run locally (above); the YAML wiring around them was not run on GitHub |
| PowerShell 7 with the agent | only Windows PowerShell 5.1 installed locally | Terminia's own CI (`validate.yml`) runs the same tests with `pwsh` on Ubuntu |
| The app on an iPad / iPhone (layout, keyboard bar, Files integration) | no device | the UI was tested only in a desktop browser at iPad-like sizes |
| Device-flow sign-in | needs an OAuth/GitHub App client id and the native app | - |
| Release signing (Android keystore, iOS certificates) | no signing material | - |

## How to complete verification

1. Push this repository to a GitHub repository you own (see [GITHUB-SETUP.md](GITHUB-SETUP.md)). `validate.yml` runs lint, tests (including the agent tests on PowerShell 7) and the build.
2. Run **Terminia iOS** from the Actions tab: this compiles the Swift plugins and produces `App-release-unsigned.ipa`. Fix any compiler errors it reports.
3. Sign and install that build on an iPad ([SIGNING.md](SIGNING.md)), connect GitHub inside the app, create a Capacitor project and run `terminia android build` and `terminia ios build` from the iPad.
