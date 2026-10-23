# Automation Map push API

This is the reference for writing your own sender: a job that reads your Jira automation
rules with your own Atlassian API token and pushes them to Automation Map for Jira. Use it
when none of our senders (Docker, Python, Node.js, bash, PowerShell, ScriptRunner, JMWE)
fits your stack.

- [`openapi.json`](openapi.json) is the same API as an OpenAPI 3.1 spec, for tools and code
  generators.
- [`PROTOCOL.md`](PROTOCOL.md) is the full contract, with the reasons behind each rule.
- Our senders in this repository are working examples. [`python/automap_sync.py`](python/automap_sync.py)
  is the easiest to read.

Pushes are part of the **Advanced** edition. On Basic (sold as Standard) the rules come in
as an export file, and every push is answered `403 disabled`.

## Quick start with curl

You need two values from the app. In Jira: **Settings → Apps → Automation Map → Data →
Push from your side → Set up**.

- `<receiver-url>`: the URL the guide shows. It ends in `/v1/push`.
- `<push-key>`: the key the guide makes. It starts `amk_` and is shown once.

```bash
URL='<receiver-url>'     # ends in /v1/push
KEY='<push-key>'         # amk_...
```

**1. Check the URL.** `GET` on the URL without `/push`. No key needed.

```bash
curl -sS "${URL%/push}"
# {"ok":true,"receiver":"automation-map","protocol":"v1"}
```

**2. Push a tiny document in one chunk.**

```bash
BODY='{"rules":[]}'
SUM=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)   # or sha256sum
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: text/plain; charset=utf-8' \
  -H "X-Automap-Run: smoke-$(date +%s)" \
  -H 'X-Automap-Seq: 0' \
  -H 'X-Automap-Last: 1' \
  -H "X-Automap-Sha256: $SUM" \
  -H 'X-Automap-Sender: smoketest/1.0.0' \
  --data-binary "$BODY" -w '\n%{http_code}\n'
# {"accepted":true,"queued":true}
# 202
```

`202 queued` proves the URL, the key and the checksum. An empty rule list then fails the
build on the app's side (the settings page says so). A failed build does not count as a
load.

## How a push works

- A **push** is one JSON document. There are three kinds: **rules**, **usage** (beta) and
  **runs** (beta). Each is a push of its own.
- You serialise the document once, compute its SHA-256, and split the text into
  **chunks** of at most 200,000 bytes.
- You send the chunks **in order, one at a time**, as `POST <receiver-url>`. All chunks of
  one push share a **run id**. The last chunk says it is the last and carries the proof.
- The receiver joins the chunks and checks the proof. Rules then go to a build: the map
  rebuilds in a minute or two. Usage and runs are written by the same queue, within a minute.
- Every answer is one of a fixed set of bodies. The receiver never returns your data,
  counts or error text. Read the **status code**. What happened after the push (loaded,
  refused as another site's) is on the app's settings page.

## Write your own sender, step by step

### 1. Read the rules from Atlassian

Use an Atlassian API token **with the Automation scope**, for a Jira administrator
(a service account is best). Basic auth: `email:token`.

1. Cloud id: `GET https://<your-site>.atlassian.net/_edge/tenant_info` → `cloudId`.
2. Rule list, paged:
   `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/summary?limit=100`.
   The rules are in `data`, each with its `uuid` (or `id`). Follow `links.next` (its
   `cursor` parameter) until there is none.
3. Each rule: `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/<uuid>`.
   The answer is the rule, bare or wrapped in `rule`.
4. On 429 or 5xx, wait `Retry-After` seconds (or 1 s, doubling up to 15 s) and retry, up to
   four times. 401 and 403 are not transient: wrong token or scope, or not an administrator.

The token goes only to Atlassian. Never send it to the receiver.

### 2. Build the document

```json
{"rules":[{"rule":{ ...the rule as the API returned it... }}, ...],
 "sender":{"name":"acme-sync","version":"1.0.0"}}
```

- Wrap **every** rule in `rule`. That is how the app knows it is the API's format.
- Send **every** rule, enabled and disabled.
- Send rules **as they are**. Do not strip or mask secrets: the app replaces every
  credential it recognises before anything is parsed or stored.
- `sender` is optional and only informational.

### 3. Serialise

- **Compact JSON**: no indentation, no line breaks, no newline at the end. The platform
  removes line breaks from a request body, and the hash would no longer match.
- **Escape to ASCII**: write every non-ASCII character as `\uXXXX` (an emoji is two). Then one
  character is one byte, and a split by bytes is always safe. Python:
  `json.dumps(doc, separators=(",", ":"))` (ASCII by default). jq: `jq -acj` (`-a` ASCII,
  `-c` compact, `-j` no newline at the end; without `-c` and `-j` the push fails `422`).
- If you cannot escape, send UTF-8 and split on character boundaries, never between the two
  halves of a UTF-16 surrogate pair.

### 4. Prove it

- `sha256 = hex(SHA-256(UTF-8 bytes of the whole text))`. Send it on the last chunk as
  `X-Automap-Sha256`.
- No SHA-256 in your language? Send `X-Automap-Length` instead: the text's length in
  **UTF-16 code units** (a JavaScript string's `length`; an emoji counts 2), not bytes. It is
  weaker: it catches a cut document, not a changed character. Given both, both must match.

### 5. Split and send

- Chunks of at most **200,000 bytes**. The receiver refuses a chunk over 262,144 bytes
  (`413`). At most 400 chunks per push (80 MB).
- A new **run id** per push: 8 to 64 characters of `A-Z a-z 0-9 _ -`. A UUID without dashes
  works.
- Send chunk 0, wait for `202`, send chunk 1, and so on. Never in parallel.
- Headers on every chunk:

```
POST <receiver-url>
Authorization: Bearer <push-key>
Content-Type: text/plain; charset=utf-8
X-Automap-Run: <run id>
X-Automap-Seq: <0, 1, 2, ...>
X-Automap-Kind: rules                (or usage, or runs; leave out for rules)
X-Automap-Sender: acmesync/1.0.0     (optional; see "Identify your sender")
```

- And on the **last** chunk only:

```
X-Automap-Last: 1
X-Automap-Sha256: <sha256>           (or X-Automap-Length: <length>, or both)
```

- Do not compress the body. `Content-Encoding: gzip` is answered `400`.

A push of one chunk sends everything on chunk 0, including `X-Automap-Last` and the proof.

### 6. Read each answer and act

See [Answers](#answers). In short:

- `202 accepted`: send the next chunk.
- `202 queued`: done.
- `500 failed`, or no answer at all: send the **same** chunk again, with a backoff. Resending
  a chunk replaces the copy already received, so it is always safe.
- `409 conflict` or `422 checksum`: start again with a **new run id** from chunk 0. Do this
  once; if it fails again, stop and report. A `409` on a *resent* last chunk (one whose first
  answer was lost, so you sent it again) means the first copy arrived and closed the run: the
  push is done. Do not start a new run - it would load the same rules again and spend a
  second load. Our senders do this from 1.3.0 (ScriptRunner and JMWE 1.5.0), for usage and
  runs too.
- `429`: stop and try later.
- Anything else: stop and report. Sending the same request again will not help.

### 7. Usage and runs (beta, optional)

Two more pushes after the rules, each with its own run id and `X-Automap-Kind`. Their
documents are described in [Payloads](#payloads). They read an undocumented internal
Atlassian API that can change without notice; see
[`PROTOCOL.md`](PROTOCOL.md) §6a and §6b for where our senders read them. Rules for them:

- Never fail the job because of them. Push the rules first.
- They count no load and are taken even when the rules were refused for the allowance.
- One push of each kind at a time: a new usage push of several chunks clears whatever
  another usage push left half-sent (the same for runs).
- On `403`, skip them: the site does not take them.

### Large sites: parts

A job inside Jira (ScriptRunner, JMWE) has a time limit, and reading more than a few hundred
rules one by one does not fit in it. So the rules may come in **parts**: several scheduled
copies of the job, each reading its share of the rules and pushing it as a complete rules
document of its own, with `X-Automap-Part: N/M` on every chunk. The receiver merges the
parts and builds once.

- Each part is a push exactly as above: its own chunks from `X-Automap-Seq: 0`, its own
  proof on its last chunk, the same document shape (just fewer rules). Reuse your chunk code.
- All parts of one build share the **run id**. Jobs that cannot talk to each other agree on
  it by the date: our senders use `d<YYYYMMDD>` in UTC, `d20261023`, stamped when the job
  starts. Schedule the copies inside the same UTC day - e.g. 01:00 and 02:00 UTC, not either
  side of 00:00 UTC - or they name different days and neither group completes.
- How the rules are cut is the sender's business; the receiver merges whatever arrives. Cut
  by something stable in each rule, not by its position in the list: our senders (1.5.0)
  put a rule in part `(first 8 hex digits of its uuid, as a number) mod M + 1`, so a rule
  made or deleted between the jobs moves no other rule across the cut. The slices are then
  roughly, not exactly, equal. A slice by position shifts when the list shrinks, and a rule
  near the boundary lands in no part that day.
- `N/M` is the same on every chunk of the part; `M` is the same on every part. A part with
  another `M` is `409`.
- The last chunk of a part is answered `202 accepted` while parts are missing, and
  `202 queued` when it completed the group. Parts may come in any order. The group is **one
  load**, checked when its first chunk 0 arrives.
- A part sent again (chunk 0 of a part already in) replaces that part. A part whose proof
  fails (`422`) is dropped alone; the others stay, send that part again.
- A group not complete after **24 hours** is abandoned: its parts are dropped, nothing is
  loaded, the settings page says so, and that run id is closed (`409`). The next day's run
  id opens a new group, a new load.
- Merging: the rules of every part, in part order, a rule in two parts kept once (the later
  part's copy; by `uuid`, or `id` without one), `sender` from the part that completed the
  group, and `"parts": M` added. Usage and runs do not come in parts (`400`).

Two parts with curl, each a document of its own, an hour apart:

```bash
for PART in 1 2; do
  BODY=$(cat "rules-part-$PART.json")        # {"rules":[...]} - this part's share, compact
  SUM=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
  curl -sS -X POST "$URL" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: text/plain; charset=utf-8' \
    -H "X-Automap-Run: d$(date -u +%Y%m%d)" \
    -H 'X-Automap-Seq: 0' -H 'X-Automap-Last: 1' -H "X-Automap-Sha256: $SUM" \
    -H "X-Automap-Part: $PART/2" \
    --data-binary "$BODY" -w '\n%{http_code}\n'
done
# {"accepted":true}            202   - part 1 in, one to come
# {"accepted":true,"queued":true}  202   - part 2 completed the group: one build
```

### 8. Schedule

Once a day is right. Each rules push that builds counts as a load: Advanced has 5 in a
rolling day, files and pushes alike. Over that, rules pushes get `429 allowance` until the
window moves. Usage and runs count no load; our senders inside Jira push them every hour.
To save loads, keep the last checksum and skip the rules push when it has not changed.

## Headers

| Header | On | Value | Since |
|---|---|---|---|
| `Authorization` | every chunk | `Bearer <push-key>` | 1.0.0 |
| `X-Automap-Key` | every chunk | `<push-key>`, instead of `Authorization`; wins if both are sent | 1.0.0 (taken; our senders send `Authorization`) |
| `X-Automap-Run` | every chunk, required | 8 to 64 of `A-Z a-z 0-9 _ -`, new per push | 1.0.0 |
| `X-Automap-Seq` | every chunk, required | `0` to `399`, in order | 1.0.0 |
| `X-Automap-Last` | last chunk | `1` (or `true`). Any other value means more follow | 1.0.0 |
| `X-Automap-Sha256` | last chunk | 64 hex characters: SHA-256 of the whole text's UTF-8 bytes | 1.0.0 |
| `X-Automap-Length` | last chunk | the whole text's length in UTF-16 code units | 1.0.0 (JMWE) |
| `X-Automap-Kind` | every chunk | `rules` (default), `usage` or `runs` | 1.1.0 |
| `X-Automap-Part` | every chunk of a part, rules only | `N/M`: part N of M complete rules documents under one run id, 1 <= N <= M, 2 <= M <= 20; see [Large sites: parts](#large-sites-parts) | receiver 2026-10-23 (scriptrunner, jmwe 1.4.0) |
| `X-Automap-Sender` | every chunk | `<name>/<major>.<minor>.<patch>`, optional | 1.0.0 |
| `Content-Type` | every chunk | `text/plain; charset=utf-8` | 1.0.0 |
| `Content-Encoding` | — | do not send `gzip` | — |

Header names are case-insensitive. The last chunk needs `X-Automap-Sha256` or
`X-Automap-Length`; without either, or with a malformed one, it is a `400`. On other chunks
they are ignored.

"Since" is the version of our senders that first sent the header. The receiver takes every
header from any sender, whatever its version.

## Payloads

The full schemas are in [`openapi.json`](openapi.json) under `components.schemas`. The
receiver keeps only the fields below and drops everything else, account ids included.

### Rules (`X-Automap-Kind: rules`, or no Kind header)

```json
{"rules":[{"rule":{"uuid":"…","name":"…","state":"ENABLED","created":1757000000,
  "updated":1757000500,"canOtherRuleTrigger":false,
  "ruleScopeARIs":["ari:cloud:jira:<cloudId>:project/10001"],
  "trigger":{…},"components":[…],"labels":[],"description":"…"}}],
 "sender":{"name":"acme-sync","version":"1.0.0"}}
```

The rule objects go as the Automation API returned them. A document whose rule scopes name
another Jira site is refused by the build. An Automation-screen export (rules not wrapped in
`rule`) is accepted too, but carries less.

### Usage (`X-Automap-Kind: usage`, beta)

One month, as Jira's Usage tab shows it. The app keeps one snapshot per month (the UTC
month of `period.start`); a newer push for that month replaces it.

```json
{"usage":{
  "period":{"start":1790812800000,"end":1791990000000},
  "steps":{"total":1322,"jira":1322,"other":0},
  "rovo":{"total":0,"jira":0,"other":0},
  "flows":[{"uuid":"019dd4aa-…","name":"MARKET: Licenses create","state":"ENABLED",
            "runs":14,"steps":1303,"rovo":0,"deleted":false,"agentic":false}],
  "billable":{"month":"2026-10","rules":[{"uuid":"019dd4aa-…","runs":14}]},
  "limits":[{"product":"JIRA_SERVICE_MANAGEMENT","used":18,"limit":3000,"edition":"premium"}],
  "trend":[{"month":"2026-09","runs":{"JIRA_SERVICE_MANAGEMENT":1073}}],
  "creditPack":false}}
```

| Field | Rule |
|---|---|
| `period.start`, `period.end` | Unix ms, both above 0, end not before start. Required; without it the push is a `400` |
| `steps`, `rovo` | `total`, `jira`, `other` |
| `flows[]` | one per rule. `uuid` is `A-Z a-z 0-9 -`, up to 64; an entry without one is dropped. `name` is cut to 255 characters. `state` other than `DISABLED` is kept as `ENABLED`. Send every rule: Atlassian lists up to 10,000 a month, and Advanced keeps all you send |
| `billable` | optional; dropped if `month` is not `YYYY-MM`; first 100 rules kept |
| `limits[]` | optional; `product` is `A-Z _`, up to 40; first 10 kept |
| `trend[]` | optional; first 12 months, 10 products each |
| `creditPack` | optional boolean |

Every count is a number of 0 or more, rounded; anything else is kept as 0.

### Runs (`X-Automap-Kind: runs`, beta)

The audit log of whole UTC days, folded on your side into counts per rule and day. Counts
and codes only: no work-item ids, no message text, no account ids.

```json
{"runs":{
  "window":{"start":1791331200000,"end":1791991583000},
  "rows":[{"uuid":"019dd4aa-…","day":"2026-10-13","name":"MARKET: Licenses create",
           "success":10,"errors":30,"noop":0,"edits":1,"ms":1200000,"maxMs":31000,
           "hours":{"9":12,"14":28}}],
  "errors":[{"uuid":"019dd4aa-…","componentId":"5ce09150-…","componentType":"BRANCH",
             "type":"jira.smart.values.branch",
             "code":"com.codebarrel.automation.rule.error.smart.value.no.object","at":1791968400000}]}}
```

| Field | Rule |
|---|---|
| `window.start`, `window.end` | Unix ms, end not before start, at most 31 days apart. Otherwise the push is a `400` |
| `rows[]` | one per rule and UTC day (`day` is `YYYY-MM-DD`). `success`, `errors`, `noop` (did nothing), `edits` (rule edits, not runs), `ms` (total time), `maxMs` (longest run). At most 20,000 rows a day and 100,000 a push: past the push cap the newest days are kept whole, the oldest dropped, and the window starts at the first day kept |
| `rows[].hours` | optional, sparse: runs per UTC hour, keys `0` to `23`, only hours that had any |
| `errors[]` | failed components of failed runs: `uuid` (the rule; an entry without one is dropped), `componentId`, `componentType`, `type`, `code` (the error's i18n key or code), `at` (Unix ms). First 500 kept; the app keeps the 5 newest per rule |

The days the window covers replace what the app had for them. Other days are kept, 35 days
back.

## Answers

Every answer is JSON from a fixed list. `error` names it; `detail` is a fixed sentence.

| Status | Answer | Means | What the sender does |
|---|---|---|---|
| 200 | `alive` | `GET /v1`: the receiver is there | — |
| 202 | `accepted` | the chunk is stored; or the last chunk of a part while other parts are still to come | send the next chunk (or the next part) |
| 202 | `queued` | the last chunk proved the whole. Rules: build queued. Usage, runs: write queued, kept within a minute | done |
| 400 | `bad-request` | a header missing or malformed (`X-Automap-Part` not `N/M` in range, or on usage or runs); seq 400 or more; empty or gzip body; usage or runs that is not JSON or not the right shape; a part that is not a rules document | fix the sender |
| 401 | `unauthorized` | no key, wrong key, revoked key | stop; make a new key in the app |
| 402 | `inactive` | the subscription on this site has ended | stop |
| 403 | `disabled` | this installation does not take this push: sync not switched on, or the site is on Basic | stop; skip usage and runs too |
| 404 | `not-found` | the path is not `/v1/push` (or `GET /v1`) | fix the URL |
| 405 | `method` | not `POST` on `/v1/push` | use POST |
| 409 | `conflict` | chunk out of order, unknown run, last chunk while chunks are missing, or (rules) a run already closed; a part whose `M` differs from the group's, or for a group already built | new run from chunk 0 |
| 413 | `too-large` | the chunk is over 262,144 bytes | send 200,000-byte chunks |
| 422 | `checksum` | the joined chunks do not match the SHA-256 or the length; nothing kept, the previous map stays. A part: only that part is dropped, the group stays | new run (a part: the same part again from chunk 0); if it repeats, check line breaks, the hash input and compression |
| 426 | `upgrade` | `X-Automap-Sender` names one of our senders below its minimum | update the sender |
| 429 | `allowance` | rules only: the plan's loads are used up | stop; try after the window moves |
| 429 | `rate-limited` | over 500 requests in the current 10-minute window | wait ten minutes, then a new run |
| 500 | `failed` | the receiver could not store the chunk | same chunk again with backoff, then a new run later |

A `409` on a resent last chunk of rules can mean the first copy arrived and the run is
closed: the push is done. The settings page shows whether it loaded.

The receiver checks in this order: path and method; sync switched on (`403`, before the
key); the key (`401`); the rate (`429`); the subscription (`402`); the headers (`400`); the
plan (`403`); the sender version (`426`); compression, empty body (`400`) and size (`413`);
then chunk order (`409`), the allowance on chunk 0 of a new rules run (`429`) and, on the
last chunk, the proof (`422`).

## Limits

| Limit | Value |
|---|---|
| One chunk | 262,144 bytes of UTF-8 (`413` above). Send 200,000 |
| Chunks in one push | 400 (`X-Automap-Seq` 0 to 399) |
| Requests | 500 per key in a fixed 10-minute window, every request with the right key counted, refused ones too (`429 rate-limited`) |
| Rules pushes that build | Advanced: 5 in a rolling day, files and pushes alike (`429 allowance`) |
| Usage rules | up to 10,000 a month (what Atlassian lists); Advanced keeps all |
| Runs | window of at most 31 days; 100,000 rows (20,000 a day) and 500 errors per push; 35 days kept |

## Versions

### Version matrix

What each released version of our senders sends. The Docker image
`ghcr.io/moy-apps/automap-sync:1` runs the Python sender and sends `python/<version>`.

| Version | Senders | What it sends |
|---|---|---|
| 1.0.0 | python, node, bash, powershell, scriptrunner, jmwe | rules, in chunks, proven by SHA-256 (jmwe: by `X-Automap-Length`) |
| 1.0.1 | scriptrunner | as 1.0.0 (`ATLASSIAN_SITE` became optional) |
| 1.1.0 | python, node, bash, powershell, scriptrunner, jmwe | rules as before; plus usage and runs (`X-Automap-Kind`), each in **one chunk**, trimmed to the busiest rules to fit |
| 1.2.0 | python, node, bash, powershell | usage and runs in **chunks**, every rule |
| 1.2.0 | scriptrunner, jmwe | as 1.1.0 on the wire; the rules and the usage and runs became two jobs |
| 1.2.1 | scriptrunner, jmwe | as 1.2.0 on the wire; the usage job runs every hour over yesterday and today |
| 1.3.0 | scriptrunner, jmwe | usage and runs in **chunks**, every rule (jmwe: chunks of 80,000 characters, proven by length) |
| 1.4.0 | scriptrunner, jmwe | rules in parts (`PART=N/M`, `X-Automap-Part`), for sites past the host's time limit |
| 1.3.0 | python, node, bash, powershell | as 1.2.0 on the wire to the receiver. A `409` to a resent last chunk ends the push instead of starting a second run; the audit log is read with `toTime` and, past 50,000 records, pushed from its first complete day; the internal API is retried honouring `Retry-After` |
| 1.5.0 | scriptrunner, jmwe | as 1.4.0 on the wire to the receiver. Parts cut by each rule's own id (roughly equal slices); the resent-`409` rule above; JMWE retries every request (at once) and restarts once on `409`/`422` |
| 1.6.0 | scriptrunner, jmwe | the usage job pushes the runs as hourly **slices**: `runs.mode: "slice"`, `window` the previous full UTC hour, half-open; the receiver adds each hour once. `RUNS_MODE=days` is 1.5.0's whole days |

Latest today: python, node, bash and powershell **1.3.0**; scriptrunner and jmwe **1.6.0**.
The same list is in [`openapi.json`](openapi.json) under `x-automap-senders`.

### Old senders keep working

Every shape any released sender has sent is still accepted, and will be:

- rules in one chunk or many, proven by SHA-256 or by length;
- usage and runs in one chunk (1.1) or in many (1.2 and later);
- the minimum version of every sender is **1.0.0**.

A new feature may need a newer sender to *use* it. It never stops an older one from doing
what it did. So a sender you write against this page keeps working.

### The protocol version is the path

The version of the receiver you push to is in the URL: `/v1/push` (`GET /v1` answers
`"protocol":"v1"`). You do not send it in a header.

- `v1` only grows: new optional headers, kinds and answers. Nothing that works on `v1`
  today stops working on `v1`.
- A change that old senders could not follow ships as a **new path**, `/v2/push`, next to
  `/v1`. Both are taken at the same time, and this page describes both.
- `v1` is switched off only on a date announced at least **3 months** ahead: on this page,
  in the app's settings, and in the receiver's answers to `v1` pushes. After that date `v1`
  answers `426 upgrade` with what to change. No such date is set today.

So write your sender against one path and keep the path in its configuration (the receiver
URL is a setting in all of ours). Moving to `v2` is then a new URL plus the changes `v2`
lists, not a guess.

### Identify your sender

`X-Automap-Sender: <name>/<major>.<minor>.<patch>` is optional. The name is 2 to 20
lower-case letters.

- The names `python`, `node`, `bash`, `powershell`, `scriptrunner` and `jmwe` are ours. The
  receiver checks their version: below the minimum it answers `426 upgrade`.
- **Any other name**, a value of another shape (`my-sync/1.0` for example), or no header at
  all: the push is taken **unnamed**. It is never answered `426`. The app does not store the
  name, so the settings page shows no sender or version for it.
- So use a name of your own, or leave the header out. Do not send one of our names: your
  pushes would be reported as ours, and could be stopped by our minimum version.

The `sender` object inside the document is informational. The receiver does not read it.
