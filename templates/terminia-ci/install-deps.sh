#!/usr/bin/env bash
# terminia-template: install-deps v1
# Installs JavaScript dependencies with the project's own package manager,
# using the lockfile when there is one.
set -euo pipefail
source "$(dirname "$0")/common.sh"
cd "${TERMINIA_PROJECT_DIR:?}"

if [ -f pnpm-lock.yaml ]; then
    corepack enable
    run_logged install-dependencies pnpm install --frozen-lockfile
elif [ -f yarn.lock ]; then
    corepack enable
    if grep -q '^__metadata:' yarn.lock; then
        run_logged install-dependencies yarn install --immutable
    else
        run_logged install-dependencies yarn install --frozen-lockfile
    fi
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    run_logged install-dependencies npm ci --no-audit --no-fund
else
    warn "No lockfile in the project: running 'npm install', so dependency versions are not pinned. Run 'terminia deps install' to create package-lock.json."
    run_logged install-dependencies npm install --no-audit --no-fund
fi
