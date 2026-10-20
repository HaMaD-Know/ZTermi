#!/usr/bin/env bash
# terminia-template: deps v1
# Runs a dependency operation with the project's real package manager on a
# clean runner, then collects the manifest/lock files that changed and a
# report. Terminia downloads the result and offers to apply the files.
#
# Environment: TERMINIA_PROJECT_DIR, ECOSYSTEM (npm|pnpm|yarn|pip|gradle|cocoapods|swiftpm),
# OPERATION (install|add|remove|update|list), PACKAGES (space-separated), DEV (true|false),
# TERMINIA_OUT, TERMINIA_BUILD_ID.
set -euo pipefail
source "$(dirname "$0")/common.sh"
cd "${TERMINIA_PROJECT_DIR:?}"

ECOSYSTEM="${ECOSYSTEM:?}"
OPERATION="${OPERATION:?}"
DEV="${DEV:-false}"
RESULT="$TERMINIA_OUT/deps-result"
mkdir -p "$RESULT/files"

# Registry package names and version specifiers only: no URLs, git or file paths, no options.
PKGS=()
PACKAGE_RE='^[A-Za-z0-9@][A-Za-z0-9@/._~^<>=!*+,-]*(\[[A-Za-z0-9_,.-]+\])?([<>=!~^][A-Za-z0-9.*+,<>=!~^-]*)?$'
for p in ${PACKAGES:-}; do
    if ! [[ $p =~ $PACKAGE_RE ]]; then
        fail "'$p' is not an allowed package specifier (registry names and versions only)."
    fi
    PKGS+=("$p")
done
case "$OPERATION" in
    add | remove) [ "${#PKGS[@]}" -gt 0 ] || fail "'$OPERATION' needs at least one package." ;;
    install | update | list) ;;
    *) fail "Unknown operation '$OPERATION'." ;;
esac
echo "Ecosystem: $ECOSYSTEM, operation: $OPERATION, packages: ${PKGS[*]:-(none)}"

TRACKED=()
REPORT_CMD=()
case "$ECOSYSTEM" in
    npm)
        TRACKED=(package.json package-lock.json)
        DEV_FLAG=()
        [ "$DEV" = true ] && DEV_FLAG=(--save-dev)
        case "$OPERATION" in
            install) run_logged npm-install npm install --no-audit --no-fund ;;
            add) run_logged npm-add npm install --no-audit --no-fund "${DEV_FLAG[@]}" "${PKGS[@]}" ;;
            remove) run_logged npm-remove npm uninstall --no-audit --no-fund "${PKGS[@]}" ;;
            update) run_logged npm-update npm update --no-audit --no-fund "${PKGS[@]}" ;;
            list) [ -d node_modules ] || run_logged npm-install npm ci --no-audit --no-fund ;;
        esac
        REPORT_CMD=(npm ls --depth=0 --json)
        ;;
    pnpm)
        corepack enable
        TRACKED=(package.json pnpm-lock.yaml)
        DEV_FLAG=()
        [ "$DEV" = true ] && DEV_FLAG=(--save-dev)
        case "$OPERATION" in
            install) run_logged pnpm-install pnpm install ;;
            add) run_logged pnpm-add pnpm add "${DEV_FLAG[@]}" "${PKGS[@]}" ;;
            remove) run_logged pnpm-remove pnpm remove "${PKGS[@]}" ;;
            update) run_logged pnpm-update pnpm update "${PKGS[@]}" ;;
            list) run_logged pnpm-install pnpm install --frozen-lockfile ;;
        esac
        REPORT_CMD=(pnpm list --depth 0 --json)
        ;;
    yarn)
        corepack enable
        TRACKED=(package.json yarn.lock)
        DEV_FLAG=()
        [ "$DEV" = true ] && DEV_FLAG=(--dev)
        case "$OPERATION" in
            install) run_logged yarn-install yarn install ;;
            add) run_logged yarn-add yarn add "${DEV_FLAG[@]}" "${PKGS[@]}" ;;
            remove) run_logged yarn-remove yarn remove "${PKGS[@]}" ;;
            update) if [[ $(yarn --version) == 1.* ]]; then run_logged yarn-update yarn upgrade "${PKGS[@]}"; else run_logged yarn-update yarn up "${PKGS[@]}"; fi ;;
            list) run_logged yarn-install yarn install ;;
        esac
        REPORT_CMD=(yarn info --json)
        ;;
    pip)
        TRACKED=(requirements.txt requirements.lock.txt)
        python3 -m venv "${RUNNER_TEMP:-/tmp}/terminia-venv"
        # shellcheck disable=SC1091
        source "${RUNNER_TEMP:-/tmp}/terminia-venv/bin/activate"
        run_logged pip-upgrade python -m pip install --upgrade pip
        install_project() {
            if [ -f requirements.txt ]; then run_logged pip-install python -m pip install -r requirements.txt
            elif [ -f pyproject.toml ] || [ -f setup.py ]; then run_logged pip-install python -m pip install .
            else fail "No requirements.txt or pyproject.toml."
            fi
        }
        edit_requirements() {
            python3 - "$1" "${PKGS[@]}" <<'PY'
import re, sys
mode, specs = sys.argv[1], sys.argv[2:]
name_of = lambda s: re.split(r"[\[<>=!~ ;]", s.strip(), 1)[0].lower().replace("_", "-").replace(".", "-")
try:
    lines = open("requirements.txt", encoding="utf-8").read().splitlines()
except FileNotFoundError:
    lines = []
targets = {name_of(s) for s in specs}
kept = [l for l in lines if not l.strip() or l.lstrip().startswith(("#", "-")) or name_of(l) not in targets]
if mode == "add":
    kept += specs
open("requirements.txt", "w", encoding="utf-8").write("\n".join(kept) + "\n")
PY
        }
        case "$OPERATION" in
            install | list) install_project ;;
            add) run_logged pip-add python -m pip install "${PKGS[@]}"; edit_requirements add ;;
            remove) run_logged pip-remove python -m pip uninstall -y "${PKGS[@]}"; edit_requirements remove ;;
            update)
                if [ "${#PKGS[@]}" -gt 0 ]; then run_logged pip-update python -m pip install --upgrade "${PKGS[@]}"
                else install_project; run_logged pip-update python -m pip install --upgrade -r requirements.txt
                fi
                ;;
        esac
        python -m pip freeze --exclude-editable > requirements.lock.txt
        REPORT_CMD=(python -m pip list --format=json)
        ;;
    gradle)
        GRADLE_DIR=.
        [ -d android ] && GRADLE_DIR=android
        cd "$GRADLE_DIR"
        TRACKED=(gradle/libs.versions.toml)
        case "$OPERATION" in
            install | list) ;;
            *) fail "Gradle dependencies are declared in build.gradle; edit the file in Terminia's editor. 'install' and 'list' resolve and report them." ;;
        esac
        [ -f gradlew ] && chmod +x gradlew
        JAVA_VAR="JAVA_HOME_21_X64"
        [ -n "${!JAVA_VAR:-}" ] && export JAVA_HOME="${!JAVA_VAR}"
        run_logged gradle-dependencies ./gradlew --no-daemon --console=plain :app:dependencies --configuration releaseRuntimeClasspath
        cp "$TERMINIA_OUT/logs/gradle-dependencies.log" "$RESULT/report-installed.txt"
        ;;
    cocoapods)
        POD_DIR=ios/App
        [ -f "$POD_DIR/Podfile" ] || POD_DIR=ios
        [ -f "$POD_DIR/Podfile" ] || POD_DIR=.
        [ -f "$POD_DIR/Podfile" ] || fail "No Podfile in the project."
        cd "$POD_DIR"
        TRACKED=(Podfile.lock)
        case "$OPERATION" in
            install | list) run_logged pod-install pod install --repo-update ;;
            update) run_logged pod-update pod update "${PKGS[@]}" ;;
            *) fail "CocoaPods dependencies are declared in the Podfile; edit it in Terminia's editor, then run install." ;;
        esac
        cp Podfile.lock "$RESULT/report-installed.txt"
        ;;
    swiftpm)
        case "$OPERATION" in
            install | list | update) ;;
            *) fail "Swift packages are declared in Package.swift or the Xcode project; edit them, then run install." ;;
        esac
        if [ -f Package.swift ]; then
            TRACKED=(Package.resolved)
            if [ "$OPERATION" = update ]; then run_logged swift-update swift package update; else run_logged swift-resolve swift package resolve; fi
            [ -f Package.resolved ] && cp Package.resolved "$RESULT/report-installed.txt"
        else
            PROJ=$(find . -maxdepth 3 -name '*.xcodeproj' -not -path '*/Pods/*' | first_line)
            [ -n "$PROJ" ] || fail "No Package.swift or Xcode project found."
            run_logged xcode-resolve xcodebuild -resolvePackageDependencies -project "$PROJ"
            RESOLVED="$PROJ/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
            TRACKED=("${RESOLVED#./}")
            [ -f "$RESOLVED" ] && cp "$RESOLVED" "$RESULT/report-installed.txt"
        fi
        ;;
    *) fail "Unknown ecosystem '$ECOSYSTEM'." ;;
esac

if [ "${#REPORT_CMD[@]}" -gt 0 ]; then
    "${REPORT_CMD[@]}" > "$RESULT/report-installed.json" 2>/dev/null || true
fi

# Copy manifest and lock files that changed (or were created) during the operation.
CHANGED=()
PREFIX="$(git rev-parse --show-prefix 2>/dev/null || true)"
for f in "${TRACKED[@]}"; do
    [ -f "$f" ] || continue
    if [ -n "$(git status --porcelain -- "$f" 2>/dev/null)" ]; then
        mkdir -p "$RESULT/files/$(dirname "$PREFIX$f")"
        cp "$f" "$RESULT/files/$PREFIX$f"
        CHANGED+=("$PREFIX$f")
    fi
done
CHANGED_JSON=""
for f in "${CHANGED[@]:-}"; do
    [ -n "$f" ] || continue
    [ -n "$CHANGED_JSON" ] && CHANGED_JSON="$CHANGED_JSON,"
    CHANGED_JSON="$CHANGED_JSON\"$(json_escape "$f")\""
done
PKG_JSON=""
for p in "${PKGS[@]:-}"; do
    [ -n "$p" ] || continue
    [ -n "$PKG_JSON" ] && PKG_JSON="$PKG_JSON,"
    PKG_JSON="$PKG_JSON\"$(json_escape "$p")\""
done
REPORT="{\"buildId\":\"$(json_escape "${TERMINIA_BUILD_ID:-}")\",\"ecosystem\":\"$ECOSYSTEM\",\"operation\":\"$OPERATION\",\"packages\":[$PKG_JSON],\"changed\":[$CHANGED_JSON],\"projectPrefix\":\"$(json_escape "$PREFIX")\"}"
printf '%s\n' "$REPORT" > "$RESULT/report.json"
echo "Changed files: ${CHANGED[*]:-none}"
publish_result "$REPORT"
