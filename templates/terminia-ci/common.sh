#!/usr/bin/env bash
# terminia-template: common v1
# Shared helpers for Terminia's CI scripts. Sourced, not executed.
#
# Every log written here ends up in the "terminia-*-logs" artifact, and
# failures are also published as GitHub annotations, which Terminia reads
# through the API to show the error on the iPad without opening github.com.

TERMINIA_OUT="${TERMINIA_OUT:-$PWD/terminia-out}"
mkdir -p "$TERMINIA_OUT/logs"

fail() {
    echo "::error title=Terminia::$1"
    exit 1
}

warn() {
    echo "::warning title=Terminia::$1"
}

set_output() {
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

set_env() {
    if [ -n "${GITHUB_ENV:-}" ]; then echo "$1=$2" >> "$GITHUB_ENV"; fi
    export "$1=$2"
}

# Escapes a message for a workflow command (::error::...).
annotation_escape() {
    local s="$1"
    s="${s//'%'/'%25'}"
    s="${s//$'\r'/'%0D'}"
    s="${s//$'\n'/'%0A'}"
    printf '%s' "$s"
}

# run_logged <name> <command> [args...]
# Runs a command with its output saved to logs/<name>.log. On failure the
# error lines and the end of the log are published as an annotation.
run_logged() {
    local name="$1"
    shift
    local log="$TERMINIA_OUT/logs/$name.log"
    echo "::group::$name: $*"
    set +e
    "$@" 2>&1 | tee "$log"
    local status=${PIPESTATUS[0]}
    set -e
    echo "::endgroup::"
    if [ "$status" -ne 0 ]; then
        local picked
        picked=$(grep -E '(error|ERROR|Error:|FAILURE|FAILED|fatal|Exception|npm ERR!)' "$log" | grep -v '^\s*$' | tail -n 30 || true)
        local tail_lines
        tail_lines=$(tail -n 40 "$log")
        local body
        body=$(printf '%s\n--- last lines ---\n%s' "$picked" "$tail_lines" | tail -c 3800)
        echo "::error title=$name failed (exit $status)::$(annotation_escape "$body")"
        return "$status"
    fi
    return 0
}

# Publishes the machine-readable build result Terminia shows on the iPad.
publish_result() {
    echo "::notice title=terminia-result::$(annotation_escape "$1")"
    printf '%s\n' "$1" > "$TERMINIA_OUT/logs/terminia-result.json"
}

# Prints the first line of stdin and drains the rest, so the producer never gets
# SIGPIPE (with pipefail, 'cmd | head -n 1' can fail when head exits early).
first_line() {
    local first=''
    IFS= read -r first || true
    cat > /dev/null
    printf '%s\n' "$first"
}

json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    printf '%s' "$s"
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

size_of() {
    wc -c < "$1" | tr -d ' '
}
