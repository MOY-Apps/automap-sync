#!/usr/bin/env bash
# automap-sync (bash) - push this site's automation rules to Automation Map.
#
# Reads every automation rule with YOUR Atlassian API token (it never leaves this
# machine), and pushes them to the Automation Map push receiver with the key the app
# issued. Needs bash 3.2+, curl, jq 1.6+, and sha256sum or shasum. Contract:
# docs/push-sync.md. Same environment, flags and exit codes as the Python sender:
#
#   ATLASSIAN_SITE | ATLASSIAN_CLOUD_ID, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN,
#   AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE,
#   AUTOMAP_USAGE=off, AUTOMAP_RUNS=off, AUTOMAP_RUNS_DAYS (7)
#
# Usage and runs (BETA, from 1.1.0), as in the Python sender: after the rules, this month's
# steps, Rovo credits and flow runs per rule, and the audit log of the last AUTOMAP_RUNS_DAYS
# days folded into per-rule, per-day counts, are read from the internal API behind Jira's
# Usage and Audit log tabs and pushed as two separate pushes. That API is undocumented and
# can change: a failure there is logged and never fails the run. No account ids, no issue
# ids and no message text leave this machine.
#
#   ./automap-sync.sh [--dry-run]
#
# Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
# receiver, 5 try later, 6 failed.
#
# Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
set -u

NAME=bash
VERSION=1.2.0
UA="automap-sync-$NAME/$VERSION"

log() { printf 'automap-sync %s %s: %s\n' "$NAME" "$VERSION" "$*" >&2; }
die() { log "$2"; exit "$1"; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die 2 "$tool is required"
done
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
need() { eval "v=\${$1:-}"; [ -n "$v" ] || die 2 "$1 is not set"; }

DRY_RUN="${AUTOMAP_DRY_RUN:-}"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

need ATLASSIAN_EMAIL
need ATLASSIAN_API_TOKEN
API_BASE="${ATLASSIAN_API_BASE:-https://api.atlassian.com}"
API_BASE="${API_BASE%/}"
CHUNK="${AUTOMAP_CHUNK_BYTES:-200000}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/automap-sync.XXXXXX")" || die 2 "no temporary directory"
trap 'rm -rf "$TMP"' EXIT
# the token goes to curl through a file, not the command line, so ps cannot show it
umask 077
printf 'user = "%s:%s"\n' "$ATLASSIAN_EMAIL" "$ATLASSIAN_API_TOKEN" > "$TMP/atlassian.cfg"

if [ -n "${ATLASSIAN_CLOUD_ID:-}" ]; then
  CLOUD="$ATLASSIAN_CLOUD_ID"
else
  need ATLASSIAN_SITE
  case "$ATLASSIAN_SITE" in *://*) SITE="$ATLASSIAN_SITE" ;; *) SITE="https://$ATLASSIAN_SITE" ;; esac
  CLOUD="$(curl -sS -A "$UA" "${SITE%/}/_edge/tenant_info" | jq -r '.cloudId // empty')"
  [ -n "$CLOUD" ] || die 3 "could not read the cloud id of $SITE"
fi
BASE="$API_BASE/automation/public/jira/$CLOUD/rest/v1"

# api_get <path> <outfile> - GET with retries on 429, 5xx and no answer
api_get() {
  local path="$1" out="$2" wait=1 attempt=1 code after
  while :; do
    code="$(curl -sS -A "$UA" -K "$TMP/atlassian.cfg" -H 'Accept: application/json' \
      -D "$TMP/h" -o "$out" -w '%{http_code}' "$BASE$path" 2>/dev/null)" || code=000
    case "$code" in
      200) return 0 ;;
      401) die 3 "the Automation API rejected the token (401): it must be an API token with the Automation scope, for this e-mail" ;;
      403) die 3 "the Automation API refused access (403): the account must be a Jira administrator" ;;
    esac
    if [ "$attempt" -lt 5 ] && { [ "$code" = 000 ] || [ "$code" = 429 ] || [ "$code" -ge 500 ]; }; then
      after="$(tr -d '\r' < "$TMP/h" 2>/dev/null | awk -F': *' 'tolower($1)=="retry-after"{print $2}' | head -1)"
      case "$after" in ''|*[!0-9]*) sleep "$wait" ;; *) sleep "$after" ;; esac
      wait=$(( wait * 2 > 15 ? 15 : wait * 2 ))
      attempt=$(( attempt + 1 ))
      continue
    fi
    die 3 "the Automation API answered $code for ${path%%\?*}"
  done
}

: > "$TMP/ids"
cursor=""
pages=0
while :; do
  q="limit=100"
  [ -n "$cursor" ] && q="$q&cursor=$cursor"
  api_get "/rule/summary?$q" "$TMP/page.json"
  pages=$(( pages + 1 ))
  jq -r '.data[]? | (.id // .uuid) // empty' "$TMP/page.json" >> "$TMP/ids"
  next="$(jq -r '.links.next // empty' "$TMP/page.json")"
  cursor="$(printf '%s' "$next" | sed -n 's/.*[?&]cursor=\([^&]*\).*/\1/p')"
  [ -n "$cursor" ] || break
done
awk '!seen[$0]++' "$TMP/ids" > "$TMP/ids.unique"
log "$(wc -l < "$TMP/ids.unique" | tr -d ' ') rules listed in $pages page(s)"

: > "$TMP/rules.ndjson"
while IFS= read -r id; do
  enc="$(jq -rn --arg v "$id" '$v|@uri')"
  api_get "/rule/$enc" "$TMP/detail.json"
  jq -c '{rule: (.rule // .)}' "$TMP/detail.json" >> "$TMP/rules.ndjson"
done < "$TMP/ids.unique"

# one compact, ASCII-only document with no trailing newline: -a escapes everything else
# as \uXXXX, so cutting by bytes never splits a character, and -j adds no newline the
# platform would strip
jq -s -a -c -j --arg n "$NAME" --arg v "$VERSION" \
  '{rules: ., sender: {name: $n, version: $v, rules: length}}' "$TMP/rules.ndjson" > "$TMP/payload" \
  || die 6 "could not assemble the payload"
SUM="$($SHA "$TMP/payload" | cut -d' ' -f1)"
BYTES="$(wc -c < "$TMP/payload" | tr -d ' ')"
mkdir "$TMP/chunks"
(cd "$TMP/chunks" && split -b "$CHUNK" -a 4 "$TMP/payload" part.)
COUNT="$(ls "$TMP/chunks" | wc -l | tr -d ' ')"

word() { jq -r '.error // empty' "$TMP/resp" 2>/dev/null; }

# push_rules - the rules in chunks; sets RULES_CODE and RULES_SAY rather than exiting, so
# the usage and the runs can still go after a refusal
push_rules() {
  RULES_CODE=0; RULES_SAY=""
  if [ -n "$DRY_RUN" ]; then
    log "dry run: $BYTES bytes in $COUNT chunk(s), sha256 $SUM; nothing pushed"
    return
  fi
  need AUTOMAP_URL
  need AUTOMAP_KEY
  printf 'header = "Authorization: Bearer %s"\n' "$AUTOMAP_KEY" > "$TMP/automap.cfg"
  local attempt run seq restart part tries code
  for attempt in 1 2; do
    run="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    seq=0
    restart=""
    for part in $(ls "$TMP/chunks"); do
      set -- -H "X-Automap-Run: $run" -H "X-Automap-Seq: $seq" -H "X-Automap-Sender: $NAME/$VERSION"
      if [ "$seq" -eq $(( COUNT - 1 )) ]; then
        set -- "$@" -H "X-Automap-Last: 1" -H "X-Automap-Sha256: $SUM"
      fi
      tries=1
      while :; do
        code="$(curl -sS -A "$UA" -K "$TMP/automap.cfg" -X POST -H 'Content-Type: text/plain; charset=utf-8' \
          "$@" --data-binary "@$TMP/chunks/$part" -o "$TMP/resp" -w '%{http_code}' "$AUTOMAP_URL" 2>/dev/null)" || code=000
        case "$code" in 202|400|401|402|403|404|405|409|413|422|426|429) break ;; esac
        [ "$tries" -ge 3 ] && break
        sleep $(( 1 << tries ))
        tries=$(( tries + 1 ))
      done
      case "$code" in
        202) seq=$(( seq + 1 )); continue ;;
        409|422)
          if [ "$attempt" -eq 1 ]; then log "receiver answered $code $(word); starting the push again"; restart=1; break; fi
          RULES_CODE=6; RULES_SAY="receiver answered $code $(word)"; return ;;
        429) RULES_CODE=5; RULES_SAY="receiver answered 429 $(word): try again later"; return ;;
        400|401|402|403|404|405|413|426) RULES_CODE=4; RULES_SAY="receiver refused the push: $code $(word)"; return ;;
        *) RULES_CODE=6; RULES_SAY="receiver answered $code $(word)"; return ;;
      esac
    done
    if [ -z "$restart" ]; then
      log "pushed $BYTES bytes in $COUNT chunk(s); the map is rebuilding"
      return
    fi
  done
  RULES_CODE=6; RULES_SAY="the push did not go through twice"
}

off() { eval "v=\${$1:-}"; case "$(printf '%s' "$v" | tr 'A-Z' 'a-z')" in off|0|false|no) return 0 ;; esac; return 1; }
INTERNAL="$API_BASE/automation/internal-api/jira/$CLOUD/pro/rest/GLOBAL/"

# internal_get <path> <outfile> [tries] [json body] - the internal API behind Jira's Usage
# and Audit log tabs (BETA, undocumented); 0 on 200, else 1 with ERR set
internal_get() {
  local path="$1" out="$2" tries="${3:-1}" body="${4:-}" attempt=1 code
  while :; do
    if [ -n "$body" ]; then
      code="$(printf '%s' "$body" | curl -sS -A "$UA" -K "$TMP/atlassian.cfg" -H 'Accept: application/json' \
        -H 'Content-Type: application/json' -X POST --data-binary @- -o "$out" -w '%{http_code}' "$INTERNAL$path" 2>/dev/null)" || code=000
    else
      code="$(curl -sS -A "$UA" -K "$TMP/atlassian.cfg" -H 'Accept: application/json' \
        -o "$out" -w '%{http_code}' "$INTERNAL$path" 2>/dev/null)" || code=000
    fi
    [ "$code" = 200 ] && return 0
    if [ "$code" != 000 ] && [ "$code" != 429 ] && [ "$code" -lt 500 ]; then break; fi
    [ "$attempt" -ge "$tries" ] && break
    sleep $(( 2 * attempt ))
    attempt=$(( attempt + 1 ))
  done
  ERR="${path%%\?*} answered $code"
  return 1
}

# send_kind <kind> <file> - usage or runs (beta) in chunks like the rules, kept whole by the
# receiver on the last one (APPS-499); the last answer's code in KIND_CODE
send_kind() {
  local kind="$1" file="$2" sum run dir part seq count tries
  sum="$($SHA "$file" | cut -d' ' -f1)"
  run="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  dir="$TMP/kind-$kind"
  rm -rf "$dir"; mkdir "$dir"
  (cd "$dir" && split -b "$CHUNK" -a 4 "$file" part.)
  count="$(ls "$dir" | wc -l | tr -d ' ')"
  printf 'header = "Authorization: Bearer %s"\n' "$AUTOMAP_KEY" > "$TMP/automap.cfg"
  seq=0
  for part in $(ls "$dir"); do
    set -- -H "X-Automap-Run: $run" -H "X-Automap-Seq: $seq" -H "X-Automap-Sender: $NAME/$VERSION" -H "X-Automap-Kind: $kind"
    if [ "$seq" -eq $(( count - 1 )) ]; then set -- "$@" -H 'X-Automap-Last: 1' -H "X-Automap-Sha256: $sum"; fi
    tries=1
    while :; do
      KIND_CODE="$(curl -sS -A "$UA" -K "$TMP/automap.cfg" -X POST -H 'Content-Type: text/plain; charset=utf-8' \
        "$@" --data-binary "@$dir/$part" -o "$TMP/resp" -w '%{http_code}' "$AUTOMAP_URL" 2>/dev/null)" || KIND_CODE=000
      if [ "$KIND_CODE" != 000 ] && [ "$KIND_CODE" -lt 500 ] && [ "$KIND_CODE" != 429 ]; then break; fi
      [ "$tries" -ge 3 ] && break
      sleep $(( 1 << tries ))
      tries=$(( tries + 1 ))
    done
    [ "$KIND_CODE" = 202 ] || return
    seq=$(( seq + 1 ))
  done
}

# usage_month <start> <end> <month> - one period's usage into $TMP/usage.json; account ids are not copied
usage_month() {
  local start="$1" end="$2" month="$3" sort page seen n total
  internal_get "creditUsage?startTime=$start&endTime=$end" "$TMP/u-credit.json" || return 1
  : > "$TMP/u-flows.ndjson"
  # sortBy also filters to rules with that metric above zero: read both and merge
  for sort in automationCredits rovoCredits; do
    page=0; seen=0
    while [ "$page" -lt 100 ]; do
      internal_get "highUsageFlows?limit=100&page=$page&sortBy=$sort&startTime=$start&endTime=$end" "$TMP/u-page.json" || return 1
      jq -c '.flows[]?' "$TMP/u-page.json" >> "$TMP/u-flows.ndjson"
      n="$(jq '(.flows // []) | length' "$TMP/u-page.json")"
      total="$(jq '.totalCount // 0' "$TMP/u-page.json")"
      seen=$(( seen + n ))
      { [ "$n" -eq 0 ] || [ "$seen" -ge "$total" ]; } && break
      page=$(( page + 1 ))
    done
  done
  # the rest is the current billing model, and the least stable part: each piece optional
  internal_get "highestUsages?limit=100&month=$month" "$TMP/u-top.json" || echo null > "$TMP/u-top.json"
  internal_get "pagecontext" "$TMP/u-ctx.json" || echo null > "$TMP/u-ctx.json"
  internal_get "usageTrendData" "$TMP/u-trend.json" || echo null > "$TMP/u-trend.json"
  internal_get "hasCreditPack" "$TMP/u-pack.json" || echo null > "$TMP/u-pack.json"
  jq -n --argjson start "$start" --argjson end "$end" --arg month "$month" \
    --slurpfile credit "$TMP/u-credit.json" --slurpfile flows "$TMP/u-flows.ndjson" \
    --slurpfile top "$TMP/u-top.json" --slurpfile ctx "$TMP/u-ctx.json" \
    --slurpfile trend "$TMP/u-trend.json" --slurpfile pack "$TMP/u-pack.json" '
    def pair(c): {total: ((c // {}).total // 0), jira: ((c // {}).currentProduct // 0), other: ((c // {}).everywhereElse // 0)};
    {period: {start: $start, end: $end},
     steps: pair($credit[0].automation), rovo: pair($credit[0].rovo),
     flows: ([ $flows[] | select(.ruleUuid) ] | reduce .[] as $f ({}; .[$f.ruleUuid] = {
       uuid: $f.ruleUuid, name: ($f.ruleName // ""), state: ($f.state // "ENABLED"),
       runs: ($f.runs // 0), steps: ($f.automationCredits // 0), rovo: ($f.rovoCredits // 0),
       deleted: ($f.deleted == true), agentic: ($f.containsAgentic == true)}) | [.[]])}
    + (if ($top[0] | type) == "array" then {billable: {month: $month, rules: [ $top[0][] | select(.ruleIdUuid) | {uuid: .ruleIdUuid, runs: (.executionCount // 0)} ]}} else {} end)
    + (($ctx[0].tenantPageContext.usage.workspaceUsages? // null) as $ws | if ($ws | type) == "object" then
        {limits: [ $ws | to_entries[] | {product: .key, used: (.value.executionsUsed // 0), limit: (.value.executionLimit // 0), edition: (.value.edition // "")} ]} else {} end)
    + (if ($trend[0].data? | type) == "array" then {trend: [ $trend[0].data[] | {month: .month, runs: (.workspaceCounts // {})} ]} else {} end)
    + (if ($pack[0] | type) == "object" then {creditPack: ($pack[0].hasCreditPack == true)} else {} end)
  ' > "$TMP/usage.json" || { ERR="could not read the usage"; return 1; }
}

# push_usage - read and push the usage; a failure is logged and the run goes on
push_usage() {
  off AUTOMAP_USAGE && return
  local now periods line start end month steps n
  now=$(( $(date +%s) * 1000 ))
  # this month so far; and in its first three days the whole of the month before
  periods="$(jq -rn --argjson now "$now" '
    ($now / 1000 | floor | gmtime) as $g | ($g[0]) as $y | ($g[1]) as $m |
    def mlabel(y; m): "\(y)-\(if m + 1 < 10 then "0" else "" end)\(m + 1)";
    ([$y, $m, 1, 0, 0, 0, 0, 0] | mktime * 1000) as $first |
    (if $g[2] <= 3 then (if $m > 0 then [$y, $m - 1] else [$y - 1, 11] end) as $p |
      "\([$p[0], $p[1], 1, 0, 0, 0, 0, 0] | mktime * 1000) \($first - 1) \(mlabel($p[0]; $p[1]))" else empty end),
    "\($first) \($now) \(mlabel($y; $m))"')" || { log "usage (beta) skipped: could not work out the month"; return; }
  printf '%s\n' "$periods" > "$TMP/periods"
  while read -r start end month; do
    if ! usage_month "$start" "$end" "$month"; then log "usage (beta) skipped: $ERR"; return; fi
    jq -a -c -j --arg n "$NAME" --arg v "$VERSION" '{usage: ., sender: {name: $n, version: $v}}' "$TMP/usage.json" > "$TMP/usage.payload"
    steps="$(jq '.usage.steps.total' "$TMP/usage.payload")"
    n="$(jq '.usage.flows | length' "$TMP/usage.payload")"
    if [ -n "$DRY_RUN" ]; then log "usage (beta) $month: $steps steps, $n rules with usage; nothing pushed"; continue; fi
    send_kind usage "$TMP/usage.payload"
    if [ "$KIND_CODE" = 202 ]; then log "usage (beta) $month: pushed $steps steps for $n rules"
    else log "usage (beta) $month: not taken, receiver answered $KIND_CODE $(word)"; fi
  done < "$TMP/periods"
}

# push_runs - the audit log (BETA), folded into what the map needs; a failure is logged and the run goes on
push_runs() {
  off AUTOMAP_RUNS && return
  local days now start from offset n budget uuid id total bad
  days="${AUTOMAP_RUNS_DAYS:-7}"
  case "$days" in ''|*[!0-9]*) days=7 ;; esac
  [ "$days" -lt 1 ] && days=1
  [ "$days" -gt 30 ] && days=30
  now=$(( $(date +%s) * 1000 ))
  start=$(( now - days * 86400000 ))
  start=$(( start - start % 86400000 ))   # whole days, so a day pushed is a day complete
  from="$(jq -rn --argjson s "$start" '$s / 1000 | floor | todate | sub("Z$"; ".000Z")')"
  : > "$TMP/r-records.ndjson"
  offset=0
  while [ "$offset" -lt 50000 ]; do   # 50 a page whatever is asked; `total` is always 0
    if ! internal_get auditlog "$TMP/r-page.json" 3 "{\"fromTime\":\"$from\",\"offset\":$offset,\"limit\":50}"; then
      log "runs (beta) skipped: $ERR"; return
    fi
    jq -c '.items.items[]?' "$TMP/r-page.json" >> "$TMP/r-records.ndjson"
    n="$(jq '(.items.items // []) | length' "$TMP/r-page.json")"
    [ "$n" -lt 50 ] && break
    offset=$(( offset + 50 ))
  done
  # per rule and UTC day: success, errors, nothing done, edits, time spent, runs per hour
  jq -s -c --argjson start "$start" '
    [ .[] | select(.ruleIdUuid) | (.eventTimestamp // .startTime) as $t | select($t and $t >= $start) | . + {t: $t} ] as $recs |
    {rows: (reduce $recs[] as $r ({};
       ($r.t / 1000 | floor | todate | .[0:10]) as $day | ($r.ruleIdUuid + "|" + $day) as $k |
       (.[$k] //= {uuid: $r.ruleIdUuid, day: $day, name: ($r.ruleName // ""), success: 0, errors: 0, noop: 0, edits: 0, ms: 0, maxMs: 0}) |
       if $r.category == "CONFIG_CHANGE" then .[$k].edits += 1 else
         (if $r.category == "SUCCESS" then .[$k].success += 1 elif $r.category == "NO_ACTIONS_PERFORMED" then .[$k].noop += 1 else .[$k].errors += 1 end) |
         ($r.t / 1000 | floor | gmtime | .[3] | floor | tostring) as $h |
         .[$k].hours[$h] = ((.[$k].hours[$h] // 0) + 1) |
         .[$k].ms += ($r.durationMs // 0) | .[$k].maxMs = ([.[$k].maxMs, ($r.durationMs // 0)] | max)
       end) | [.[]]),
     failed: ([ $recs[] | select(.category != "SUCCESS" and .category != "NO_ACTIONS_PERFORMED" and .category != "CONFIG_CHANGE" and .id) ]
       | group_by(.ruleIdUuid) | map(sort_by(- (.eventTimestamp // 0)) | .[0:2] | map({uuid: .ruleIdUuid, id: .id, at: (.eventTimestamp // 0)})) | add // [])}
  ' "$TMP/r-records.ndjson" > "$TMP/r-fold.json" 2>/dev/null || { log "runs (beta) skipped: could not fold the audit log"; return; }
  # the failing component and the error code of up to two failed runs a rule, 40 in all
  : > "$TMP/r-errors.ndjson"
  budget=40
  jq -r '.failed[] | "\(.uuid) \(.id) \(.at)"' "$TMP/r-fold.json" > "$TMP/r-failed"
  while read -r uuid id at; do
    [ "$budget" -le 0 ] && break
    budget=$(( budget - 1 ))
    internal_get "auditlog/item/$id" "$TMP/r-item.json" 3 || continue
    jq -c --arg u "$uuid" --argjson at "$at" '
      (.content.componentLogs // [])[] |
      ((.executionResult // {}) as $res |
       ([ (.changes // [])[] | select(.payload.type? == "ERROR") | (.payload.key // "") ][0] // "") as $k |
       (if $k != "" then $k else ($res.auditEventErrorType // $res.errorType // "") end) as $code |
       select($code != "" or $res.state == "SOME_ERRORS") |
       {uuid: $u, componentId: (.component.id // ""), componentType: (.component.componentType // ""),
        type: (.component.type // ""), code: (if $code == "" then "SOME_ERRORS" else $code end), at: $at})
    ' "$TMP/r-item.json" >> "$TMP/r-errors.ndjson" 2>/dev/null || true
  done < "$TMP/r-failed"
  jq -a -c -j -n --argjson start "$start" --argjson end "$now" --arg n "$NAME" --arg v "$VERSION" \
    --slurpfile fold "$TMP/r-fold.json" --slurpfile errors "$TMP/r-errors.ndjson" \
    '{runs: {window: {start: $start, end: $end}, rows: $fold[0].rows, errors: $errors}, sender: {name: $n, version: $v}}' \
    > "$TMP/runs.payload" || { log "runs (beta) skipped: could not assemble the runs"; return; }
  total="$(jq '[.runs.rows[] | .success + .errors + .noop] | add // 0' "$TMP/runs.payload")"
  bad="$(jq '[.runs.rows[] | .errors] | add // 0' "$TMP/runs.payload")"
  if [ -n "$DRY_RUN" ]; then log "runs (beta) last $days days: $total runs, $bad with errors; nothing pushed"; return; fi
  send_kind runs "$TMP/runs.payload"
  if [ "$KIND_CODE" = 202 ]; then log "runs (beta) last $days days: pushed $total runs, $bad with errors"
  else log "runs (beta): not taken, receiver answered $KIND_CODE $(word)"; fi
}

push_rules
# usage is a push of its own and spends no load, so it goes even when the rules were refused
# (an allowance used up, say); it never changes the exit code - but not when the receiver
# shut the door (403: switched off, or not on this plan)
case "$RULES_CODE:$RULES_SAY" in
  4:*403*) ;;
  *) push_usage; push_runs ;;
esac
[ "$RULES_CODE" -eq 0 ] || die "$RULES_CODE" "$RULES_SAY"
exit 0
