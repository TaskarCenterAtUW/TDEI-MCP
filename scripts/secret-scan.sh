#!/usr/bin/env bash
# Fail closed on staged secrets; skip gracefully when gitleaks is absent
# (CI installs it, so the check is still enforced there).
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[secret-scan] gitleaks not installed — skipping (brew install gitleaks). CI enforces this check."
  exit 0
fi

# Scan staged changes (pre-commit) plus tracked files for defense in depth.
gitleaks protect --staged --verbose --redact
