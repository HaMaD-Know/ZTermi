#!/usr/bin/env bash
# terminia-template: detect-project v1
# Validates the project folder and detects what kind of project it is.
#
# Usage: detect-project.sh <ios|android|web|deps>
# Reads PROJECT_PATH. Writes TERMINIA_PROJECT_DIR and TERMINIA_KIND to the job
# environment and has_package_json / node_version / kind as step outputs.
set -euo pipefail
source "$(dirname "$0")/common.sh"

TARGET="${1:?target required}"
PROJECT_PATH="${PROJECT_PATH:-.}"

case "$PROJECT_PATH" in
    /* | *..*) fail "project_path must be a relative path inside the repository (got '$PROJECT_PATH')." ;;
esac
PATH_RE='^[A-Za-z0-9._/ -]+$'
if ! [[ $PROJECT_PATH =~ $PATH_RE ]]; then
    fail "project_path contains unsupported characters."
fi

ROOT="${GITHUB_WORKSPACE:-$PWD}"
DIR="$ROOT/$PROJECT_PATH"
[ -d "$DIR" ] || fail "The project folder '$PROJECT_PATH' does not exist in this commit."
DIR="$(cd "$DIR" && pwd)"

KIND=""
has_capacitor_config() {
    [ -f "$DIR/capacitor.config.ts" ] || [ -f "$DIR/capacitor.config.js" ] || [ -f "$DIR/capacitor.config.json" ]
}
if has_capacitor_config || { [ -f "$DIR/package.json" ] && grep -q '"@capacitor/core"' "$DIR/package.json"; }; then
    KIND=capacitor
fi

XCODE_PROJECT=$(find "$DIR" -maxdepth 3 -name '*.xcodeproj' -not -path '*/node_modules/*' -not -path '*/Pods/*' | head -n 1 || true)
ANDROID_GRADLE=""
for f in settings.gradle settings.gradle.kts build.gradle build.gradle.kts; do
    if [ -f "$DIR/$f" ]; then ANDROID_GRADLE="$DIR"; break; fi
done
if [ -n "$ANDROID_GRADLE" ] && ! grep -rqsE 'com\.android\.application|android\s*\{' "$DIR"/app/build.gradle* "$DIR"/build.gradle* 2>/dev/null; then
    ANDROID_GRADLE=""
fi

if [ -z "$KIND" ]; then
    case "$TARGET" in
        ios) [ -n "$XCODE_PROJECT" ] && KIND=xcode ;;
        android) [ -n "$ANDROID_GRADLE" ] && KIND=android-gradle ;;
        *)
            if [ -f "$DIR/package.json" ]; then KIND=node
            elif [ -f "$DIR/pyproject.toml" ] || [ -f "$DIR/setup.py" ] || [ -f "$DIR/requirements.txt" ]; then KIND=python
            elif [ -n "$ANDROID_GRADLE" ]; then KIND=android-gradle
            elif [ -n "$XCODE_PROJECT" ]; then KIND=xcode
            elif [ -f "$DIR/index.html" ]; then KIND=static
            else KIND=unknown
            fi
            ;;
    esac
fi

case "$TARGET" in
    ios)
        [ -n "$KIND" ] || fail "This is not an iOS-capable project: there is no Capacitor configuration and no Xcode project in '$PROJECT_PATH'."
        ;;
    android)
        [ -n "$KIND" ] || fail "This is not an Android project: there is no Capacitor configuration and no Android Gradle build in '$PROJECT_PATH'."
        ;;
esac

NODE_VERSION=22
if [ -f "$DIR/.nvmrc" ]; then
    CANDIDATE=$(tr -d ' \r\nv' < "$DIR/.nvmrc")
    VERSION_RE='^[0-9]+(\.[0-9]+){0,2}$'
    if [[ $CANDIDATE =~ $VERSION_RE ]]; then NODE_VERSION="$CANDIDATE"; fi
fi

HAS_PACKAGE_JSON=false
[ -f "$DIR/package.json" ] && HAS_PACKAGE_JSON=true

set_env TERMINIA_PROJECT_DIR "$DIR"
set_env TERMINIA_KIND "$KIND"
set_output kind "$KIND"
set_output has_package_json "$HAS_PACKAGE_JSON"
set_output node_version "$NODE_VERSION"

echo "Project folder: $PROJECT_PATH"
echo "Detected kind:  $KIND"
echo "package.json:   $HAS_PACKAGE_JSON"
[ -n "$XCODE_PROJECT" ] && echo "Xcode project:  ${XCODE_PROJECT#$ROOT/}"
echo "Node.js:        $NODE_VERSION"
