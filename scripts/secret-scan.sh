#!/usr/bin/env bash
# Fail closed on staged secrets; skip gracefully when trufflehog is absent
# (CI runs the trufflehog action, so the check is still enforced there).
set -euo pipefail

if ! command -v trufflehog >/dev/null 2>&1; then
  echo "[secret-scan] trufflehog not installed — skipping (brew install trufflehog). CI enforces this check."
  exit 0
fi

# Scan exactly what is staged: materialize staged blobs (added/copied/
# modified; deletions have no content to scan) into a temp dir and scan it.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

if git diff --cached --quiet --diff-filter=ACM; then
  echo "[secret-scan] no staged files to scan."
  exit 0
fi

# NOTE: read -d '' (NUL delimiter) works on bash 3.2 (macOS system bash);
# mapfile is NOT available there, so a while-loop is used instead.
git diff --cached --name-only -z --diff-filter=ACM | while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  mkdir -p "$tmpdir/$(dirname "$f")"
  git show ":$f" > "$tmpdir/$f"
done

# --include-detectors is passed explicitly: the v3 default does not reliably
# enable all detectors on the filesystem source (verified empirically).
# --results verified keeps the gate free of unverified noise;
# --fail exits 183 when verified secrets are found (fails the hook).
trufflehog filesystem "$tmpdir" --include-detectors=all --results verified --fail
