#!/usr/bin/env bash
# Cost report for the TDEI-MCP dev Container App: actual spend for the previous
# 15 days and a forecast for the next 15 days.
#
# Usage (no arguments needed; defaults come from .github/workflows/dev-deplyment.yml):
#   az login
#   scripts/azure-cost-report.sh [--app-only]
#
# Prefilled from the deployment workflow:
#   Resource group  GaussianRG
#   Container app   CONTAINER_APP_NAME is a GitHub secret, so it is auto-detected:
#                   the only Container App in GaussianRG, or set CONTAINER_APP_NAME
#                   (env var) if the group has more than one.
#   Related costs   the Log Analytics workspace(s) and container registry in the
#                   same group are included by default (log ingestion is often the
#                   biggest cost of a small app). --app-only counts the app alone.
#
# Env overrides: CONTAINER_APP_NAME, RESOURCE_GROUP, SUBSCRIPTION_ID,
#                DAYS_BACK (15), DAYS_AHEAD (15).
# Needs: az CLI, jq, Cost Management Reader on the subscription or group.
#
# Notes:
#   - Cost data lags 8-24h, so the last day or two may be partial.
#   - The forecast uses the Cost Management forecast API. If Azure refuses to
#     forecast for a single resource (it needs enough history), the script
#     falls back to a run-rate: average of the last 7 days x DAYS_AHEAD.
set -euo pipefail

RG="${RESOURCE_GROUP:-GaussianRG}"
APP="${CONTAINER_APP_NAME:-}"
INCLUDE_RELATED=1
for arg in "$@"; do
  case "$arg" in
    --app-only) INCLUDE_RELATED=0 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 1 ;;
  esac
done

DAYS_BACK="${DAYS_BACK:-15}"
DAYS_AHEAD="${DAYS_AHEAD:-15}"
API="2023-11-01"

command -v az >/dev/null || { echo "az CLI not found" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

SUB="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
SCOPE="/subscriptions/${SUB}"

# Portable date math (GNU date on Linux, BSD date on macOS).
day() { # day <offset-days>  -> YYYY-MM-DD (UTC)
  if date -u -d "$1 days" +%F >/dev/null 2>&1; then
    date -u -d "$1 days" +%F
  else
    date -u -v"$( [[ $1 -ge 0 ]] && echo "+$1" || echo "$1" )d" +%F
  fi
}
FROM_PAST="$(day -"$DAYS_BACK")"
TODAY="$(day 0)"
TO_FUTURE="$(day "$DAYS_AHEAD")"
TOMORROW="$(day 1)"

# Resource ids to include (Cost Management ResourceId values are lowercase).
if [[ -z "$APP" ]]; then
  APP_LIST="$(az containerapp list -g "$RG" --query "[].name" -o tsv)"
  APP_COUNT="$(printf '%s' "$APP_LIST" | grep -c . || true)"
  if [[ "$APP_COUNT" -ne 1 ]]; then
    echo "Found $APP_COUNT Container Apps in $RG ($(echo "$APP_LIST" | paste -sd ',' -)); set CONTAINER_APP_NAME to pick one." >&2
    exit 1
  fi
  APP="$APP_LIST"
fi
APP_ID="$(az containerapp show -n "$APP" -g "$RG" --query id -o tsv | tr '[:upper:]' '[:lower:]')"
IDS=("$APP_ID")
if [[ "$INCLUDE_RELATED" == 1 ]]; then
  while IFS= read -r id; do
    [[ -n "$id" ]] && IDS+=("$(tr '[:upper:]' '[:lower:]' <<<"$id")")
  done < <(
    az resource list -g "$RG" \
      --query "[?type=='Microsoft.OperationalInsights/workspaces' || type=='Microsoft.ContainerRegistry/registries'].id" \
      -o tsv
  )
fi
IDS_JSON="$(printf '%s\n' "${IDS[@]}" | jq -R . | jq -s .)"

echo "Scope : $APP  (rg: $RG, subscription: $SUB)"
echo "Counts: $(printf '%s\n' "${IDS[@]}" | sed 's|.*/providers/||' | paste -sd ',' - | sed 's/,/, /g')"
echo

body() { # body <type> <from> <to> [extra-json]
  local extra="${4:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -n --arg type "$1" --arg from "${2}T00:00:00Z" --arg to "${3}T23:59:59Z" \
    --argjson ids "$IDS_JSON" --argjson extra "$extra" '
    {
      type: $type, timeframe: "Custom",
      timePeriod: {from: $from, to: $to},
      dataset: {
        granularity: "Daily",
        aggregation: {totalCost: {name: "Cost", function: "Sum"}},
        filter: {dimensions: {name: "ResourceId", operator: "In", values: $ids}}
      }
    } + $extra'
}

# rows -> "YYYY-MM-DD<TAB>cost<TAB>currency", sorted by date
rows() {
  jq -r '
    (.properties.columns | map(.name)) as $c
    | ($c | index("Cost") // index("PreTaxCost")) as $ci
    | ($c | index("UsageDate")) as $di
    | ($c | index("Currency")) as $ri
    | .properties.rows[]
    | [ (.[ $di ] | tostring | "\(.[0:4])-\(.[4:6])-\(.[6:8])"),
        (.[ $ci ] | tostring),
        (if $ri then .[ $ri ] else "" end) ]
    | @tsv' | sort
}

# --- Actual: previous N days -------------------------------------------------
ACTUAL_JSON="$(az rest --method post \
  --url "https://management.azure.com${SCOPE}/providers/Microsoft.CostManagement/query?api-version=${API}" \
  --body "$(body ActualCost "$FROM_PAST" "$TODAY")" -o json)"
ACTUAL_ROWS="$(rows <<<"$ACTUAL_JSON")"

echo "== Actual cost: $FROM_PAST .. $TODAY =="
if [[ -z "$ACTUAL_ROWS" ]]; then
  echo "(no cost rows returned yet — data lags 8-24h, or the app has no billed usage)"
  ACTUAL_TOTAL=0; CUR=""
else
  awk -F'\t' '{printf "%s  %10.4f %s\n",$1,$2,$3}' <<<"$ACTUAL_ROWS"
  CUR="$(awk -F'\t' 'NR==1{print $3}' <<<"$ACTUAL_ROWS")"
  ACTUAL_TOTAL="$(awk -F'\t' '{s+=$2} END{printf "%.4f", s}' <<<"$ACTUAL_ROWS")"
fi
echo "TOTAL (last $DAYS_BACK days): $ACTUAL_TOTAL $CUR"
echo

# --- Forecast: next N days ---------------------------------------------------
echo "== Forecast: $TOMORROW .. $TO_FUTURE =="
FORECAST_JSON="$(az rest --method post \
  --url "https://management.azure.com${SCOPE}/providers/Microsoft.CostManagement/forecast?api-version=${API}" \
  --body "$(body ActualCost "$TOMORROW" "$TO_FUTURE" '{"includeActualCost":false,"includeFreshPartialCost":false}')" \
  -o json 2>/dev/null || true)"

FORECAST_ROWS=""
if [[ -n "$FORECAST_JSON" ]]; then
  FORECAST_ROWS="$(rows <<<"$FORECAST_JSON" 2>/dev/null || true)"
fi

if [[ -n "$FORECAST_ROWS" ]]; then
  awk -F'\t' '{printf "%s  %10.4f %s\n",$1,$2,$3}' <<<"$FORECAST_ROWS"
  FC_TOTAL="$(awk -F'\t' '{s+=$2} END{printf "%.4f", s}' <<<"$FORECAST_ROWS")"
  echo "TOTAL (next $DAYS_AHEAD days, Azure forecast): $FC_TOTAL ${CUR}"
else
  echo "Azure returned no forecast for this resource; using run-rate instead."
  # Average of the most recent 7 complete-ish days, excluding today (partial).
  AVG="$(awk -F'\t' -v today="$TODAY" '$1!=today{d[n++]=$2} END{
    start=(n>7)?n-7:0; c=0; s=0; for(i=start;i<n;i++){s+=d[i]; c++}
    if(c>0) printf "%.6f", s/c; else printf "0"}' <<<"$ACTUAL_ROWS")"
  FC_TOTAL="$(awk -v a="$AVG" -v n="$DAYS_AHEAD" 'BEGIN{printf "%.4f", a*n}')"
  echo "Run-rate: ${AVG} ${CUR}/day (avg of last 7 full days) x $DAYS_AHEAD days"
  echo "TOTAL (next $DAYS_AHEAD days, run-rate estimate): $FC_TOTAL ${CUR}"
fi
echo
echo "Summary: last ${DAYS_BACK}d = ${ACTUAL_TOTAL} ${CUR} | next ${DAYS_AHEAD}d ~ ${FC_TOTAL} ${CUR}"

# --- Cost by component --------------------------------------------------------
# One row per billed resource over the last N days, labelled by kind.
echo
echo "== Cost by component (last ${DAYS_BACK}d) =="
BYRES="$(az rest --method post \
  --url "https://management.azure.com${SCOPE}/providers/Microsoft.CostManagement/query?api-version=${API}" \
  --body "$(body ActualCost "$FROM_PAST" "$TODAY" \
    "{\"dataset\":{\"granularity\":\"None\",\"aggregation\":{\"totalCost\":{\"name\":\"Cost\",\"function\":\"Sum\"}},\"grouping\":[{\"type\":\"Dimension\",\"name\":\"ResourceId\"}],\"filter\":{\"dimensions\":{\"name\":\"ResourceId\",\"operator\":\"In\",\"values\":${IDS_JSON}}}}}")" \
  -o json 2>/dev/null || true)"

cost_of() { # cost_of <lowercase-resource-id-suffix-regex> -> summed cost (0 if none)
  [[ -n "$BYRES" ]] || { echo 0; return; }
  jq -r --arg re "$1" '
    (.properties.columns | map(.name)) as $c
    | ($c | index("Cost") // index("PreTaxCost")) as $ci
    | ($c | index("ResourceId")) as $ri
    | [.properties.rows[] | select((.[ $ri ] | ascii_downcase) | test($re)) | .[ $ci ]] | add // 0' <<<"$BYRES"
}
APP_COST="$(cost_of "/containerapps/")"
ACR_COST="$(cost_of "/registries/")"
LAW_COST="$(cost_of "/workspaces/")"
printf '%-34s %10.2f %s\n' "Container App ($APP)"        "$APP_COST" "$CUR"
printf '%-34s %10.2f %s\n' "Container Registry (ACR)"    "$ACR_COST" "$CUR"
printf '%-34s %10.2f %s\n' "Log Analytics workspace (all)" "$LAW_COST" "$CUR"
echo
if [[ -n "$BYRES" ]]; then
  jq -r '
    (.properties.columns | map(.name)) as $c
    | ($c | index("Cost") // index("PreTaxCost")) as $ci | ($c | index("ResourceId")) as $ri
    | .properties.rows | sort_by(-.[ $ci ])[] | "\(.[ $ci ])\t\(.[ $ri ])"' <<<"$BYRES" |
    awk -F'\t' '{n=split($2,a,"/providers/"); printf "  %10.4f  %s\n",$1,a[n]}'
fi
echo
echo "(Container App cost is only this app. ACR and the workspace are billed per"
echo " resource; if other apps share them, the attribution below splits them.)"

# --- Meters of the container app itself ---------------------------------------
echo
echo "== Container App meters (last ${DAYS_BACK}d) =="
az rest --method post \
  --url "https://management.azure.com${SCOPE}/providers/Microsoft.CostManagement/query?api-version=${API}" \
  --body "$(body ActualCost "$FROM_PAST" "$TODAY" \
    "{\"dataset\":{\"granularity\":\"None\",\"aggregation\":{\"totalCost\":{\"name\":\"Cost\",\"function\":\"Sum\"}},\"grouping\":[{\"type\":\"Dimension\",\"name\":\"Meter\"}],\"filter\":{\"dimensions\":{\"name\":\"ResourceId\",\"operator\":\"In\",\"values\":[\"${APP_ID}\"]}}}}")" \
  -o json 2>/dev/null | jq -r '
    (.properties.columns | map(.name)) as $c
    | ($c | index("Cost") // index("PreTaxCost")) as $ci | ($c | index("Meter")) as $mi
    | .properties.rows | sort_by(-.[ $ci ])[] | "\(.[ $ci ])\t\(.[ $mi ])"' 2>/dev/null |
  awk -F'\t' '{printf "  %10.4f  %s\n",$1,$2}' || echo "  (query failed)"

# --- Who shares the registry and the workspace? -------------------------------
echo
echo "== Sharing =="
echo "Container Apps in $RG: $(az containerapp list -g "$RG" --query "[].name" -o tsv | paste -sd ',' - | sed 's/,/, /g')"
ACR_NAME="$(az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
if [[ -n "$ACR_NAME" ]]; then
  echo "ACR $ACR_NAME: sku $(az acr show -n "$ACR_NAME" --query sku.name -o tsv), repositories: $(az acr repository list -n "$ACR_NAME" -o tsv 2>/dev/null | paste -sd ',' - | sed 's/,/, /g')"
fi

# --- Log ingestion attributed to this app -------------------------------------
echo
echo "== Log ingestion (last ${DAYS_BACK}d) =="
ENV_ID="$(az containerapp show -n "$APP" -g "$RG" --query properties.environmentId -o tsv)"
WS_CID="$(az containerapp env show --ids "$ENV_ID" --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId -o tsv 2>/dev/null || true)"
if [[ -z "$WS_CID" ]]; then
  echo "Environment has no Log Analytics destination (logs are not billed for ingestion)."
else
  la() { az monitor log-analytics query -w "$WS_CID" --analytics-query "$1" -o json --only-show-errors 2>/dev/null || true; }
  TOTAL_B="$(la "union withsource=T * | where TimeGenerated > ago(${DAYS_BACK}d) | summarize b=sum(_BilledSize)" | jq -r '.[0].b // 0')"
  APP_B="$(la "union withsource=T ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL | where TimeGenerated > ago(${DAYS_BACK}d) | where ContainerAppName_s == '${APP}' | summarize b=sum(_BilledSize)" | jq -r '.[0].b // 0')"
  echo "Workspace customerId: $WS_CID"
  awk -v t="${TOTAL_B:-0}" -v a="${APP_B:-0}" -v w="${LAW_COST:-0}" -v cur="$CUR" 'BEGIN{
    printf "Workspace ingested : %9.3f GB\n", t/1e9
    printf "This app ingested  : %9.3f GB", a/1e9
    if (t>0) printf "  (%.1f%% of workspace)", 100*a/t
    printf "\n"
    if (t>0) printf "Est. log cost for this app: %.2f %s of the workspace'"'"'s %.2f %s\n", w*a/t, cur, w, cur
  }'
  echo "By table (this workspace, GB):"
  la "union withsource=T * | where TimeGenerated > ago(${DAYS_BACK}d) | summarize gb=sum(_BilledSize)/1e9 by T | order by gb desc | take 8" |
    jq -r '.[] | "  \(.gb * 1000 | round / 1000)\t\(.T)"' | awk -F'\t' '{printf "  %9.3f  %s\n",$1,$2}'
  echo "Daily GB from this app:"
  la "union withsource=T ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL | where TimeGenerated > ago(${DAYS_BACK}d) | where ContainerAppName_s == '${APP}' | summarize gb=sum(_BilledSize)/1e9 by bin(TimeGenerated,1d) | order by TimeGenerated asc" |
    jq -r '.[] | "\(.TimeGenerated[0:10])\t\(.gb)"' | awk -F'\t' '{printf "  %s  %9.4f\n",$1,$2}'
fi
