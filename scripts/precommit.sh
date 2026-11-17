#!/usr/bin/env bash
# Mandatory local gate: must pass before every commit.
#
# Runs the same checks CI runs (ci.yml: test + quality jobs) plus the repo's
# extra gates (knip, audit, secret-scan, tool-fields), so a failure that can
# be caught locally never reaches CI. Both the husky pre-commit hook and
# humans/agents run THIS script — single source of truth, no drift.
#
# Usage: bash scripts/precommit.sh   (or: pnpm precommit)
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

# Agent/sandbox shells often have a minimal PATH; make pnpm findable.
for dir in "$HOME/.volta/bin" "/opt/homebrew/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH

command -v pnpm >/dev/null || {
  echo "precommit: pnpm not found on PATH" >&2
  exit 1
}

echo "==> precommit: build"
pnpm build

echo "==> precommit: lint (tsc + oxlint + prettier --check)"
pnpm lint

echo "==> precommit: knip (unused files/exports)"
pnpm knip

echo "==> precommit: tool-fields check"
pnpm check:tool-fields

echo "==> precommit: installer tests"
pnpm test:installers

echo "==> precommit: full test suite with coverage thresholds"
pnpm test:coverage

echo "==> precommit: dependency audit"
pnpm audit

echo "==> precommit: secret scan (staged changes)"
pnpm secret-scan

echo "precommit: ALL CHECKS PASSED"
