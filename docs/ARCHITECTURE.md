# Architecture

Terminia is a Capacitor 8 app: a TypeScript single-page UI in a WKWebView, plus three Swift plugins for what the web view must not or cannot do (files outside the sandbox, secrets, network requests with credentials). Anything that needs a real toolchain runs elsewhere, and every command says where:

| Target | Color | Where it runs | Examples |
| --- | --- | --- | --- |
| **local** | cyan | in the app, on the project's files | `ls`, `cat`, `grep`, `zip`, `terminia project …` |
| **network** | grey | the app calls a public API | `terminia deps info react` (npm/PyPI registries) |
| **remote** | yellow | PowerShell on your computer via the agent | anything typed in a connected tab, `terminia remote exec` |
| **cloud** | violet | a GitHub Actions runner | `terminia ios build`, `terminia deps install` |

## Layers

```text
src/ui            views, overlays, editor (DOM only; no business logic)
src/app           Services container + UiBridge (confirm/prompt/navigate), created once
src/commands      command specs: arguments, help, target, run()
src/terminal      tokenizer, argument parser, shell (pipes/redirection/routing), sessions, history, completion
src/projects      project files, detection, templates, .terminia/config.json
src/build         BuildProvider (GitHub Actions), BuildManager (state machine, polling, history), preflight plan
src/github        REST client (retries, rate limits, error mapping), auth, Git Data API sync, workflow templates
src/artifacts     resolve/download/verify/unwrap artifacts, save to Files
src/deps          manifest + lockfile readers, editors, registries, remote/cloud jobs
src/remote        agent protocol, client, remote shell
src/fs            FsBackend (native / web / memory) and the virtual file system (/workspace, /folders/*)
src/net           HttpClient (native plugin / fetch)
src/platform      plugin contracts, Vault, documents, key-value storage, platform factory
src/core          errors, paths, validation, redaction, secret detection, ignore rules, zip, hashing, diff
```

Dependencies point downwards only. `src/core` has no platform code, which is why most of the logic is unit-testable in Node.

## Platform abstraction

`createNativePlatform()` (iPad) and `createWebPlatform()` (browser preview) both return a `Platform`: `fs`, `http`, `vault`, `documents`, `kv`. Services only see these interfaces. Tests use `MemoryFsBackend`, `MemoryVault`, and `FetchHttpClient` against a mock GitHub server.

| | iPad | Browser preview |
| --- | --- | --- |
| Files | `TerminiaFiles`: app Documents (`On My iPad › Terminia`), security-scoped folders, coordinated I/O | Capacitor Filesystem (IndexedDB), base64 |
| Secrets | `TerminiaVault`: Keychain, never returned to JS | memory for the tab |
| HTTP | `TerminiaHttp`: URLSession, credentials attached natively, pinning, downloads to disk | `fetch`, token from the memory vault for allowed origins only |

## Files

The virtual file system mounts `/workspace` (the app's Documents folder: `Projects/`, `Artifacts/`, `Exports/`, `Inbox/`) and `/folders/<name>` for each folder opened from the Files app. Folder access is kept as a security-scoped bookmark, so it survives restarts; stale bookmarks are refreshed. All paths pass `validateRelativePath` (no `..`, no absolute paths, no NUL) in TypeScript and are checked again in Swift (`TerminiaPaths.resolve` + `isURL(inside:)`).

## Terminal

`tokenizer.ts` splits input with PowerShell-style quoting into a script of pipelines (`|`), sequences (`;`, `&&`, `||`) and redirections. `shell.ts` resolves each command in the registry, parses arguments against its spec, runs it with a `CommandContext` (cwd, stdin text, sinks for stdout/stderr, abort signal), and applies redirections through the VFS. Unknown commands get honest answers: tools that need a runtime (`node`, `npm`, `git`, `python`, `pwsh`…) say so and point to `terminia remote connect` or a cloud job; PowerShell syntax is detected and refused rather than half-interpreted.

A `TerminalSession` is either local or attached to a `RemoteShell`. In a remote session, input goes to the agent unchanged, except `terminia …`, `:`-prefixed commands and `exit`, which stay local.

## Builds

```text
terminia ios build
   │ prepareBuild(): project type, repo, permissions, workflow on default branch, CI files, signing secrets
   ▼
 ready ──► waiting_for_signing (stop: secrets missing)
   │
   ▼ planSync() → preview → confirm → executeSync() (Git Data API, fast-forward)
 syncing ──► dispatching (workflow_dispatch, inputs incl. build id) ──► queued ──► running
                                                                                  │
                                       succeeded / failed / cancelled ◄───────────┘
                                       (annotations + artifacts collected before the status is published)
```

`BuildProvider` is the boundary: `GitHubActionsProvider` implements dispatch, find/get/list runs, jobs, logs, annotations, cancel, artifacts and downloads. Another CI service would implement the same interface. `BuildManager` persists build records (`terminia.builds`), resumes tracking after restart, polls with backoff and reads history including runs started elsewhere.

## Trust boundaries

1. **Web view ↔ native**: JavaScript can ask native code to *use* a credential for an origin; it can never read one. Credentials are stored with the origins they may be sent to.
2. **App ↔ GitHub**: least-privilege token; nothing is pushed without a preview and confirmation; secret files are blocked before upload.
3. **GitHub runner**: the repository's workflow code runs with `contents: read`; inputs are passed as environment variables; signing material only exists in temporary files during the job.
4. **App ↔ agent**: bearer token over HTTPS (or private-network HTTP), pinning optional; the agent runs as the user who started it.

See [SECURITY.md](SECURITY.md).
