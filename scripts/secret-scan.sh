#!/usr/bin/env bash
# Fail closed on staged secrets. Scans with gitleaks when it is installed (the
# common local setup), otherwise with trufflehog, and skips gracefully when
# neither is present — CI runs its own full-history scan, so the check is still
# enforced there.
set -euo pipefail

if command -v gitleaks >/dev/null 2>&1; then
  scanner="gitleaks"
elif command -v trufflehog >/dev/null 2>&1; then
  scanner="trufflehog"
else
  echo "[secret-scan] neither gitleaks nor trufflehog is installed — skipping (brew install gitleaks). CI enforces this check."
  exit 0
fi

if git diff --cached --quiet --diff-filter=ACM; then
  echo "[secret-scan] no staged files to scan."
  exit 0
fi

# Scan exactly what is staged: materialize staged blobs (added/copied/
# modified; deletions have no content to scan) into a temp dir and scan it.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# NOTE: read -d '' (NUL delimiter) works on bash 3.2 (macOS system bash);
# mapfile is NOT available there, so a while-loop is used instead.
git diff --cached --name-only -z --diff-filter=ACM | while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  mkdir -p "$tmpdir/$(dirname "$f")"
  git show ":$f" > "$tmpdir/$f"
done

if [ "$scanner" = "gitleaks" ]; then
  # --redact keeps the matched value out of the log; --verbose still names the
  # file, line and rule so the finding can be fixed. Run inside the staged copy
  # so paths are repo-relative. gitleaks exits 1 on any leak, which fails the
  # hook.
  ( cd "$tmpdir" && gitleaks dir . --redact --no-banner --verbose )
  echo "[secret-scan] gitleaks found no leaks in staged files."
else
  # --include-detectors is passed explicitly: the v3 default does not reliably
  # enable all detectors on the filesystem source (verified empirically).
  # --results verified keeps the gate free of unverified noise;
  # --fail exits 183 when verified secrets are found (fails the hook).
  trufflehog filesystem "$tmpdir" --include-detectors=all --results verified --fail
fi
