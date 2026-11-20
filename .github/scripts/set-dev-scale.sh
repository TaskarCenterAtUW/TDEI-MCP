#!/usr/bin/env bash
# Scale policy for the dev Container App (cost control).
#
# - Min replicas 0: scales to zero when idle; the HTTP rule wakes a replica on
#   the next request.
# - Scale-in waits COOLDOWN seconds after the last request (no on/off flapping).
# - Max stays 1: sessions live in-process, a second replica would split them.
#
# `az containerapp update` image deploys do not carry the scale block, so it is
# applied from YAML here, then read back and verified. Run it after every deploy.
#
# Env: CONTAINER_APP_NAME, RESOURCE_GROUP (required);
#      MIN_REPLICAS (0), MAX_REPLICAS (1), COOLDOWN (3600), HTTP_CONCURRENCY (50)
set -euo pipefail

: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"

export MIN_REPLICAS="${MIN_REPLICAS:-0}"
export MAX_REPLICAS="${MAX_REPLICAS:-1}"
export COOLDOWN="${COOLDOWN:-3600}"
export HTTP_CONCURRENCY="${HTTP_CONCURRENCY:-50}"

TMP_JSON="$(mktemp)"
TMP_YAML="$(mktemp)"
trap 'rm -f "$TMP_JSON" "$TMP_YAML"' EXIT

az containerapp show --name "$CONTAINER_APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --output json >"$TMP_JSON"

python3 - "$TMP_JSON" "$TMP_YAML" <<'PY'
import json
import os
import subprocess
import sys

src, dest = sys.argv[1], sys.argv[2]
try:
    import yaml
except ImportError:
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "pyyaml"],
    )
    import yaml

env = os.environ
with open(src, encoding="utf-8") as handle:
    app = json.load(handle)

rules = [{"name": "http-scaler", "http": {"metadata": {"concurrentRequests": env["HTTP_CONCURRENCY"]}}}]

app["properties"]["template"]["scale"] = {
    "minReplicas": int(env["MIN_REPLICAS"]),
    "maxReplicas": int(env["MAX_REPLICAS"]),
    "cooldownPeriod": int(env["COOLDOWN"]),
    "pollingInterval": 30,
    "rules": rules,
}

for key in ("id", "systemData", "resourceGroup", "kind"):
    app.pop(key, None)
identity = app.get("identity") or {}
identity.pop("principalId", None)
identity.pop("tenantId", None)
if identity:
    app["identity"] = identity

with open(dest, "w", encoding="utf-8") as handle:
    yaml.safe_dump(app, handle, sort_keys=False)
PY

az containerapp update --name "$CONTAINER_APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --yaml "$TMP_YAML" --only-show-errors --output none

SCALE_JSON="$(az containerapp show --name "$CONTAINER_APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.scale" --output json)"

python3 - "$SCALE_JSON" <<'PY'
import json
import os
import sys

scale = json.loads(sys.argv[1])
env = os.environ
names = {rule.get("name") for rule in scale.get("rules") or []}
want = {"http-scaler"}
errors = []
for key, expect in (("minReplicas", "MIN_REPLICAS"), ("maxReplicas", "MAX_REPLICAS"), ("cooldownPeriod", "COOLDOWN")):
    if scale.get(key) != int(env[expect]):
        errors.append(f"{key}={scale.get(key)} (want {env[expect]})")
if names != want:
    errors.append(f"rules={sorted(names)} (want {sorted(want)})")
if errors:
    raise SystemExit("Dev scale policy mismatch: " + ", ".join(errors))
print(f"Dev scale policy applied: min={env['MIN_REPLICAS']} max={env['MAX_REPLICAS']} "
      f"cooldown={env['COOLDOWN']} rules={sorted(names)}")
PY
