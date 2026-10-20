# Building iOS apps (IPA)

The iPad does not run Xcode. Terminia builds iOS apps on GitHub-hosted **macOS runners** (`macos-26`, Xcode 26.x) with the `terminia-ios.yml` workflow, starts the run through the GitHub API, follows it and downloads the IPA.

## From the iPad

```text
terminia ios configure                         # review settings and run the preflight checks
terminia ios build                             # release, unsigned (defaults)
terminia ios build --configuration release --export ad-hoc
terminia ios status | logs | artifacts | download | cancel | history
```

Or use **Builds → iOS**.

Preflight checks (`terminia ios configure`, **Check settings**): project can be built for iOS, GitHub connected, repository reachable and writable, the workflow is registered on the default branch, CI files are in the project and current, signing secrets exist for signed exports, lockfile present.

## What the workflow does

| Step | Script | Notes |
| --- | --- | --- |
| Check out the commit Terminia synced | `actions/checkout@v7` | |
| Detect the project | `.terminia/ci/detect-project.sh ios` | Capacitor (`capacitor.config.*` or `@capacitor/core`) or a native `.xcodeproj`; anything else fails with a clear error |
| Select Xcode | `select-xcode.sh` | `xcode_version` input (default 26.5); falls back to the newest Xcode of the same major version with a warning |
| Node.js + dependencies | `actions/setup-node@v7`, `install-deps.sh` | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable`; `npm install` with a warning when there is no lockfile |
| Signing check | inline | for signed exports, fails as *Waiting for signing configuration* if a secret is missing |
| Import signing | `ios-import-signing.sh` | temporary keychain on the runner; deleted at the end |
| Build | `ios-build.sh` | web build (`npm run build` if present), `npx cap add ios` when `ios/` is missing (`generate_native`), `npx cap sync ios`, `pod install` when there is a Podfile, Swift packages resolved, scheme and bundle id read from the project, then build or archive + export |
| Verify | `ios-build.sh` | the IPA must contain `Payload/<App>.app/Info.plist`; SHA-256 and size recorded |
| Upload | `actions/upload-artifact@v7` | the IPA (14 days), plus a `terminia-ios-logs-*` artifact with every log |

### Inputs (`workflow_dispatch`)

| Input | Values | Default |
| --- | --- | --- |
| `terminia_build_id` | set by Terminia; appears in the run title so Terminia can find the run | `manual` |
| `project_path` | folder of the project in the repository | `.` |
| `configuration` | `release`, `debug` | `release` |
| `export_method` | `unsigned`, `development`, `ad-hoc`, `app-store`, `enterprise` | `unsigned` |
| `scheme` | Xcode scheme; empty = `App`, else the first shared scheme | empty |
| `xcode_version` | e.g. `26.5` | `26.5` |
| `generate_native` | run `npx cap add ios` when a Capacitor project has no `ios/` folder | `true` |

`export_method` maps to Xcode's export methods: development → `debugging`, ad-hoc → `release-testing`, app-store → `app-store-connect`, enterprise → `enterprise`.

### Unsigned and signed

- **unsigned**: `xcodebuild build -sdk iphoneos CODE_SIGNING_ALLOWED=NO`, then the `.app` is packaged as `Payload/<App>.app` in a zip named `<App>-<configuration>-unsigned.ipa`. It proves the app compiles for devices; **it cannot be installed until it is signed**.
- **signed**: certificate and provisioning profile from secrets go into a temporary keychain; manual signing is set on the app target only (not on Swift package or Pod targets); `xcodebuild archive` and `-exportArchive` produce `<App>-<configuration>-<method>.ipa`. The profile's bundle id must match the app's, or the build stops with an explanation. See [SIGNING.md](SIGNING.md).

### Projects without `ios/`

A Capacitor project created on the iPad has no native folder. With `generate_native` (default) the runner creates one with `npx cap add ios` for that build only - it is not committed back. Commit an `ios/` folder (from a Mac) when you need native customisation, icons or entitlements.

### Logs and results

The scripts send each step's output to `terminia-out/logs/*.log` (uploaded as an artifact), print short summaries, and publish failures as **annotations**, which Terminia shows as the error of the build. xcodebuild's full output is only in the log artifact (it is too large for the job log); errors and the last lines are printed in the job log. The final step publishes a `terminia-result` notice (file, size, SHA-256, bundle id, signed) that Terminia reads.

## Run correlation

GitHub's dispatch API returns the run id when it supports `return_run_details`; Terminia uses it. Otherwise Terminia finds the run by its title, which the templates set to include the build id (`run-name: "Terminia iOS … · <build id>"`). If you edit the workflow, keep the build id in `run-name`.

## Native Xcode projects

A repository with an `.xcodeproj` (at the root, in `ios/` or `ios/App/`) and no Capacitor configuration is built directly. A workspace is used when there is a Podfile. The scheme must be **shared** (Product → Scheme → Manage Schemes → Shared) so `xcodebuild -list` can see it.

## Costs and time

macOS minutes on GitHub Actions are billed at a higher rate than Linux minutes for private repositories (public repositories are free). A Capacitor build typically takes 5-15 minutes, mostly dependency resolution and compilation.

## Building Terminia itself

This repository contains the same templates in `.github/workflows/` and `.terminia/ci/` (kept identical by `npm run sync:templates` and checked by `npm run check:templates`). To build Terminia's own IPA:

1. Push this repository to GitHub (the default branch must contain `.github/workflows/terminia-ios.yml`).
2. Run **Terminia iOS** from the Actions tab (or from another Terminia) with the defaults: release, unsigned.
3. The runner runs `npm run build` (type check + Vite), `npx cap sync ios`, and builds the committed `ios/` project, which already contains Terminia's Swift plugins. The artifact is `App-release-unsigned.ipa`.

To install your own build on your iPad you need to sign it: either add your signing secrets and build with `export_method: development` (your iPad must be in the profile), or re-sign the unsigned IPA with your Apple ID (AltStore/Sideloadly), or open `ios/App/App.xcodeproj` on a Mac and run it with your team selected. Change the bundle identifier (`appId` in `capacitor.config.ts` and `PRODUCT_BUNDLE_IDENTIFIER`) to one you own first.
