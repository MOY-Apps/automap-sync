#!/usr/bin/env bash
# automap-sync (bash) - push this site's automation rules to Automation Map.
#
# Reads every automation rule with YOUR Atlassian API token (it never leaves this
# machine), and pushes them to the Automation Map push receiver with the key the app
# issued. Needs bash 3.2+, curl, jq 1.6+, and sha256sum or shasum. Contract:
# docs/push-sync.md. Same environment, flags and exit codes as the Python sender:
#
#   ATLASSIAN_SITE | ATLASSIAN_CLOUD_ID, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN,
#   AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE
#
#   ./automap-sync.sh [--dry-run]
#
# Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
# receiver, 5 try later, 6 failed.
#
# Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
set -u

NAME=bash
VERSION=1.0.0
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

if [ -n "$DRY_RUN" ]; then
  log "dry run: $BYTES bytes in $COUNT chunk(s), sha256 $SUM; nothing pushed"
  exit 0
fi
need AUTOMAP_URL
need AUTOMAP_KEY
printf 'header = "Authorization: Bearer %s"\n' "$AUTOMAP_KEY" > "$TMP/automap.cfg"

word() { jq -r '.error // empty' "$TMP/resp" 2>/dev/null; }

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
        die 6 "receiver answered $code $(word)" ;;
      429) die 5 "receiver answered 429 $(word): try again later" ;;
      400|401|402|403|404|405|413|426) die 4 "receiver refused the push: $code $(word)" ;;
      *) die 6 "receiver answered $code $(word)" ;;
    esac
  done
  if [ -z "$restart" ]; then
    log "pushed $BYTES bytes in $COUNT chunk(s); the map is rebuilding"
    exit 0
  fi
done
die 6 "the push did not go through twice"
