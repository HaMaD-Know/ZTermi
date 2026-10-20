# Connecting GitHub

Terminia uses GitHub for three things: committing your project to a repository (sync), starting builds on GitHub Actions, and downloading their logs and artifacts. You connect once per iPad; each project then names the repository it builds in.

## Option A - fine-grained personal access token (simplest)

1. On github.com: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access**: *Only select repositories* → the repositories you will build in (you can create an empty one for a new project).
3. **Repository permissions**:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Actions | Read and write | start, follow and cancel workflow runs; list and download artifacts; read logs |
   | Contents | Read and write | compare and commit project files (sync), read workflow files |
   | Workflows | Read and write | commit `.github/workflows/terminia-*.yml` (GitHub requires this permission for workflow files) |
   | Metadata | Read | mandatory |
   | Secrets | Read *(optional)* | lets Terminia check that signing secrets **exist** before a signed build; their values can never be read |

4. Choose an expiry, generate, copy the token.
5. In Terminia: **Settings → Build providers › GitHub → Use a token** (or `terminia github login --token`) and paste it into the secure field.

A classic token also works (scopes `repo` and `workflow`), but grants access to all your repositories.

## Option B - device sign-in with your own OAuth App or GitHub App

No token to copy: Terminia shows a code, you enter it at github.com/login/device.

**OAuth App**: github.com → Settings → Developer settings → OAuth Apps → New. Any homepage/callback URL (they are not used by the device flow). Tick **Enable Device Flow**. Terminia asks for the `repo` and `workflow` scopes.

**GitHub App** (finer-grained, per-repository installation): Developer settings → GitHub Apps → New. Tick **Enable Device Flow**; set the repository permissions from the table above; install the app on the repositories you build. GitHub App user tokens expire after 8 hours unless you turn off *Expire user authorization tokens* in the app settings; Terminia does not hold a client secret, so it cannot refresh them - sign in again when the status shows the credential expired.

Then in Terminia: **Settings → Build providers › GitHub**, paste the app's **client id** (it is public; no client secret is used anywhere), **Save**, **Sign in with GitHub**. The device-flow requests and the token exchange run in native code; the token goes straight into the Keychain.

Device sign-in needs the iPad app: github.com's device endpoints do not allow browser requests, so the browser preview offers the token option only.

## Where the token lives

- iPad: typed into a native secure field, stored in the iOS Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synced, not in backups to other devices), read only by the native HTTP plugin, attached only to requests for `https://api.github.com`. GitHub redirects log and artifact downloads to short-lived storage URLs; the Authorization header is removed on those redirects.
- Browser preview: in memory for the current tab only - never `localStorage`.
- Never in the project, `.terminia/config.json`, settings, history, logs or URLs.

**Disconnect** (Settings or `terminia github logout`) deletes it from the Keychain. Revoke it on github.com too if you no longer use it.

## Per project

```text
terminia github use owner/repo          # optional: --branch build --path apps/mobile
terminia ci install                     # writes the workflow + CI scripts into the project
terminia github prepare                 # commits ONLY those files to the default branch
```

- `github use` checks that the repository exists and that you can push, and saves owner/repo/branch in `.terminia/config.json` (no secrets).
- `--path` is for monorepos: the folder inside the repository that holds this project.
- `github prepare` exists because **GitHub can only start a `workflow_dispatch` workflow that is on the default branch**. It shows the files and asks before committing. If you build on the default branch itself, the first sync adds the workflows anyway.

After that, every build is started from Terminia through the API (`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`) - you never need to press *Run workflow* on github.com.

## Sync: what gets committed

Before a build (or with `terminia git sync`), Terminia:

1. lists the project's files, skipping `.gitignore`d paths (including nested `.gitignore` files), `.terminiaignore`, and defaults such as `node_modules/`, `.git/`, `android/app/build/`, `ios/App/Pods/`;
2. **blocks** secrets: `.env*` (except `.env.example`), `.p12`, `.pfx`, `.p8`, `.mobileprovision`, `.jks`, `.keystore`, `key.properties`, SSH keys, `.netrc`, private-key blocks and token patterns in file contents;
3. computes Git blob ids locally and compares them with the branch's tree;
4. shows you the destination and the list of added/modified/deleted files and asks to confirm;
5. uploads only changed files (Git Data API), verifies GitHub stored the same content, creates one commit and **fast-forwards** the branch. If the branch moved meanwhile, nothing is overwritten - review again.

Files that exist only on GitHub are kept unless you pass `--delete`. A suspected hard-coded password that is a false positive can be allowed by listing its path in `.terminia/allow-secrets.txt`; blocked file types and tokens cannot be allowed.

## Rate limits and errors

Terminia reads GitHub's rate-limit headers, waits through short limits (secondary limits, a reset within a minute), retries read requests on 5xx/network errors with backoff, never retries a dispatch automatically, and polls running builds every few seconds (Settings → Builds), slowing down on errors. Errors come back with the reason and what to do - for example a missing *Workflows* permission, a workflow not on the default branch, or a private repository the token cannot see (GitHub answers 404 in that case).
