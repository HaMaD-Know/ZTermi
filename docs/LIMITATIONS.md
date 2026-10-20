# Limitations

## Platform

- **No local toolchains on the iPad.** iPadOS does not allow apps to run downloaded executables or JIT compilers, so Node.js, Python, Git, Gradle, Xcode and PowerShell are not on the iPad. Terminia runs them on GitHub Actions runners or on your remote host, and labels every command with where it runs. Local commands (`ls`, `cat`, `grep`, `zip`, …) are Terminia's own implementations.
- **Local commands are not PowerShell.** `ls`, `Get-ChildItem`, `Select-String` and so on are implemented with the common options only (see [COMMANDS.md](COMMANDS.md)). `$variables`, script blocks, `$( )`, `ForEach-Object` and other PowerShell language features are refused locally with a pointer to a remote host.
- **Installing builds.** iPadOS cannot install an IPA from another app, and an APK cannot run on an iPad at all. Terminia downloads them to Files; see [SIGNING.md](SIGNING.md) for installation routes.
- **Background execution.** iPadOS suspends the app shortly after it goes to the background. Cloud builds keep running on GitHub; Terminia resumes following them when you return. A remote command keeps running on the host, but a long poll from a suspended app stops - reopen the tab to see the result.

## Verification gaps

- **The Swift plugins have not been compiled or run yet.** There is no Mac in the environment where Terminia was developed. They are written against current iOS SDK APIs and `npm run check:ios` verifies the Xcode project wiring (64 checks), but the first real compile happens in the `terminia-ios.yml` run - expect possible compiler fixes there. The web layer has been exercised in the browser preview, which uses the web implementations of the same interfaces.
- **The iOS workflow has not run on a real macOS runner.** Its shell scripts pass `bash -n`, share the helpers that were exercised in the Android and web runs, and the workflow file is validated against the dispatcher in tests, but `xcodebuild`, signing import and IPA export are untested.
- **No real GitHub run yet.** All GitHub integration tests use a mock server (`tests/support/fake-github.ts`) that implements the documented API behaviour. Real accounts may surface differences (e.g. whether `return_run_details` is available - the fallback is implemented and tested).
- The Android and web build scripts were run locally on Windows with Git Bash, not on `ubuntu-24.04`. See [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

## GitHub

- Job logs are available when a job has finished; while it runs, Terminia shows live step status (GitHub's REST API offers no streaming log).
- Artifact and log downloads are pre-signed storage URLs without CORS, so the **browser preview cannot download artifacts** - the iPad app (native HTTP) can.
- `workflow_dispatch` only works for workflows on the default branch; `terminia github prepare` commits them there.
- Device sign-in needs your own OAuth App or GitHub App client id, and does not work in the browser preview. GitHub App user tokens expire (8 hours by default) and are not refreshed.
- Sync commits files through the Git Data API; it is not a Git client - no local history, merges, rebases or submodules. Git LFS files are uploaded as normal blobs. Files above 100 MB are refused by GitHub.
- Archive upload (building a zip without committing) is not implemented: builds always use a commit.

## Remote host

- No interactive input (`Read-Host`, credential prompts, `git` asking for a password) and no full-screen programs (`vim`, `less`). Use non-interactive flags.
- Output of different streams written within a few milliseconds may arrive slightly reordered (each stream is read separately from the runspace).
- Output is formatted at a fixed width (120 columns by default, `TERMINIA_WIDTH`).
- iOS App Transport Security: plain HTTP is allowed only to local-network addresses (`NSAllowsLocalNetworking`); an HTTP agent on a public IP or a hostname that does not resolve to a local address will be refused by iOS - use HTTPS.
- `--root` is a starting-point restriction for sessions and `exec`, not a sandbox.

## Dependencies

- `terminia deps list` reads manifests and lockfiles; dependency trees for Gradle, CocoaPods and SwiftPM are not resolved locally.
- `deps add/remove` edit `package.json`, `requirements.txt` and `pyproject.toml` directly; other ecosystems go through `deps install` on a runner or remote host.
