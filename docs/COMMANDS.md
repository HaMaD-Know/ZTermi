# Terminia command reference

Generated from the command registry by `tests/unit/command-docs.test.ts` - do not edit by hand.
Every command shows where it runs ("Runs on"). Local commands run on the iPad and are not PowerShell;
real PowerShell runs on a remote host (`remote connect`).

## `terminia`

```text
terminia — Projects, builds, dependencies, GitHub and remote hosts
Aliases: t

Run `terminia help <topic>` for details, e.g. `terminia help ios build`.

Commands:
  help       Help for the Terminia CLI
  version    Show the Terminia version
  status     Project, connections, builds and downloads at a glance
  targets    Explain where commands run
  project    Create, open, import and export projects
  ios        Build iOS apps (IPA) on macOS runners
  android    Build Android apps (APK/AAB) on Linux runners
  web        Build web, Node.js, Python and custom projects
  build      Build the current project for a target (ios, android, web, node, python, custom)
  deps       Dependencies: list, add, remove, install, update
  github     GitHub connection and build repository
  git        Repository sync through the GitHub API (status, diff, sync, log)
  ci         Install and check the GitHub Actions workflows Terminia uses
  artifacts  Downloaded build artifacts (IPA, APK, AAB, archives)
  remote     Remote PowerShell hosts (real PowerShell via the Terminia agent)

Run 'terminia <command> --help' for details.
```

## `terminia help`

```text
terminia help — Help for the Terminia CLI
Runs on: Local iPad

Usage:
  terminia help [topic...]

Arguments:
  topic  Subcommand, e.g. ios or ios build
```

## `terminia version`

```text
terminia version — Show the Terminia version
Runs on: Local iPad

Usage:
  terminia version
```

## `terminia status`

```text
terminia status — Project, connections, builds and downloads at a glance
Runs on: Local iPad

Usage:
  terminia status
```

## `terminia targets`

```text
terminia targets — Explain where commands run
Runs on: Local iPad

Usage:
  terminia targets
```

## `terminia project`

```text
terminia project — Create, open, import and export projects
Aliases: projects

Commands:
  list           List projects (workspace and opened folders)
  new            Create a project from a template and open it
  open           Make a project current and change into it
  close          Close the current project
  info           Show project type, build targets and configuration
  templates      List project templates
  export         Export the project as a zip (secrets and ignored files are left out)
  import         Import a project from a zip file you pick in Files
  import-folder  Copy a folder you pick in Files into the workspace
  open-folder    Open a folder in place (iCloud Drive, On My iPad, providers) with the document picker
  folders        List folders opened in place and their access state
  forget-folder  Stop using an opened folder (its files are not touched)

Run 'terminia project <command> --help' for details.
```

## `terminia project list`

```text
terminia project list — List projects (workspace and opened folders)
Runs on: Local iPad
Aliases: ls

Usage:
  terminia project list
```

## `terminia project new`

```text
terminia project new — Create a project from a template and open it
Runs on: Local iPad
Aliases: create

Usage:
  terminia project new <template> <name>

Arguments:
  template  capacitor, web, node, python, powershell or empty
  name      Project name

Examples:
  terminia project new capacitor MyApp
  terminia project new python tools
```

## `terminia project open`

```text
terminia project open — Make a project current and change into it
Runs on: Local iPad
Aliases: use

Usage:
  terminia project open [project]

Arguments:
  project  Project name or path (default: the current directory)
```

## `terminia project close`

```text
terminia project close — Close the current project
Runs on: Local iPad

Usage:
  terminia project close
```

## `terminia project info`

```text
terminia project info — Show project type, build targets and configuration
Runs on: Local iPad
Aliases: detect

Usage:
  terminia project info
```

## `terminia project templates`

```text
terminia project templates — List project templates
Runs on: Local iPad

Usage:
  terminia project templates
```

## `terminia project export`

```text
terminia project export — Export the project as a zip (secrets and ignored files are left out)
Runs on: Local iPad · document picker

Usage:
  terminia project export [options]

Options:
  --include-ignored  Also include files matched by .gitignore (secrets are still excluded)
  -s, --save         Show "Save to Files" afterwards
```

## `terminia project import`

```text
terminia project import — Import a project from a zip file you pick in Files
Runs on: Local iPad · document picker

Usage:
  terminia project import [options]

Options:
  --name <name>  Project name (default: the archive name)
```

## `terminia project import-folder`

```text
terminia project import-folder — Copy a folder you pick in Files into the workspace
Runs on: Local iPad · document picker

Usage:
  terminia project import-folder
```

## `terminia project open-folder`

```text
terminia project open-folder — Open a folder in place (iCloud Drive, On My iPad, providers) with the document picker
Runs on: Local iPad · document picker

Terminia gets access only to the folder you choose. iOS keeps a bookmark, so the folder reopens after a restart unless it was moved, deleted or its storage provider signed out - then choose it again.

Usage:
  terminia project open-folder
```

## `terminia project folders`

```text
terminia project folders — List folders opened in place and their access state
Runs on: Local iPad

Usage:
  terminia project folders
```

## `terminia project forget-folder`

```text
terminia project forget-folder — Stop using an opened folder (its files are not touched)
Runs on: Local iPad

Usage:
  terminia project forget-folder <folder>

Arguments:
  folder  Folder name or /folders/<name> path
```

## `terminia ios`

```text
terminia ios — Build iOS apps (IPA) on macOS runners

Commands:
  configure  Show or change the iOS build settings
  build      Build an iOS IPA on a GitHub Actions macOS runner
  status     Show the status of the latest (or a given) iOS build
  logs       Show the real job logs from GitHub Actions
  artifacts  List the artifacts a build produced
  download   Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
  cancel     Ask GitHub to cancel a running build
  history    List iOS builds

Run 'terminia ios <command> --help' for details.
```

## `terminia ios configure`

```text
terminia ios configure — Show or change the iOS build settings
Runs on: Local iPad

Without options: shows the settings and runs the preflight checks (nothing is changed). With options: saves them in .terminia/config.json.

Usage:
  terminia ios configure [options]

Options:
  --repo <repo>                                                GitHub repository (owner/name)
  --branch <branch>                                            Branch builds use (default: repository default branch)
  --project-path <project-path>                                Folder of the project inside the repository (default .)
  --sync <commit|none>                                         Default sync strategy
  --workflow <workflow>                                        Workflow file name
  --configuration <debug|release>                              Default configuration
  --export <unsigned|development|ad-hoc|app-store|enterprise>  Default export method
  --scheme <scheme>                                            Xcode scheme
  --xcode <xcode>                                              Xcode version on the runner (e.g. 26.5)
  --generate-native                                            Run `npx cap add ios` when ios/ is missing

Examples:
  terminia ios configure
  terminia ios configure --repo me/myapp --export ad-hoc
```

## `terminia ios build`

```text
terminia ios build — Build an iOS IPA on a GitHub Actions macOS runner
Runs on: GitHub Actions · macOS builder · Xcode build

Syncs the project to GitHub (after showing exactly what will be uploaded), starts the Terminia iOS workflow and follows it. An unsigned IPA must be signed before it can be installed; signed exports need signing secrets in the repository (docs/SIGNING.md).

Usage:
  terminia ios build [options]

Options:
  -c, --configuration <debug|release>                              Xcode build configuration
  -e, --export <unsigned|development|ad-hoc|app-store|enterprise>  unsigned, or a signed export method (needs signing secrets)
  --scheme <scheme>                                                Xcode scheme (default: App, or the first shared scheme)
  -b, --branch <branch>                                            Branch to build (default: the configured branch, else the default branch)
  --sync <commit|none>                                             commit = upload the project first (default); none = build what is on GitHub
  --delete                                                         When syncing, also delete files on GitHub that are not in the project
  --follow                                                         Follow progress until the build finishes (default; --no-follow to return at once)
  -y, --yes                                                        Skip the confirmation dialog (the details are still printed)

Examples:
  terminia ios build
  terminia ios build --configuration release
  terminia ios build --export ad-hoc
  terminia ios build --sync none --branch main
```

## `terminia ios status`

```text
terminia ios status — Show the status of the latest (or a given) iOS build
Runs on: Network · GitHub API

Usage:
  terminia ios status [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia ios logs`

```text
terminia ios logs — Show the real job logs from GitHub Actions
Runs on: Network · GitHub API

Finished jobs show their full log; running jobs show live step status (GitHub publishes the log text when a job finishes).

Usage:
  terminia ios logs [options] [build]

Arguments:
  build  Build id (default: the latest)

Options:
  -j, --job <job>      Only jobs whose name contains this text
  -n, --lines <lines>  Last N lines per job (default 400)
  -a, --all            Print the whole log
  -t, --timestamps     Keep GitHub timestamps
  --build <build>      Build id
```

## `terminia ios artifacts`

```text
terminia ios artifacts — List the artifacts a build produced
Runs on: Network · GitHub API

Usage:
  terminia ios artifacts [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia ios download`

```text
terminia ios download — Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
Runs on: Network · GitHub artifact storage

Usage:
  terminia ios download [options] [artifact]

Arguments:
  artifact  Artifact name or id (default: the build package)

Options:
  --build <build>  Build id (default: the latest)
  -s, --save       Then show "Save to Files" to choose a location
```

## `terminia ios cancel`

```text
terminia ios cancel — Ask GitHub to cancel a running build
Runs on: Network · GitHub API

Usage:
  terminia ios cancel [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia ios history`

```text
terminia ios history — List iOS builds
Runs on: Local iPad

Usage:
  terminia ios history [options]

Options:
  -n, --limit <limit>  Number of builds (default 20)
  -r, --remote         List runs on GitHub, including ones not started from Terminia
```

## `terminia android`

```text
terminia android — Build Android apps (APK/AAB) on Linux runners

Commands:
  configure  Show or change the Android build settings
  build      Build an Android APK/AAB on a GitHub Actions Linux runner
  status     Show the status of the latest (or a given) Android build
  logs       Show the real job logs from GitHub Actions
  artifacts  List the artifacts a build produced
  download   Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
  cancel     Ask GitHub to cancel a running build
  history    List Android builds

Run 'terminia android <command> --help' for details.
```

## `terminia android configure`

```text
terminia android configure — Show or change the Android build settings
Runs on: Local iPad

Without options: shows the settings and runs the preflight checks (nothing is changed). With options: saves them in .terminia/config.json.

Usage:
  terminia android configure [options]

Options:
  --repo <repo>                  GitHub repository (owner/name)
  --branch <branch>              Branch builds use (default: repository default branch)
  --project-path <project-path>  Folder of the project inside the repository (default .)
  --sync <commit|none>           Default sync strategy
  --workflow <workflow>          Workflow file name
  --variant <debug|release>      Default variant
  --output <apk|aab|both>        Default package format
  --module <module>              Gradle application module
  --java <java>                  JDK major version (e.g. 21)
  --generate-native              Run `npx cap add android` when android/ is missing

Examples:
  terminia android configure --variant release --output both
```

## `terminia android build`

```text
terminia android build — Build an Android APK/AAB on a GitHub Actions Linux runner
Runs on: GitHub Actions · Linux builder · Gradle build

Syncs the project, starts the Terminia Android workflow and follows it. APKs are Android packages: they cannot be installed on an iPad.

Usage:
  terminia android build [options]

Options:
  -v, --variant <debug|release>  Build variant (release needs signing secrets)
  -o, --output <apk|aab|both>    apk, aab or both
  --module <module>              Gradle application module (default app)
  -b, --branch <branch>          Branch to build (default: the configured branch, else the default branch)
  --sync <commit|none>           commit = upload the project first (default); none = build what is on GitHub
  --delete                       When syncing, also delete files on GitHub that are not in the project
  --follow                       Follow progress until the build finishes (default; --no-follow to return at once)
  -y, --yes                      Skip the confirmation dialog (the details are still printed)

Examples:
  terminia android build --variant debug
  terminia android build --variant release --output both
```

## `terminia android status`

```text
terminia android status — Show the status of the latest (or a given) Android build
Runs on: Network · GitHub API

Usage:
  terminia android status [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia android logs`

```text
terminia android logs — Show the real job logs from GitHub Actions
Runs on: Network · GitHub API

Finished jobs show their full log; running jobs show live step status (GitHub publishes the log text when a job finishes).

Usage:
  terminia android logs [options] [build]

Arguments:
  build  Build id (default: the latest)

Options:
  -j, --job <job>      Only jobs whose name contains this text
  -n, --lines <lines>  Last N lines per job (default 400)
  -a, --all            Print the whole log
  -t, --timestamps     Keep GitHub timestamps
  --build <build>      Build id
```

## `terminia android artifacts`

```text
terminia android artifacts — List the artifacts a build produced
Runs on: Network · GitHub API

Usage:
  terminia android artifacts [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia android download`

```text
terminia android download — Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
Runs on: Network · GitHub artifact storage

Usage:
  terminia android download [options] [artifact]

Arguments:
  artifact  Artifact name or id (default: the build package)

Options:
  --build <build>  Build id (default: the latest)
  -s, --save       Then show "Save to Files" to choose a location
```

## `terminia android cancel`

```text
terminia android cancel — Ask GitHub to cancel a running build
Runs on: Network · GitHub API

Usage:
  terminia android cancel [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia android history`

```text
terminia android history — List Android builds
Runs on: Local iPad

Usage:
  terminia android history [options]

Options:
  -n, --limit <limit>  Number of builds (default 20)
  -r, --remote         List runs on GitHub, including ones not started from Terminia
```

## `terminia web`

```text
terminia web — Build web, Node.js, Python and custom projects

Commands:
  configure  Show or change the Web build settings
  build      Build a web, Node.js, Python or custom project on GitHub Actions
  status     Show the status of the latest (or a given) Web build
  logs       Show the real job logs from GitHub Actions
  artifacts  List the artifacts a build produced
  download   Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
  cancel     Ask GitHub to cancel a running build
  history    List Web builds

Run 'terminia web <command> --help' for details.
```

## `terminia web configure`

```text
terminia web configure — Show or change the Web build settings
Runs on: Local iPad

Without options: shows the settings and runs the preflight checks (nothing is changed). With options: saves them in .terminia/config.json.

Usage:
  terminia web configure [options]

Options:
  --repo <repo>                    GitHub repository (owner/name)
  --branch <branch>                Branch builds use (default: repository default branch)
  --project-path <project-path>    Folder of the project inside the repository (default .)
  --sync <commit|none>             Default sync strategy
  --workflow <workflow>            Workflow file name
  --kind <web|node|python|custom>  Default build kind
  --command <command>              Default build command
  --output-path <output-path>      Default output folder
  --node <node>                    Node.js version on the runner
  --python <python>                Python version on the runner

Examples:
  terminia web configure --kind node --command "npm run build" --output-path dist
```

## `terminia web build`

```text
terminia web build — Build a web, Node.js, Python or custom project on GitHub Actions
Runs on: GitHub Actions · Linux builder · web build

Syncs the project and runs its build on a temporary runner; the output folder is uploaded as an artifact.

Usage:
  terminia web build [options]

Options:
  --kind <web|node|python|custom>  web, node, python or custom
  --command <command>              Build command to run on the runner (shown before starting)
  --output-path <output-path>      Output folder or file, relative to the project
  --runner <linux|macos>           Runner operating system
  -p, --profile <profile>          Custom build profile from .terminia/config.json
  -b, --branch <branch>            Branch to build (default: the configured branch, else the default branch)
  --sync <commit|none>             commit = upload the project first (default); none = build what is on GitHub
  --delete                         When syncing, also delete files on GitHub that are not in the project
  --follow                         Follow progress until the build finishes (default; --no-follow to return at once)
  -y, --yes                        Skip the confirmation dialog (the details are still printed)

Examples:
  terminia web build
  terminia web build --kind python
  terminia web build --profile docs
```

## `terminia web status`

```text
terminia web status — Show the status of the latest (or a given) Web build
Runs on: Network · GitHub API

Usage:
  terminia web status [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia web logs`

```text
terminia web logs — Show the real job logs from GitHub Actions
Runs on: Network · GitHub API

Finished jobs show their full log; running jobs show live step status (GitHub publishes the log text when a job finishes).

Usage:
  terminia web logs [options] [build]

Arguments:
  build  Build id (default: the latest)

Options:
  -j, --job <job>      Only jobs whose name contains this text
  -n, --lines <lines>  Last N lines per job (default 400)
  -a, --all            Print the whole log
  -t, --timestamps     Keep GitHub timestamps
  --build <build>      Build id
```

## `terminia web artifacts`

```text
terminia web artifacts — List the artifacts a build produced
Runs on: Network · GitHub API

Usage:
  terminia web artifacts [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia web download`

```text
terminia web download — Download a build artifact to Terminia › Artifacts (and optionally Save to Files)
Runs on: Network · GitHub artifact storage

Usage:
  terminia web download [options] [artifact]

Arguments:
  artifact  Artifact name or id (default: the build package)

Options:
  --build <build>  Build id (default: the latest)
  -s, --save       Then show "Save to Files" to choose a location
```

## `terminia web cancel`

```text
terminia web cancel — Ask GitHub to cancel a running build
Runs on: Network · GitHub API

Usage:
  terminia web cancel [build]

Arguments:
  build  Build id (default: the latest)
```

## `terminia web history`

```text
terminia web history — List Web builds
Runs on: Local iPad

Usage:
  terminia web history [options]

Options:
  -n, --limit <limit>  Number of builds (default 20)
  -r, --remote         List runs on GitHub, including ones not started from Terminia
```

## `terminia build`

```text
terminia build — Build the current project for a target (ios, android, web, node, python, custom)
Runs on: GitHub Actions · macOS or Linux builder

Usage:
  terminia build [options] [target]

Arguments:
  target  ios, android, web, node, python or custom (required when several are possible) (ios, android, web, node, python, custom)

Options:
  -c, --configuration <debug|release>                              Xcode build configuration
  -e, --export <unsigned|development|ad-hoc|app-store|enterprise>  unsigned, or a signed export method (needs signing secrets)
  --scheme <scheme>                                                Xcode scheme (default: App, or the first shared scheme)
  -v, --variant <debug|release>                                    Build variant (release needs signing secrets)
  -o, --output <apk|aab|both>                                      apk, aab or both
  --module <module>                                                Gradle application module (default app)
  --command <command>                                              Build command to run on the runner (shown before starting)
  --output-path <output-path>                                      Output folder or file, relative to the project
  --runner <linux|macos>                                           Runner operating system
  -p, --profile <profile>                                          Custom build profile from .terminia/config.json
  -b, --branch <branch>                                            Branch to build (default: the configured branch, else the default branch)
  --sync <commit|none>                                             commit = upload the project first (default); none = build what is on GitHub
  --delete                                                         When syncing, also delete files on GitHub that are not in the project
  --follow                                                         Follow progress until the build finishes (default; --no-follow to return at once)
  -y, --yes                                                        Skip the confirmation dialog (the details are still printed)
```

## `terminia deps`

```text
terminia deps — Dependencies: list, add, remove, install, update
Aliases: dependencies

The iPad has no Node.js, Python or CocoaPods. Terminia reads and edits manifests locally and runs the real package managers on GitHub Actions runners or a remote host - never on the iPad.

Commands:
  list     List declared dependencies and locked versions
  info     Look up a package in its registry (metadata only)
  add      Declare packages in the manifest (optionally install them right away)
  remove   Remove packages from the manifest
  install  Install dependencies with the real package manager (GitHub Actions or a remote host)
  update   Update dependencies (all, or the named ones) with the real package manager
  resolve  Resolve and report the full dependency graph on a builder (Gradle, CocoaPods, SwiftPM, npm…)
  logs     Show the latest dependency job

Run 'terminia deps <command> --help' for details.
```

## `terminia deps list`

```text
terminia deps list — List declared dependencies and locked versions
Runs on: Local iPad
Aliases: ls

Usage:
  terminia deps list [options]

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
```

## `terminia deps info`

```text
terminia deps info — Look up a package in its registry (metadata only)
Runs on: Network · registry.npmjs.org

Usage:
  terminia deps info [options] <package>

Arguments:
  package  Package name

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
```

## `terminia deps add`

```text
terminia deps add — Declare packages in the manifest (optionally install them right away)
Runs on: Network · package registry

Edits package.json, requirements.txt or pyproject.toml on the iPad. Without a version, the latest is looked up in the registry. Packages are not installed until `terminia deps install` (or --install) runs the real package manager on a builder or remote host.

Usage:
  terminia deps add [options] <package...>

Arguments:
  package  Packages, optionally with a version (lodash@^4, requests>=2.31)

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
  -D, --dev                                                                Development dependency
  -i, --install                                                            Install right away (with --on)
  --on <github|remote>                                                     Where the package manager runs: github (default) or remote
  --remote <remote>                                                        Remote host profile (with --on remote)
  -y, --yes                                                                Skip the confirmation dialog (the details are still printed)

Examples:
  terminia deps add lodash
  terminia deps add --dev vitest@^3
  terminia deps add requests --ecosystem pip
  terminia deps add axios --install
```

## `terminia deps remove`

```text
terminia deps remove — Remove packages from the manifest
Runs on: Local iPad
Aliases: rm, uninstall

Usage:
  terminia deps remove [options] <package...>

Arguments:
  package  Packages

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
```

## `terminia deps install`

```text
terminia deps install — Install dependencies with the real package manager (GitHub Actions or a remote host)
Runs on: GitHub Actions · Linux builder · package manager

On GitHub Actions the project is synced, the package manager runs on a clean runner, and the resulting lockfile/manifest are offered back to the project. On a remote host the command runs in that host's copy of the project.

Usage:
  terminia deps install [options]

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
  --on <github|remote>                                                     Where the package manager runs: github (default) or remote
  --remote <remote>                                                        Remote host profile (with --on remote)
  -y, --yes                                                                Skip the confirmation dialog (the details are still printed)
```

## `terminia deps update`

```text
terminia deps update — Update dependencies (all, or the named ones) with the real package manager
Runs on: GitHub Actions · Linux builder · package manager
Aliases: upgrade

Usage:
  terminia deps update [options] [package...]

Arguments:
  package  Packages (default: all)

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
  --on <github|remote>                                                     Where the package manager runs: github (default) or remote
  --remote <remote>                                                        Remote host profile (with --on remote)
  -y, --yes                                                                Skip the confirmation dialog (the details are still printed)
```

## `terminia deps resolve`

```text
terminia deps resolve — Resolve and report the full dependency graph on a builder (Gradle, CocoaPods, SwiftPM, npm…)
Runs on: GitHub Actions · Linux builder · package manager

Usage:
  terminia deps resolve [options]

Options:
  -e, --ecosystem <npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm|powershell>  Which manifest to use when the project has several
  -y, --yes                                                                Skip the confirmation dialog (the details are still printed)
```

## `terminia deps logs`

```text
terminia deps logs — Show the latest dependency job
Runs on: Network · GitHub API

Usage:
  terminia deps logs
```

## `terminia github`

```text
terminia github — GitHub connection and build repository
Aliases: gh

Commands:
  login      Connect GitHub (device sign-in or a personal access token, stored in the iOS Keychain)
  logout     Remove the GitHub credential from this iPad
  status     Show the GitHub connection
  repos      List repositories you can access
  use        Set the GitHub repository (and branch) this project builds in
  branches   List branches of the project repository
  workflows  List the workflows GitHub knows for the repository
  prepare    Put Terminia's workflows on the repository's default branch (needed before the first build)

Run 'terminia github <command> --help' for details.
```

## `terminia github login`

```text
terminia github login — Connect GitHub (device sign-in or a personal access token, stored in the iOS Keychain)
Runs on: Network · github.com

Device sign-in shows a code to enter at github.com/login/device; it needs the client id of your GitHub OAuth App or GitHub App (Settings › Build Providers › GitHub). A fine-grained token needs Actions, Contents and Workflows (read & write) and Metadata (read). Either way, the token is stored natively and is only sent to api.github.com.

Usage:
  terminia github login [options]

Options:
  --token   Enter a personal access token
  --device  Use the OAuth device flow (default when a client id is configured)
```

## `terminia github logout`

```text
terminia github logout — Remove the GitHub credential from this iPad
Runs on: Local iPad

Usage:
  terminia github logout
```

## `terminia github status`

```text
terminia github status — Show the GitHub connection
Runs on: Network · GitHub API

Usage:
  terminia github status
```

## `terminia github repos`

```text
terminia github repos — List repositories you can access
Runs on: Network · GitHub API

Usage:
  terminia github repos [filter]

Arguments:
  filter  Text to filter names
```

## `terminia github use`

```text
terminia github use — Set the GitHub repository (and branch) this project builds in
Runs on: Network · GitHub API

Usage:
  terminia github use [options] <repository>

Arguments:
  repository  owner/name

Options:
  -b, --branch <branch>  Branch to sync and build (default: the repository default branch)
  --path <path>          Folder of the project inside the repository (default .)
```

## `terminia github branches`

```text
terminia github branches — List branches of the project repository
Runs on: Network · GitHub API

Usage:
  terminia github branches
```

## `terminia github workflows`

```text
terminia github workflows — List the workflows GitHub knows for the repository
Runs on: Network · GitHub API

Usage:
  terminia github workflows
```

## `terminia github prepare`

```text
terminia github prepare — Put Terminia's workflows on the repository's default branch (needed before the first build)
Runs on: Network · GitHub API

GitHub only starts workflows that exist on the default branch. This commits .github/workflows/terminia-*.yml and .terminia/ci/* there - nothing else - after showing you the files.

Usage:
  terminia github prepare [options]

Options:
  -y, --yes  Skip the confirmation dialog (the details are still printed)
```

## `terminia git`

```text
terminia git — Repository sync through the GitHub API (status, diff, sync, log)

There is no git client on iPad. Terminia compares and commits files through the GitHub Git Data API, never force-pushes, and blocks detected secrets.

Commands:
  status  Compare the project with its GitHub branch (nothing is uploaded)
  diff    Show line changes between local files and the GitHub branch
  sync    Commit the project to its GitHub branch (preview, secret check and confirmation first)
  log     Recent commits on the GitHub branch

Run 'terminia git <command> --help' for details.
```

## `terminia git status`

```text
terminia git status — Compare the project with its GitHub branch (nothing is uploaded)
Runs on: Network · GitHub API

Usage:
  terminia git status [options]

Options:
  -b, --branch <branch>  Branch (default: configured)
```

## `terminia git diff`

```text
terminia git diff — Show line changes between local files and the GitHub branch
Runs on: Network · GitHub API

Usage:
  terminia git diff [options] [path...]

Arguments:
  path  Files (default: all changed text files)

Options:
  -b, --branch <branch>  Branch (default: configured)
```

## `terminia git sync`

```text
terminia git sync — Commit the project to its GitHub branch (preview, secret check and confirmation first)
Runs on: Network · GitHub API
Aliases: push

Usage:
  terminia git sync [options]

Options:
  -m, --message <message>  Commit message
  -b, --branch <branch>    Branch (default: configured; created if missing)
  --delete                 Also delete files on GitHub that are not in the project
  -y, --yes                Skip the confirmation dialog (the details are still printed)
```

## `terminia git log`

```text
terminia git log — Recent commits on the GitHub branch
Runs on: Network · GitHub API

Usage:
  terminia git log [options]

Options:
  -n, --limit <limit>    Number of commits (default 15)
  -b, --branch <branch>  Branch
```

## `terminia ci`

```text
terminia ci — Install and check the GitHub Actions workflows Terminia uses

Commands:
  install  Add Terminia's GitHub Actions workflows and CI scripts to the project
  status   Compare the CI files in the project (and on GitHub) with this version of Terminia

Run 'terminia ci <command> --help' for details.
```

## `terminia ci install`

```text
terminia ci install — Add Terminia's GitHub Actions workflows and CI scripts to the project
Runs on: Local iPad

Usage:
  terminia ci install [options]

Options:
  -f, --force  Replace files you edited (and same-named files not from Terminia)
```

## `terminia ci status`

```text
terminia ci status — Compare the CI files in the project (and on GitHub) with this version of Terminia
Runs on: Network · GitHub API

Usage:
  terminia ci status [options]

Options:
  --local  Only check the project, not GitHub
```

## `terminia artifacts`

```text
terminia artifacts — Downloaded build artifacts (IPA, APK, AAB, archives)

Commands:
  list    List downloaded artifacts
  save    Save a downloaded artifact to a location you choose in Files
  remove  Delete a downloaded artifact from Terminia › Artifacts
  open    Show the Artifacts view

Run 'terminia artifacts <command> --help' for details.
```

## `terminia artifacts list`

```text
terminia artifacts list — List downloaded artifacts
Runs on: Local iPad
Aliases: ls

Usage:
  terminia artifacts list
```

## `terminia artifacts save`

```text
terminia artifacts save — Save a downloaded artifact to a location you choose in Files
Runs on: Local iPad · document picker

Usage:
  terminia artifacts save [artifact]

Arguments:
  artifact  Name or id (default: the latest download)
```

## `terminia artifacts remove`

```text
terminia artifacts remove — Delete a downloaded artifact from Terminia › Artifacts
Runs on: Local iPad
Aliases: rm

Usage:
  terminia artifacts remove [options] <artifact>

Arguments:
  artifact  Name or id

Options:
  -y, --yes  Skip the confirmation dialog (the details are still printed)
```

## `terminia artifacts open`

```text
terminia artifacts open — Show the Artifacts view
Runs on: Local iPad

Usage:
  terminia artifacts open
```

## `terminia remote`

```text
terminia remote — Remote PowerShell hosts (real PowerShell via the Terminia agent)

Real PowerShell does not run on iPad. Run `node agent/terminia-agent.mjs` on a Windows, macOS or Linux computer with PowerShell, add it here, and connect. See docs/REMOTE-HOST.md.

Commands:
  list        List remote PowerShell hosts
  add         Add a remote host (the agent token is entered in a secure field)
  remove      Remove a remote host and its stored token
  token       Enter a new agent token for a host (after `terminia-agent token`)
  test        Check the connection and show the host's PowerShell
  connect     Switch this tab to a real PowerShell session on a remote host
  disconnect  Leave remote mode in this tab
  status      Show whether this tab is connected to a remote host
  map         Tell Terminia where the current project lives on a remote host
  exec        Run one PowerShell command on a remote host without switching the tab

Run 'terminia remote <command> --help' for details.
```

## `terminia remote list`

```text
terminia remote list — List remote PowerShell hosts
Runs on: Local iPad
Aliases: ls

Usage:
  terminia remote list
```

## `terminia remote add`

```text
terminia remote add — Add a remote host (the agent token is entered in a secure field)
Runs on: Local iPad

Usage:
  terminia remote add [options] <name> <url>

Arguments:
  name  Short name, e.g. devbox
  url   Agent URL, e.g. https://devbox.tailnet.ts.net:8765

Options:
  --fingerprint <fingerprint>  SHA-256 of the agent certificate to pin (printed by the agent)
```

## `terminia remote remove`

```text
terminia remote remove — Remove a remote host and its stored token
Runs on: Local iPad
Aliases: rm

Usage:
  terminia remote remove [options] <profile>

Arguments:
  profile  Remote host profile name

Options:
  -y, --yes  Skip the confirmation dialog (the details are still printed)
```

## `terminia remote token`

```text
terminia remote token — Enter a new agent token for a host (after `terminia-agent token`)
Runs on: Local iPad

Usage:
  terminia remote token <profile>

Arguments:
  profile  Remote host profile name
```

## `terminia remote test`

```text
terminia remote test — Check the connection and show the host's PowerShell
Runs on: Remote PowerShell · ?

Usage:
  terminia remote test <profile>

Arguments:
  profile  Remote host profile name
```

## `terminia remote connect`

```text
terminia remote connect — Switch this tab to a real PowerShell session on a remote host
Runs on: Remote PowerShell · ?
Aliases: enter

Every line you type afterwards runs REMOTELY in a persistent PowerShell session on that host (variables, functions and location persist). Type `exit` to come back to local commands. Prefix a line with ':' to run one local command, e.g. ':ls'. `terminia ...` commands always run locally.

Usage:
  terminia remote connect <profile>

Arguments:
  profile  Remote host profile name
```

## `terminia remote disconnect`

```text
terminia remote disconnect — Leave remote mode in this tab
Runs on: Local iPad

Usage:
  terminia remote disconnect
```

## `terminia remote status`

```text
terminia remote status — Show whether this tab is connected to a remote host
Runs on: Local iPad

Usage:
  terminia remote status
```

## `terminia remote map`

```text
terminia remote map — Tell Terminia where the current project lives on a remote host
Runs on: Local iPad

Usage:
  terminia remote map <profile> <path>

Arguments:
  profile  Remote host profile name
  path     Folder on the host, e.g. C:\src\myapp
```

## `terminia remote exec`

```text
terminia remote exec — Run one PowerShell command on a remote host without switching the tab
Runs on: Remote PowerShell · ?
Aliases: run

Usage:
  remote exec <profile> -- <PowerShell command>

Arguments:
  profile  Remote host profile name

Examples:
  remote exec devbox -- Get-Process | Sort-Object CPU -Descending | Select-Object -First 5
```

## `cat`

```text
cat — Print text files
Runs on: Local iPad
Aliases: type, gc, Get-Content

Usage:
  cat [options] [file...]

Arguments:
  file  Files (or piped input)

Options:
  -n, --number   Number lines
  --path <path>  Path (PowerShell style; same as the positional argument)
```

## `cd`

```text
cd — Change the current directory
Runs on: Local iPad
Aliases: chdir, sl, Set-Location

Usage:
  cd [options] [path]

Arguments:
  path  Directory (default: ~, the workspace)

Options:
  --path <path>  Path (PowerShell style; same as the positional argument)
```

## `clear`

```text
clear — Clear the terminal
Runs on: Local iPad
Aliases: cls, Clear-Host

Usage:
  clear
```

## `cp`

```text
cp — Copy files and directories
Runs on: Local iPad
Aliases: copy, cpi, Copy-Item

Usage:
  cp [options] [source-and-dest...]

Arguments:
  source-and-dest  SOURCE... DEST

Options:
  -r, --recursive              Copy directories
  --path <path>                Path (PowerShell style; same as the positional argument)
  --destination <destination>  Destination (PowerShell style)
```

## `date`

```text
date — Print the date and time
Runs on: Local iPad
Aliases: Get-Date

Usage:
  date [options]

Options:
  --iso  ISO 8601 (UTC)
```

## `du`

```text
du — Total size of a directory
Runs on: Local iPad

Usage:
  du [dir]

Arguments:
  dir  Directory (default: current)
```

## `echo`

```text
echo — Print arguments
Runs on: Local iPad
Aliases: Write-Output, write

Usage:
  echo [options] [text...]

Arguments:
  text  Words to print

Options:
  -n, --no-newline  No trailing newline
```

## `edit`

```text
edit — Open a file in the editor (creates it if needed)
Runs on: Local iPad · editor
Aliases: open, code

Usage:
  edit <file>

Arguments:
  file  File to open
```

## `exit`

```text
exit — Leave remote mode (in local mode there is nothing to exit)
Runs on: Local iPad
Aliases: Exit-PSSession

Usage:
  exit
```

## `find`

```text
find — Find files by name
Runs on: Local iPad

Usage:
  find [options] [dir]

Arguments:
  dir  Where to search (default: current directory)

Options:
  --name <name>  Wildcard on the file name, e.g. *.json
  --type <f|d>   f = files, d = directories

Examples:
  find . -name "*.swift"
  find src -type d
```

## `grep`

```text
grep — Search text with a regular expression
Runs on: Local iPad
Aliases: sls, Select-String

grep is case-sensitive unless -i is given. The Select-String alias is case-insensitive unless -CaseSensitive is given, as in PowerShell.

Usage:
  grep [options] [pattern-and-files...]

Arguments:
  pattern-and-files  PATTERN [FILE...] (files can be directories with -r)

Options:
  -i, --ignore-case         Case-insensitive
  --CaseSensitive           Case-sensitive (Select-String)
  -n, --line-number         Show line numbers
  -r, --recursive           Search directories recursively
  -l, --files-with-matches  Only print file names
  -v, --invert-match        Print non-matching lines
  -F, --fixed-strings       Pattern is plain text, not a regex
  --pattern <pattern>       Pattern (PowerShell style)
  --path <path>             Path (PowerShell style; same as the positional argument)
```

## `head`

```text
head — Print the first lines
Runs on: Local iPad

Usage:
  head [options] [file...]

Arguments:
  file  Files (or piped input)

Options:
  -n, --lines <lines>  Number of lines (default 10)
```

## `help`

```text
help — List commands, or show help for one
Runs on: Local iPad
Aliases: Get-Help, man

Usage:
  help [command...]

Arguments:
  command  Command (and subcommands), e.g. terminia ios build
```

## `history`

```text
history — Show command history (secrets are redacted before saving)
Runs on: Local iPad
Aliases: h, Get-History

Usage:
  history [options]

Options:
  -n, --count <count>  Number of entries (default 50)
```

## `ls`

```text
ls — List a directory
Runs on: Local iPad
Aliases: dir, gci, Get-ChildItem

Usage:
  ls [options] [path...]

Arguments:
  path  Directory or file (default: current directory)

Options:
  -a, --all          Include hidden entries (names starting with .)
  -l, --long         Long listing (mode, size, modified time)
  -R, --recurse      List subdirectories too
  --filter <filter>  Only names matching a wildcard, e.g. *.ts
  --path <path>      Path (PowerShell style; same as the positional argument)

Examples:
  ls
  ls -la src
  Get-ChildItem -Recurse -Filter *.swift
```

## `mkdir`

```text
mkdir — Create directories
Runs on: Local iPad
Aliases: md

Usage:
  mkdir [options] <dir...>

Arguments:
  dir  Directories to create

Options:
  -p, --parents  Create parent directories as needed; no error if it exists
```

## `mv`

```text
mv — Move or rename files and directories
Runs on: Local iPad
Aliases: move, mi, Move-Item

Usage:
  mv [options] [source-and-dest...]

Arguments:
  source-and-dest  SOURCE... DEST

Options:
  --path <path>                Path (PowerShell style; same as the positional argument)
  --destination <destination>  Destination (PowerShell style)
```

## `New-Item`

```text
New-Item — Create a file or directory (PowerShell-style built-in)
Runs on: Local iPad
Aliases: ni

Usage:
  New-Item [options] [path]

Arguments:
  path  Path to create

Options:
  --ItemType <File|Directory>  File (default) or Directory
  --Name <Name>                Name inside -Path
  --Value <Value>              Initial file content
  --Force                      Overwrite an existing file / create parents
  --path <path>                Path (PowerShell style; same as the positional argument)
```

## `pwd`

```text
pwd — Print the current directory
Runs on: Local iPad
Aliases: gl, Get-Location

Usage:
  pwd
```

## `remote`

```text
remote — Remote PowerShell hosts (real PowerShell via the Terminia agent)

Real PowerShell does not run on iPad. Run `node agent/terminia-agent.mjs` on a Windows, macOS or Linux computer with PowerShell, add it here, and connect. See docs/REMOTE-HOST.md.

Commands:
  list        List remote PowerShell hosts
  add         Add a remote host (the agent token is entered in a secure field)
  remove      Remove a remote host and its stored token
  token       Enter a new agent token for a host (after `terminia-agent token`)
  test        Check the connection and show the host's PowerShell
  connect     Switch this tab to a real PowerShell session on a remote host
  disconnect  Leave remote mode in this tab
  status      Show whether this tab is connected to a remote host
  map         Tell Terminia where the current project lives on a remote host
  exec        Run one PowerShell command on a remote host without switching the tab

Run 'remote <command> --help' for details.
```

## `remote list`

```text
remote list — List remote PowerShell hosts
Runs on: Local iPad
Aliases: ls

Usage:
  remote list
```

## `remote add`

```text
remote add — Add a remote host (the agent token is entered in a secure field)
Runs on: Local iPad

Usage:
  remote add [options] <name> <url>

Arguments:
  name  Short name, e.g. devbox
  url   Agent URL, e.g. https://devbox.tailnet.ts.net:8765

Options:
  --fingerprint <fingerprint>  SHA-256 of the agent certificate to pin (printed by the agent)
```

## `remote remove`

```text
remote remove — Remove a remote host and its stored token
Runs on: Local iPad
Aliases: rm

Usage:
  remote remove [options] <profile>

Arguments:
  profile  Remote host profile name

Options:
  -y, --yes  Skip the confirmation dialog (the details are still printed)
```

## `remote token`

```text
remote token — Enter a new agent token for a host (after `terminia-agent token`)
Runs on: Local iPad

Usage:
  remote token <profile>

Arguments:
  profile  Remote host profile name
```

## `remote test`

```text
remote test — Check the connection and show the host's PowerShell
Runs on: Remote PowerShell · ?

Usage:
  remote test <profile>

Arguments:
  profile  Remote host profile name
```

## `remote connect`

```text
remote connect — Switch this tab to a real PowerShell session on a remote host
Runs on: Remote PowerShell · ?
Aliases: enter

Every line you type afterwards runs REMOTELY in a persistent PowerShell session on that host (variables, functions and location persist). Type `exit` to come back to local commands. Prefix a line with ':' to run one local command, e.g. ':ls'. `terminia ...` commands always run locally.

Usage:
  remote connect <profile>

Arguments:
  profile  Remote host profile name
```

## `remote disconnect`

```text
remote disconnect — Leave remote mode in this tab
Runs on: Local iPad

Usage:
  remote disconnect
```

## `remote status`

```text
remote status — Show whether this tab is connected to a remote host
Runs on: Local iPad

Usage:
  remote status
```

## `remote map`

```text
remote map — Tell Terminia where the current project lives on a remote host
Runs on: Local iPad

Usage:
  remote map <profile> <path>

Arguments:
  profile  Remote host profile name
  path     Folder on the host, e.g. C:\src\myapp
```

## `remote exec`

```text
remote exec — Run one PowerShell command on a remote host without switching the tab
Runs on: Remote PowerShell · ?
Aliases: run

Usage:
  remote exec <profile> -- <PowerShell command>

Arguments:
  profile  Remote host profile name

Examples:
  remote exec devbox -- Get-Process | Sort-Object CPU -Descending | Select-Object -First 5
```

## `Rename-Item`

```text
Rename-Item — Rename a file or directory in place
Runs on: Local iPad
Aliases: ren, rni

Usage:
  Rename-Item [options] [path-and-name...]

Arguments:
  path-and-name  PATH NEWNAME

Options:
  --path <path>        Path (PowerShell style; same as the positional argument)
  --NewName <NewName>  New name
```

## `rm`

```text
rm — Delete files or directories (permanently - there is no trash)
Runs on: Local iPad
Aliases: del, erase, rd, rmdir, ri, Remove-Item

Usage:
  rm [options] [path...]

Arguments:
  path  Paths to delete

Options:
  -r, --recursive  Delete directories and their contents
  -f, --force      No confirmation, no error for missing files
  --path <path>    Path (PowerShell style; same as the positional argument)
```

## `screen`

```text
screen — Open a full screen: projects, files, deps, builds, artifacts or settings (Esc returns here)
Runs on: Local iPad
Aliases: show

Usage:
  screen <screen>

Arguments:
  screen  projects, files, deps, builds, artifacts, settings
```

## `Set-Content`

```text
Set-Content — Write text to a file (from -Value or piped input)
Runs on: Local iPad
Aliases: sc

Usage:
  Set-Content [options] [path]

Arguments:
  path  File

Options:
  --path <path>    Path (PowerShell style; same as the positional argument)
  --Value <Value>  Text to write
  --NoNewline      Do not add a final newline
  -y, --yes        Skip the confirmation dialog (the details are still printed)
```

## `sha256`

```text
sha256 — Compute file hashes (SHA256 or SHA1)
Runs on: Local iPad
Aliases: Get-FileHash, shasum

Usage:
  sha256 [options] [file...]

Arguments:
  file  Files

Options:
  -a, --Algorithm <SHA256|SHA1>  Hash algorithm (default SHA256)
  --path <path>                  Path (PowerShell style; same as the positional argument)
```

## `sleep`

```text
sleep — Wait for a number of seconds (Ctrl+C stops it)
Runs on: Local iPad
Aliases: Start-Sleep

Usage:
  sleep [options] [seconds]

Arguments:
  seconds  Seconds to wait

Options:
  -s, --Seconds <Seconds>  Seconds
```

## `sort`

```text
sort — Sort lines
Runs on: Local iPad

Usage:
  sort [options] [file...]

Arguments:
  file  Files (or piped input)

Options:
  -r, --reverse  Reverse order
  -n, --numeric  Numeric sort
  -u, --unique   Drop duplicates
```

## `stat`

```text
stat — Show file details
Runs on: Local iPad

Usage:
  stat <path...>

Arguments:
  path  Paths
```

## `tail`

```text
tail — Print the last lines
Runs on: Local iPad

Usage:
  tail [options] [file...]

Arguments:
  file  Files (or piped input)

Options:
  -n, --lines <lines>  Number of lines (default 10)
```

## `touch`

```text
touch — Create empty files (existing files are left unchanged)
Runs on: Local iPad

Usage:
  touch <file...>

Arguments:
  file  Files
```

## `tree`

```text
tree — Show a directory tree
Runs on: Local iPad

Usage:
  tree [options] [dir]

Arguments:
  dir  Directory (default: current)

Options:
  -L, --level <level>  Maximum depth (default 4)
  -a, --all            Include hidden entries
```

## `uniq`

```text
uniq — Collapse repeated adjacent lines
Runs on: Local iPad

Usage:
  uniq [options] [file]

Arguments:
  file  File (or piped input)

Options:
  -c, --count  Prefix lines with their count
```

## `unzip`

```text
unzip — Extract a zip archive (paths are checked; nothing escapes the destination)
Runs on: Local iPad
Aliases: Expand-Archive

Usage:
  unzip [options] [archive]

Arguments:
  archive  Zip file

Options:
  -d, --dest <dest>  Destination directory (default: current)
  -o, --overwrite    Overwrite existing files
  -l, --list         List the contents only
  --path <path>      Path (PowerShell style; same as the positional argument)
```

## `wc`

```text
wc — Count lines, words and bytes
Runs on: Local iPad

Usage:
  wc [options] [file...]

Arguments:
  file  Files (or piped input)

Options:
  -l, --lines  Lines only
  -w, --words  Words only
  -c, --bytes  Bytes only
```

## `which`

```text
which — Show what a command is and where it runs
Runs on: Local iPad
Aliases: where, Get-Command, gcm

Usage:
  which <command...>

Arguments:
  command  Command names
```

## `zip`

```text
zip — Create a zip archive
Runs on: Local iPad
Aliases: Compress-Archive

Usage:
  zip [options] [archive-and-paths...]

Arguments:
  archive-and-paths  ARCHIVE.zip PATH...

Options:
  --path <path>                        Path (PowerShell style; same as the positional argument)
  --DestinationPath <DestinationPath>  Archive to create (PowerShell style)
  --Force                              Overwrite the archive

Examples:
  zip site.zip index.html css
  Compress-Archive -Path src -DestinationPath src.zip
```
