# Terminia

A developer terminal for iPad. Terminia manages projects and files, edits code, manages dependencies, gives you a **real PowerShell on your own computer**, and builds **Android APKs and iOS IPAs on GitHub Actions** - started, followed and downloaded from the iPad, without opening github.com.

Terminia is honest about where things run. Every command in the terminal shows its execution target:

| Target | What runs there |
| --- | --- |
| **Local iPad** | Files in Terminia's folder and in folders you open with the document picker, the editor, zip archives, project detection, built-in commands (`ls`, `cat`, `grep`, `zip`…). These are **not** PowerShell. |
| **Network** | Read-only lookups: GitHub API, npm registry, PyPI. |
| **Remote PowerShell host** | Real PowerShell (5.1 or 7+) on a Windows, macOS or Linux computer running the Terminia agent. |
| **GitHub Actions · macOS** | iOS builds with Xcode, signing, CocoaPods/SwiftPM installs. |
| **GitHub Actions · Linux** | Android builds with Gradle, web/Node/Python builds, npm/pip installs. |

There is no embedded Node.js, Python or PowerShell on the iPad, the iPad never runs Xcode, and nothing is simulated: build status, logs and artifacts come from real GitHub Actions runs.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Supported platforms](#supported-platforms)
- [Development](#development)
- [Connect GitHub (once)](#connect-github-once)
- [Build an IPA from the iPad](#build-an-ipa-from-the-ipad)
- [Build an APK from the iPad](#build-an-apk-from-the-ipad)
- [Artifacts and the Files app](#artifacts-and-the-files-app)
- [Remote PowerShell host](#remote-powershell-host)
- [Dependencies](#dependencies)
- [Commands](#commands)
- [Security](#security)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)

## What it does

- **Terminal** - a plain full-screen console like Windows PowerShell: you type directly after the `PS …>` prompt, with no separate input box or toolbars. Multi-line input, history (↑/↓, persisted, secrets redacted), Tab completion, pipes (`|`), `&&`/`||`/`;`, redirection (`>`, `>>`, `2>`, `2>&1`), find (⌘F), Ctrl+C to stop, Ctrl+L / ⌘K to clear, and an on-screen key bar on touch devices (Tab, Esc, arrows, ^C, `|`, `~`…). Other screens (projects, files/editor, builds, artifacts, dependencies, settings) open full screen only when a command needs them or with `screen <name>`; Esc returns to the console. PowerShell-only syntax (`$variables`, `{ }` script blocks, `$( )`) is refused locally with a pointer to remote hosts instead of being half-interpreted.
- **Projects** - templates (Capacitor, static web, Node.js, Python, PowerShell module, empty), import from a zip or a folder, open a folder **in place** (iCloud Drive, On My iPad, other providers) through Apple's document picker, export a zip (secrets and ignored files are left out), detection of project type and of which build targets are actually possible.
- **Files and editor** - file tree, CodeMirror 6 editor with syntax highlighting for PowerShell, JavaScript/TypeScript, JSON, HTML, CSS, Python, YAML, XML, Markdown, TOML, Gradle, Kotlin, Swift, shell and more; tabs, find/replace, save with conflict detection (files changed by another app), Save As, Save to Files.
- **Builds** - iOS / Android / Web / Custom targets, preflight checks (GitHub connection, repository, workflow on the default branch, signing secrets), sync preview and confirmation, live status and steps, full job logs, error annotations, cancel, history (including runs started elsewhere), artifact download.
- **Git integration** - `terminia git status|diff|sync|log` through the GitHub Git Data API: Git blob ids are compared locally, only changed files are uploaded, the branch is fast-forwarded (never force-pushed), and secrets are never uploaded.
- **Dependencies** - reads npm/pnpm/Yarn, pip (requirements.txt, pyproject, Poetry/uv locks), Gradle (incl. version catalogs), CocoaPods, SwiftPM and PowerShell module manifests with locked versions; adds/removes packages in manifests; runs the **real** package manager on a GitHub Actions runner (and offers the resulting lockfile back) or on your remote host.
- **Remote PowerShell** - a persistent PowerShell runspace on your computer (variables and functions persist), separate output/error/warning streams, `$LASTEXITCODE`, Stop, and PowerShell's own `TabExpansion2` completion.

## Architecture

```
 iPad app (Capacitor 8 + TypeScript)                         Your infrastructure
 ┌────────────────────────────────────────────────┐
 │ UI: full-screen console; editor, builds and    │
 │     settings screens opened by commands        │
 ├────────────────────────────────────────────────┤
 │ Terminal engine: tokenizer, commands, routing  │
 │ Services: projects, builds, artifacts, deps,   │
 │           GitHub, remote hosts, settings       │
 ├────────────────────────────────────────────────┤        HTTPS (token added natively)
 │ Native Swift plugins                           │ ───────────────► api.github.com
 │  TerminiaFiles  document picker, bookmarks,    │                    │ workflow_dispatch
 │                 file ops, zip, SHA-256         │                    ▼
 │  TerminiaVault  Keychain, device sign-in       │             GitHub Actions runners
 │  TerminiaHttp   requests, downloads, pinning   │             macOS: Xcode → IPA
 └────────────────────────────────────────────────┘             Linux: Gradle → APK/AAB
                    │  HTTPS / private network
                    ▼
            Terminia agent (Node.js) ──► PowerShell runspace on your computer
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Supported platforms

- **The app**: iPadOS 15+ (also runs on iPhone with a compact layout). Built with Capacitor 8.5.3 (Swift Package Manager), Xcode 26 on GitHub's `macos-26` runners.
- **Browser preview** (`npm run dev`): the full UI for development. Files live in IndexedDB, tokens only in memory for the tab, and GitHub's artifact/log storage cannot be downloaded in a browser (no CORS) - that works in the iPad app.
- **Projects Terminia can build**: Capacitor apps (iOS and Android), native Xcode projects (iOS), Android Gradle projects, web apps with a `build` script, static sites, Node.js and Python packages, and custom build profiles.
- **Remote hosts**: Windows PowerShell 5.1 or PowerShell 7+ on Windows, macOS or Linux, with Node.js 20+.

## Development

Requirements: Node.js 22.12+ (24 tested), npm. Xcode is only needed on a Mac if you want to run the app locally; the CI builds it without.

```bash
npm ci
```

```bash
npm run dev
```
Starts the browser preview at http://localhost:5173.

```bash
npm run verify
```
Lint, type check, all tests, CI-template check and the static iOS project checks.

```bash
npm run build
```
Production web bundle in `dist/`.

### Capacitor / iOS project

The iOS project is committed in `ios/`. Terminia's own Swift code lives in `ios/App/App/Terminia/` and is wired into the Xcode project by a script:

```bash
npm run cap:sync
```
Builds the web bundle and runs `npx cap sync ios`.

```bash
node scripts/wire-ios.mjs
```
Idempotent: adds the Swift files to the App target, sets `TerminiaBridgeViewController` as the root view controller and the Info.plist keys. Run it after recreating the platform with `npx cap add ios`.

```bash
npm run check:ios
```
Verifies the wiring without Xcode: every Swift file compiled, plugins registered, Swift method lists identical to the TypeScript contracts, rejection codes known to TypeScript, Info.plist keys, bundle id and Capacitor version pin.

To build Terminia itself as an IPA, push this repository to GitHub and run the **Terminia iOS** workflow (it is the same template Terminia installs into your projects; see [docs/BUILDING-IOS.md](docs/BUILDING-IOS.md#building-terminia-itself)).

## Connect GitHub (once)

Terminia needs a GitHub repository for each project you want to build, and one of:

1. **A fine-grained personal access token** (simplest). On github.com: Settings → Developer settings → Fine-grained tokens → Generate. Repository access: the repositories you build. Permissions: **Actions** read/write, **Contents** read/write, **Workflows** read/write, **Metadata** read; optionally **Secrets** read (lets Terminia tell you whether signing secrets exist - it can never read their values). In Terminia: Settings → Build providers › GitHub → **Use a token**, or `terminia github login --token`.
2. **Device sign-in** with your own OAuth App or GitHub App (no token to copy). Create the app with *Device flow* enabled, enter its **client id** in Settings → Build providers › GitHub, then **Sign in with GitHub** and enter the code shown at github.com/login/device. No client secret is used or needed.

The token is typed into a native secure field, stored in the **iOS Keychain** (this device only) and attached to requests by native code - JavaScript never sees it, and it is only ever sent to `api.github.com`. Full guide: [docs/GITHUB-SETUP.md](docs/GITHUB-SETUP.md).

Then, per project:

```text
terminia github use <owner>/<repo>
terminia ci install
terminia github prepare
```

`ci install` writes the workflow files into the project (`.github/workflows/terminia-*.yml`, `.terminia/ci/*`), and `github prepare` commits only those files to the repository's default branch after showing you exactly what will be uploaded - GitHub can only start workflows that exist on the default branch.

## Build an IPA from the iPad

1. Open the project (Projects, or `terminia project open <name>`).
2. **Builds** → target **iOS** → configuration (Release/Debug) → export method → **Check settings** → **Build**. Or in the terminal: `terminia ios build --configuration release`.
3. Terminia shows the files it will commit to your repository (secrets are excluded and listed) and asks you to confirm.
4. It starts the **Terminia iOS** workflow on a GitHub-hosted macOS runner through the API and follows it: queued → running (live steps) → succeeded / failed, with real logs (`terminia ios logs`) and error annotations.
5. The runner installs dependencies, runs your web build, `npx cap sync ios` (or `npx cap add ios` if the project has no `ios/` folder yet), builds with Xcode, packages and verifies the IPA, and uploads it.
6. **Download** (Builds or Artifacts view, or `terminia ios download`): the IPA is saved in **On My iPad › Terminia › Artifacts**, its SHA-256 checked against GitHub's digest. **Save to Files** copies it anywhere else.

**Generating an IPA is not the same as installing it.** An *unsigned* IPA (the default, no secrets needed) proves the app builds but **cannot be installed** as is - it has to be signed first (Xcode, a re-signing tool such as AltStore or Sideloadly with your Apple ID, or a signed Terminia build). A *signed* IPA needs your Apple certificate and provisioning profile as GitHub secrets; development and ad-hoc IPAs install only on devices listed in the profile, App Store IPAs go through TestFlight / App Store Connect. iPadOS does not let an app install another app, so Terminia hands you the file. See [docs/SIGNING.md](docs/SIGNING.md).

Without the signing secrets, a signed export stops in the **Waiting for signing configuration** state before anything runs, and tells you which secrets are missing.

## Build an APK from the iPad

Same flow with target **Android**, or:

```text
terminia android build --variant debug
terminia android build --variant release --output both
terminia android download
```

The **Terminia Android** workflow runs on Linux with the runner's JDK 21 and Android SDK: web build, `npx cap sync android` (or `cap add android`), Gradle `assemble`/`bundle`, then verifies the APK (manifest, dex, signature via `apksigner`) and uploads it unzipped. **Debug** builds are signed with the Android debug key and install on any Android device with "install unknown apps" enabled. **Release** builds need your keystore as secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), injected without changing your Gradle files.

**An APK is an Android app. It cannot be installed on an iPad.** Terminia saves it to Files so you can move it to an Android device (AirDrop to a Mac, a cloud drive, a USB cable, a messaging app). See [docs/BUILDING-ANDROID.md](docs/BUILDING-ANDROID.md).

## Artifacts and the Files app

- Downloads stream to disk natively with progress, **Cancel**, and up to three automatic retries on network errors; the SHA-256 is verified against GitHub's digest when GitHub provides one.
- GitHub sometimes delivers an artifact wrapped in a zip; Terminia unwraps it natively so you get the actual `.ipa` / `.apk` / `.aab`.
- Finished files are in **On My iPad › Terminia › Artifacts** (visible in the Files app). **Save to Files** uses the system picker for any other location.
- Expired artifacts (Terminia's workflows keep them 14 days) are reported as expired - build again to get a new one.
- Workspace projects live in **On My iPad › Terminia** too, so other apps can open them.

## Remote PowerShell host

Real PowerShell runs on a computer you control through the Terminia agent (Node.js, no dependencies):

```bash
node agent/terminia-agent.mjs init --root ~/src
```
Prints a token once.

```bash
node agent/terminia-agent.mjs start
```
Listens on `127.0.0.1:8765` by default.

Reach it from the iPad over a private network, ideally **Tailscale** (`tailscale cert` gives a real HTTPS certificate) or an SSH tunnel; plain HTTP is accepted only from private addresses, and certificates can be pinned. In Terminia:

```text
remote add devbox https://devbox.tailnet.ts.net:8765
remote test devbox
remote connect devbox
```

The tab switches to **remote mode** (yellow rule and prompt `[devbox] PS C:\…>`): every line runs remotely in one persistent PowerShell session until you type `exit`. Lines starting with `:` run locally; `terminia …` commands always run locally. Setup, TLS and security model: [docs/REMOTE-HOST.md](docs/REMOTE-HOST.md); protocol: [docs/REMOTE-PROTOCOL.md](docs/REMOTE-PROTOCOL.md).

## Dependencies

```text
terminia deps list
terminia deps add lodash            # declares lodash@^<latest> in package.json
terminia deps add requests --ecosystem pip
terminia deps install               # npm on a GitHub Actions runner → lockfile offered back
terminia deps install --on remote --remote devbox
terminia deps update
terminia deps remove lodash
```

Adding edits the manifest only and says so; installing runs the real package manager where you choose. Only registry packages are accepted (no URLs, git or local paths), and the package names and source registry are shown before anything runs. Gradle, CocoaPods and SwiftPM dependencies are listed and resolved on the builders; PowerShell modules install on a remote host.

## Commands

`help` lists local commands; `terminia help` the Terminia CLI; `which <command>` tells you where a command runs. Highlights:

| Area | Commands |
| --- | --- |
| Files (local) | `ls`/`dir`/`Get-ChildItem`, `cd`, `pwd`, `cat`, `head`, `tail`, `grep`/`Select-String`, `find`, `tree`, `mkdir`, `touch`, `New-Item`, `cp`, `mv`, `Rename-Item`, `rm`/`Remove-Item`, `stat`, `du`, `sha256`/`Get-FileHash`, `zip`/`Compress-Archive`, `unzip`/`Expand-Archive`, `edit`, `sort`, `uniq`, `wc`, `Set-Content` |
| Projects | `terminia project list|new|open|close|info|templates|export|import|import-folder|open-folder|folders|forget-folder` |
| iOS | `terminia ios configure|build|status|logs|artifacts|download|cancel|history` |
| Android | `terminia android configure|build|status|logs|artifacts|download|cancel|history` |
| Web / custom | `terminia web …`, `terminia build ios|android|web|node|python|custom` |
| Dependencies | `terminia deps list|info|add|remove|install|update|resolve|logs` |
| GitHub / git | `terminia github login|logout|status|repos|use|branches|workflows|prepare`, `terminia git status|diff|sync|log`, `terminia ci install|status` |
| Artifacts | `terminia artifacts list|save|remove|open` |
| Remote hosts | `remote list|add|remove|token|test|connect|disconnect|status|map|exec` |

PowerShell-style names (`Get-ChildItem`, `Remove-Item -Recurse`…) are aliases of Terminia built-ins with the options listed in their help - not a PowerShell implementation. The full generated reference is [docs/COMMANDS.md](docs/COMMANDS.md).

## Security

- Tokens never touch JavaScript on iPad: native secure entry, iOS Keychain (`AfterFirstUnlockThisDeviceOnly`), attached natively and **bound to the origins chosen when they were stored**; the Authorization header is dropped on cross-origin redirects; optional certificate pinning for remote hosts.
- Nothing secret in the repository, local storage, logs or URLs: settings store no secrets, history and output are redacted, URLs never carry tokens.
- Before anything is uploaded you see the destination and the file list. `.env` files, keystores, `.p12`/`.p8`/`.mobileprovision`, private keys, credential stores and files containing tokens are never uploaded or exported.
- Paths are validated at every boundary (no `..`, no absolute paths), zip extraction refuses entries that escape the destination and limits sizes and compression ratios.
- Workflows run with `contents: read`, pass inputs through environment variables (never `${{ }}` inside scripts), use pinned major versions of GitHub's own actions, and keep signing material in a temporary keychain or temporary files that are deleted afterwards.
- The remote agent: salted-hash token check in constant time, lockout after failed sign-ins, loopback by default, plain HTTP only from private networks, TLS and pinning, structured execution with argument arrays and an allowlist, size limits.

Full threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Tests

```bash
npm test
```

176 tests in 13 files, including:

- **Real PowerShell**: `tests/integration/remote-agent.test.ts` starts the agent and drives a real PowerShell (Windows PowerShell 5.1 locally, PowerShell 7 on CI) through Terminia's client: persistent variables, streams, exit codes, cancellation, completion, argument passing, allowlists. Skipped only if no PowerShell is installed.
- **Mock GitHub API** (`tests/support/fake-github.ts`, clearly a mock - not a cloud build): end-to-end sync, dispatch with the real workflow templates' inputs, run correlation, status transitions, logs, annotations, artifacts (zipped and raw), digests, cancel, signing preflight, rate limits, outages, auth failures, conflicts, empty repositories, dependency installs.
- Unit tests: tokenizer and argument parsing, shell (pipes, redirection, routing, honest "not available" errors), completion, history redaction, paths and traversal, secret redaction and detection, ignore rules, zip safety, hashing, project detection, configuration validation, manifests and lockfiles, manifest editing, registry name validation, build state machine, GitHub error handling, credential origin binding, diff, workflow-template safety (permissions, action versions, no `${{ inputs }}` in scripts), command reference generation, and the browser storage backend.

What was executed and what was not, including real Gradle/npm/pip runs of the CI scripts: [docs/VERIFICATION-REPORT.md](docs/VERIFICATION-REPORT.md).

## Known limitations

- The Swift code is compiled only on macOS (the iOS workflow); it has not been run on a device yet. The static checks verify the wiring, not runtime behaviour.
- No local runtime on the iPad: Node.js, Python, git and PowerShell run on builders or your remote host.
- Live logs: GitHub publishes a job's full log when the job finishes; while it runs Terminia shows live step status.
- Remote PowerShell: no interactive prompts (`Read-Host`), no full-screen programs; the relative order of different streams (output vs. warnings) within a few milliseconds is not preserved exactly.
- Archive upload as a sync strategy is not implemented; sync commits to a branch, or builds what is already on GitHub.

Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, modules, data flows, trust boundaries |
| [GITHUB-SETUP.md](docs/GITHUB-SETUP.md) | Tokens, device sign-in, permissions, first build |
| [BUILDING-IOS.md](docs/BUILDING-IOS.md) | iOS workflow, inputs, Capacitor and Xcode projects, building Terminia |
| [BUILDING-ANDROID.md](docs/BUILDING-ANDROID.md) | Android workflow, variants, outputs |
| [SIGNING.md](docs/SIGNING.md) | iOS certificates/profiles and Android keystores as secrets; installability |
| [REMOTE-HOST.md](docs/REMOTE-HOST.md) | Terminia agent setup, TLS, Tailscale, security |
| [REMOTE-PROTOCOL.md](docs/REMOTE-PROTOCOL.md) | Agent HTTP protocol |
| [COMMANDS.md](docs/COMMANDS.md) | Generated command reference |
| [SECURITY.md](docs/SECURITY.md) | Threat model and controls |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | What Terminia does not do |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems |
| [VERIFICATION-REPORT.md](docs/VERIFICATION-REPORT.md) | What was tested, how, and what was not |
