#!/usr/bin/env bash
# terminia-template: web-build v1
# Builds a web app, Node.js project, Python package or a custom build profile
# and collects the output in $TERMINIA_OUT/package.
#
# Environment: TERMINIA_PROJECT_DIR, TERMINIA_KIND, BUILD_KIND (web|node|python|custom),
# BUILD_COMMAND, OUTPUT_PATH, ENV_JSON, TERMINIA_OUT, TERMINIA_BUILD_ID.
set -euo pipefail
source "$(dirname "$0")/common.sh"
cd "${TERMINIA_PROJECT_DIR:?}"

BUILD_KIND="${BUILD_KIND:-web}"
OUTPUT_PATH="${OUTPUT_PATH:-}"
case "$OUTPUT_PATH" in /* | *..*) fail "output_path must be a relative path inside the project." ;; esac
PACKAGE="$TERMINIA_OUT/package"
mkdir -p "$PACKAGE"

# Environment variables of a custom build profile (non-secret, validated names, single-line values).
if [ -n "${ENV_JSON:-}" ] && [ "$ENV_JSON" != "{}" ]; then
    while IFS= read -r -d '' pair; do
        name="${pair%%=*}"
        export "$name=${pair#*=}"
        echo "Set $name"
    done < <(python3 - <<'PY'
import json, os, re, sys
try:
    data = json.loads(os.environ["ENV_JSON"])
except ValueError:
    print("::error::env_json is not valid JSON", file=sys.stderr); sys.exit(1)
if not isinstance(data, dict):
    print("::error::env_json must be an object", file=sys.stderr); sys.exit(1)
for k, v in data.items():
    if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,63}", k) or k.startswith(("GITHUB_", "RUNNER_", "ACTIONS_")):
        print(f"::error::environment variable name '{k}' is not allowed", file=sys.stderr); sys.exit(1)
    v = str(v)
    if "\n" in v or "\r" in v:
        print(f"::error::{k} must be a single line", file=sys.stderr); sys.exit(1)
    sys.stdout.write(f"{k}={v}\0")
PY
)
fi

run_command() {
    echo "Build command: $1"
    run_logged build bash -c "$1"
}

case "$BUILD_KIND" in
    web | node)
        if [ -f package.json ]; then
            if [ -n "${BUILD_COMMAND:-}" ]; then
                run_command "$BUILD_COMMAND"
            elif node -e "process.exit(require('./package.json').scripts && require('./package.json').scripts.build ? 0 : 1)"; then
                run_logged build npm run build
            else
                fail "package.json has no build script. Add one, or set a build command in the build profile."
            fi
            OUTPUT_PATH="${OUTPUT_PATH:-dist}"
            [ -d "$OUTPUT_PATH" ] || fail "The build finished but the output folder '$OUTPUT_PATH' does not exist. Set the correct output path."
            cp -R "$OUTPUT_PATH"/. "$PACKAGE"/
        else
            # Static site: package the project files themselves.
            SOURCE="${OUTPUT_PATH:-.}"
            [ -d "$SOURCE" ] || fail "'$SOURCE' does not exist."
            (cd "$SOURCE" && tar --exclude=.git --exclude=.github --exclude=.terminia --exclude=node_modules -cf - .) | (cd "$PACKAGE" && tar -xf -)
        fi
        ;;
    python)
        [ -f pyproject.toml ] || [ -f setup.py ] || fail "No pyproject.toml or setup.py: there is no Python package to build."
        run_logged install-build python -m pip install --upgrade build
        run_logged build python -m build --outdir "$PACKAGE"
        ;;
    custom)
        [ -n "${BUILD_COMMAND:-}" ] || fail "Custom builds need a build command."
        run_command "$BUILD_COMMAND"
        if [ -n "$OUTPUT_PATH" ]; then
            [ -e "$OUTPUT_PATH" ] || fail "The build finished but '$OUTPUT_PATH' does not exist."
            if [ -d "$OUTPUT_PATH" ]; then cp -R "$OUTPUT_PATH"/. "$PACKAGE"/; else cp "$OUTPUT_PATH" "$PACKAGE"/; fi
        fi
        ;;
    *) fail "Unknown build kind '$BUILD_KIND'." ;;
esac

COUNT=$(find "$PACKAGE" -type f | wc -l | tr -d ' ')
[ "$COUNT" -gt 0 ] || fail "The build produced no output files."
SIZE=$(du -sk "$PACKAGE" | cut -f1)
echo "Output: $COUNT file(s), ${SIZE} KB"
publish_result "{\"platform\":\"web\",\"buildId\":\"$(json_escape "${TERMINIA_BUILD_ID:-}")\",\"kind\":\"$BUILD_KIND\",\"files\":$COUNT,\"kilobytes\":$SIZE}"
