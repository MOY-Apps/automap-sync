<!-- Generated from docs/push-sync.md in the app repository by scripts/build-sender-sources.mjs; edit that file. -->
# Push sync — the contract for a sender

Automation Map cannot read automation rules by itself. The Automation Rule Management API
accepts only a personal Atlassian API token or a browser session — "Forge and OAuth2 apps
cannot access this REST resource" — and Marketplace security requirements forbid an app
to collect, store or transmit such a token (Requirement 11; the exception was refused in
ECOHELP-165665, the public request is [AUTO-2342](https://jira.atlassian.com/browse/AUTO-2342)).

So the token stays with the customer. A **sender** they run themselves — a CI job, a
container, a cron — reads the rules with their own token and **pushes** the JSON to the
app. The app only ever sees a key it issued itself.

```
 customer side                                          Atlassian (Forge)
┌──────────────────────────────┐                ┌────────────────────────────────────┐
│ sender (CI / Docker / cron)  │                │ Automation Map                     │
│                              │                │                                    │
│ ATLASSIAN_EMAIL + API token ─┼──GET rules────▶│ api.atlassian.com/automation/...   │
│ (their secret store)         │◀──JSON─────────│ (Automation Rule Management API)   │
│                              │                │                                    │
│ AUTOMAP_KEY (ours) ──────────┼──POST chunks──▶│ web trigger automap-push (static)  │
│                              │◀──status code──│  → staging_chunks → build job      │
└──────────────────────────────┘                │  → the same build as a loaded file │
                                                └────────────────────────────────────┘
```

The receiver side is described in `architecture.md` § "The push
receiver"; this page is what a sender must do. A customer writing a sender of their own
reads the short reference, [`API.md`](API.md), with the OpenAPI spec
[`openapi.json`](openapi.json), both next to the senders; a test in the app
(`test/openapi.test.mjs`) holds both to the code.

## 1. What the administrator sets up

| Secret | Where it comes from | Who sees it |
|---|---|---|
| `AUTOMAP_URL` | Settings → Automation Map → Data → **Push from your side** → **Set up**: the guide shows the receiver URL, ending `/v1/push`, with a Copy button | not secret, but per installation |
| `AUTOMAP_KEY` | the guide's first step, **Make a key** — shown once, starts `amk_`, and filled into the guide's snippets for that session | the sender only; the app keeps a hash |
| `ATLASSIAN_SITE` | `your-site.atlassian.net` | — |
| `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` | id.atlassian.com → Security → API tokens, for a Jira administrator (a service account is better); the token must carry the Automation scope - a plain Jira-scoped token is refused with a scope mismatch | the sender only; **never the app** |

The receiver is off unless the installation takes pushes: always on a development
installation, elsewhere with `AUTOMAP_PUSH_SYNC=on` set by us. Off, every push gets
`403 disabled` and the card is not shown.

The guide's third step waits for the first push and says what happened to it. A push the
app refused after the key matched - `426 upgrade` or `429 allowance` - is remembered
too, so the page says why nothing arrived instead of waiting.

## 2. Reading the rules (the sender's half)

The sender reads exactly what the app's own sync used to read, so the build treats it
identically.

1. **Cloud id**: `GET https://<site>/_edge/tenant_info` → `{ "cloudId": "…" }`.
2. **Rule list**, paged:
   `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/summary?limit=100[&cursor=…]`
   with `Authorization: Basic base64(email:token)`. Each page has `data[]` (each with a
   `uuid`) and `links.next`, whose `cursor` parameter is the next page; stop when there is
   no `links.next`.
3. **Each rule**: `GET …/rest/v1/rule/<uuid>`. The answer is the rule, bare or wrapped in
   `rule`.
4. **Retries**: 429 and 5xx — wait `Retry-After` seconds (or 1 s doubling to 15 s, with
   jitter) and retry, up to four attempts. 401: wrong token or a token without the
   Automation scope. 403: the account is not a Jira administrator. Both are not
   transient — stop and say so.

## 3. The payload

One JSON document, in the Automation API's shape — the format `adapt.js` calls `api`:

```json
{
  "rules": [
    { "rule": { "uuid": "…", "name": "…", "state": "ENABLED", "created": 1757000000,
                "updated": 1757000500, "canOtherRuleTrigger": false,
                "ruleScopeARIs": ["ari:cloud:jira:<cloudId>:project/10001"],
                "trigger": { … }, "components": [ … ], "labels": [], "description": "…" } }
  ],
  "sender": { "name": "automap-sync", "version": "1.0.0" }
}
```

- **Every entry wrapped in `rule`.** That is how the build recognises the API format; a
  bare rule would be read as an Automation-screen export and lose its scope.
- **Every rule, enabled and disabled.** The map shows both, and a disabled rule that would
  set off another is a finding.
- **`sender`** is optional and informational; the build ignores unknown top-level keys.
- **Compact JSON, no line breaks** (`JSON.stringify(doc)` with no indent). The platform
  removes line breaks from a web trigger body; a compact document has none outside string
  values, where JSON escapes them as `\n` anyway.
- **ASCII only.** Escape every non-ASCII character as `\uXXXX` (UTF-16 units, so an emoji
  is a surrogate pair): Python's `json.dumps` does it by default, `jq -a` does it, the
  other senders do it by hand. The document then has one byte per character, and splitting
  it by bytes can never cut a character in half. The receiver accepts UTF-8 too, but then
  the sender must split on character boundaries itself.
- **Do not strip or mask secrets.** The build scrubs every credential it can recognise
  (headers, tokens compared against literals, hook URLs) before anything is parsed or
  stored, the same way for a file and for a push; a sender that masks its own way would
  hide which rules share a token.
- An Automation-screen export (`{ "rules": [ { "components": … } ] }`) is accepted too, but
  it carries less (no uuid, webhook tokens blanked), so a sender reading the API should
  send the API's shape.

The build refuses a document whose scope ARIs name another site (`Refused: …different Jira
site`), exactly as it refuses such a file; the rules must be this installation's.

## 4. The protocol

Base: `AUTOMAP_URL` without the trailing `/push`, e.g. `https://…/x1/…/v1`.

| Request | Purpose |
|---|---|
| `GET  <base>` (i.e. `…/v1`) | Liveness, no key needed → `200 alive` |
| `POST <base>/push` | One chunk of one run |

### Splitting

1. Serialise the payload once: `text = JSON.stringify(doc)`.
2. `checksum = sha256_hex(utf8(text))`.
3. Split `text` into consecutive slices of **at most 200 KB of UTF-8** each (the receiver
   refuses over 256 KiB; the platform fails bodies near 800 KB before the app runs). Split
   on character boundaries — never inside a UTF-16 surrogate pair or a UTF-8 sequence.
4. Pick a **run id**: 8–64 characters of `[A-Za-z0-9_-]`, new for every run (a UUID).

### Each chunk

```
POST <base>/push
Authorization: Bearer <AUTOMAP_KEY>          (or X-Automap-Key: <AUTOMAP_KEY>)
Content-Type: text/plain; charset=utf-8
X-Automap-Run: <run id>
X-Automap-Seq: <0, 1, 2, …>
X-Automap-Sender: python/1.0.0               (our senders; see below)
X-Automap-Part: 1/2                          (rules in parts only, on every chunk of the part; see "Parts")
X-Automap-Last: 1                            (on the final chunk only)
X-Automap-Sha256: <checksum>                 (final chunk: this, or X-Automap-Length, or both)
X-Automap-Length: <length>                   (final chunk, for senders that cannot hash)

<the slice, as is>
```

- **`X-Automap-Sender`** names a sender we publish and its version. Below the minimum the
  receiver answers `426 upgrade` before staging anything (src/push/senders.js); below the
  latest it is taken and the settings card says an update is out. Without the header, or
  with a name we do not publish, a push is taken unnamed.
- **No compression.** A gzip body cannot be recovered on the platform; it is refused
  (`400 bad-request`).
- **Strictly in order, one at a time.** Chunk *n* is refused (`409 conflict`) unless chunks
  0…*n*-1 of the same run are already in. Resending a chunk already received replaces it,
  so a chunk whose answer was lost can simply be sent again.
- **Chunk 0 starts (or restarts) the run**: it clears whatever that run had staged. It is
  also where the plan's load allowance is checked.
- **Proving the payload without a hash.** A sender with no SHA-256 (JMWE's Nunjucks) sends
  `X-Automap-Length` instead: the joined text's length in **UTF-16 code units** — what a
  JavaScript string's `length` says, so an emoji counts 2 — not in bytes. It catches a
  truncated payload and stripped line breaks, not a character swapped for another; senders
  that can hash should. Given both, both must match. Such a sender cannot escape to ASCII
  either, so it sends UTF-8 and must not end a chunk between the two halves of a surrogate
  pair.
- **The final chunk** carries `X-Automap-Last: 1` and the checksum (or the length). The receiver joins the
  chunks, compares the SHA-256, and queues the build. From then the run is closed: any
  further request with that run id is `409 conflict` — start a new run.

### Parts (receiver 2026-10-23)

A scheduled job inside Jira has a time limit, and reading more than a few hundred rules
one by one does not fit in it. So the rules may arrive in **parts**: several scheduled
copies of the job (ScriptRunner and JMWE 1.4.0, `PART=1/2` and `PART=2/2`, an hour apart),
each reading its share of the rules and pushing it as a complete rules document of its own,
with `X-Automap-Part: N/M` on every chunk. The receiver merges the parts into the one
document the build reads, and builds once.

- **Each part is a push.** Its own chunks from seq 0, its own proof on its last chunk, the
  same document shape - just fewer rules. A sender reuses its chunk code unchanged. `N/M`:
  `1 <= N <= M`, `2 <= M <= 20`, identical on every chunk of the part; anything else is
  `400 bad-request`, as is the header on usage or runs. `M` is the same on every part of
  the group (`409 conflict` otherwise).
- **One run id for the group.** Jobs that cannot talk to each other agree on it by the
  date: our senders use `d<YYYYMMDD>` in UTC (`d20261023`), stamped when the job starts,
  before the minutes of reading. So schedule the copies inside the same UTC day - e.g.
  01:00 and 02:00 UTC, not either side of 00:00 UTC - or they name different days and
  neither group completes. The receiver asks only that it is a run id.
- **Staged apart, built together.** Part N is staged under `push-<run>-p<N>`; chunk 0 of a
  part clears that part - a resent part replaces itself. The group's `builds` row,
  `push-<run>`, is opened by whichever part's chunk 0 comes first, and the load allowance is
  checked there once: the parts are **one load**. A part for a group whose build is already
  queued is `409 conflict`, as a reused run is. The group has a key of its own
  (`push_group:<run>`) and each proven part a mark of its own (`push_part:<run>:<n>`),
  and when a last chunk finds every mark in place it claims the merge with one conditional
  update of the group's row (`stage = 'merge'`): two parts finishing in the same instant
  both see every mark, exactly one wins the row and queues the merge, the other answers
  `accepted`. A group being merged takes no chunk (`409`) until its build is queued.
- **Answers.** The last chunk of a part is `202 accepted` while parts are missing, and
  `202 queued` when it completed the group. Parts may come in any order. A part whose proof
  fails is `422 checksum` and that part alone is dropped - the group and its other parts
  stay, and the sender sends the part again from chunk 0; the build is not failed.
- **The merge**, when the last missing part is in, runs on the app's queue, not in the
  request (a web trigger has 25 seconds; reading and writing a large site's parts is more):
  the rules of every part in part order, a rule carried by two parts kept once (the later
  part's copy - the job that ran later read the newer rule; by `uuid`, or `id` without
  one), `sender` from the part that completed the group, and `"parts": M` added. The
  document is written compact and ASCII under `push-<run>` in chunks of 200 KB, the parts'
  chunks go, and the build is queued exactly as for a plain push. The settings page says
  "merging them now" in between, then "in M parts". A merge the database let fail is tried
  three times; after that the row is open again, every part still in, and running any one
  job again (its last chunk completes the group once more) starts the merge over - the
  page says so.
- **24 hours.** A group still open a day after it began was abandoned (the other job
  never came). Whatever looks first - any part push, or the settings page - drops its
  parts' chunks and marks, fails its build row ("Not every part of this push arrived
  within a day, so nothing was loaded. The previous map is still in place."), and the
  card says so; the run id is closed from then on, as a failed run's is (`409`), and the
  next day's run opens a new group, a new load. Nothing sweeps in the background.

### Answers

Every answer is one of sixteen fixed bodies declared in the manifest; the receiver cannot
put anything else in a response (that is what keeps the app eligible for Runs on
Atlassian). Read the **status code**; the `error` word separates the two 429s.

| Status | `error` / meaning | What the sender does |
|---|---|---|
| 200 | `alive` | — |
| 202 | `{"accepted":true}` — chunk stored | send the next chunk |
| 202 | `{"accepted":true,"queued":true}` — final chunk, checksum good, build queued | done; the map rebuilds in a minute or two |
| 400 | `bad-request` — a header missing or malformed, `X-Automap-Seq` 400 or more (at most 400 chunks a run), empty or compressed body, `Last` without a checksum; for usage and runs also a joined body that is not JSON or not of its kind | fix the sender; do not retry as is |
| 401 | `unauthorized` — no key, wrong key, revoked key | stop; the administrator makes a new key |
| 402 | `inactive` — the subscription on this site has ended | stop |
| 403 | `disabled` — this installation does not take pushes: switched off, or the site is on Basic, where the map loads from an export file only (remembered as `plan` on the settings page) | stop |
| 404 / 405 | `not-found` / `method` | wrong URL or verb |
| 409 | `conflict` — out of order, unknown run, run already closed, `Last` sent early | start a **new run** from chunk 0 |
| 413 | `too-large` — chunk over 256 KiB | send smaller chunks |
| 426 | `upgrade` — this sender version is below the minimum | update the image or the script; exit 4 |
| 422 | `checksum` — the joined chunks do not match the SHA-256 or the length; the build is marked failed, nothing loaded, the previous map stays | start a new run; if it repeats, check for line breaks or a body altered in transit |
| 429 | `allowance` — the plan's loads are used up (Basic 7 in 7 days, Advanced 5 a day) | stop this run; the settings page says when the next load is possible. Schedule the sender within the allowance |
| 429 | `rate-limited` — over 300 requests to this installation in 10 minutes, counted before the key is checked, so with or without one | wait ten minutes, then start a new run |
| 500 | `failed` — the receiver could not store the chunk | retry the same chunk with backoff, then start a new run |

What actually happened — loaded, refused as another site's, failed — is shown on the
settings page (the card's "Last push" and the History tab), not in the answer.

## 5. How often

Once a day is the sensible default. Every push that builds counts as a load against the
plan, and a sender scheduled hourly on Basic will spend the week's allowance in seven hours
and then get `429 allowance` until the window moves. A sender may skip the push when
nothing changed: keep the last checksum and send only when it differs (the receiver does
not do this for you — every completed run is a build).

## 6. Security notes for the customer's reviewers

- The Atlassian token is used by the sender only, against `api.atlassian.com`, read-only
  (`GET` on summaries and rules). It is never sent to the app.
- The app's key is 32 random bytes; the app stores only its SHA-256 and compares in
  constant time. One key per site; a new key revokes the old one immediately.
- Every request is counted against the throttle before the key is read, so a caller that
  has the URL but not the key gets `401` up to the limit and `429 rate-limited` past it,
  like anyone else: guessing at the key cannot run unmetered.
- The receiver cannot return data: its responses are fixed in the manifest.
- Rule configurations can contain credentials typed into rules (and, per AUTO-2211, hidden
  header values). The sender passes them through TLS to the app, where the build replaces
  every recognised secret with a fingerprint before anything is parsed or stored.

## 6a. Usage (beta)

From sender 1.1.0 — every sender: Python and the image, Node.js, bash, PowerShell, ScriptRunner and JMWE (APPS-487) — a run also reads the site's **automation usage** — the
steps, Rovo credits and flow runs of the month, as Jira's own Usage tab shows them — and
pushes it as a **second, separate push**. The numbers come from an undocumented internal
Automation API ([automation-usage-api.md](automation-usage-api.md)) that only a personal
API token can read; Atlassian can change or close it without notice. So:

- **It never fails a run.** If the internal API answers anything but 200, the sender logs
  `usage (beta) skipped: …` and exits as it would have without it. The rules go first and
  do not wait for it. `AUTOMAP_USAGE=off` switches it off entirely.
- **Advanced only**, like every push: on Basic the receiver answers `403 disabled` and
  keeps nothing (the 403 row in section 4).
- **It spends no load.** A usage push is not a map: no build, no allowance, and it goes
  even when the rules were refused for the allowance.
- **The payload is ours, not Atlassian's.** The sender maps the internal names to the shape
  below, so a change on Atlassian's side is fixed in the senders. Account ids that the
  internal API returns (`actorAccountId`, `authorAccountId`) are dropped by the sender, and
  the receiver keeps only the fields below whatever arrives.

**Headers:** as any push, plus `X-Automap-Kind: usage`. Chunked like the rules (from senders
1.2.0, ScriptRunner and JMWE 1.3.0, APPS-499): `X-Automap-Seq` 0, 1, … in order, `X-Automap-Last: 1` and `X-Automap-Sha256`
(or `X-Automap-Length`) on the last; a small site is one chunk. One push of a kind at a time:
chunk 0 of a push in several chunks clears whatever any run of that kind left staged. Every rule goes, none is
dropped: Advanced keeps every rule Atlassian lists (10,000 at most). Answers: `202 accepted`
for a chunk, `202 queued` for the last, `409 conflict` for a chunk out of order, `400
bad-request` (not usage), `422 checksum`, and the key and rate answers of any push. The
last chunk checks the proof and the shape and queues the write (APPS-514): the text stays
staged for a `store-usage` job on the app's queue, which writes it within a minute and
deletes the stage. Chunk 0 of a newer usage push sweeps a stage whose job has not run; that
job then stores nothing and the newer one does. A month pushed again unchanged rewrites
no rule, only when it came and from whom.

**Body:**

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
  "creditPack":false},
 "sender":{"name":"python","version":"1.1.0"}}
```

`period` is Unix ms, UTC: the 1st of the month to now. In the first three days of a month
the sender also pushes the whole month before, so its final numbers land. `billable`,
`limits`, `trend` and `creditPack` are optional — the current billing model, and the part
of the internal API most likely to change. The app keeps one snapshot per month
(`src/usage/store.js`), the newest replacing the one before, and every month it has seen.

## 6b. Runs (beta)

From the same sender version, a run also reads the **audit log** of the last
`AUTOMAP_RUNS_DAYS` days (7) — the internal API behind Jira's Audit log tab
([automation-audit-log-api.md](automation-audit-log-api.md)) — folds it on the customer's
side and pushes it as a **third push**, `X-Automap-Kind: runs`, chunked like usage, with the same
rules as usage: never fails the run, spends no load, `AUTOMAP_RUNS=off` switches it off.

Inside Jira the two app-hosted senders come in two parts, each a job of its own with the
host's whole time limit: the rules (`AutomapSync.groovy`, `automap-sync.njk`) and the usage
and runs (`AutomapUsage.groovy`, `automap-usage.njk`, from 1.2.0), so a slow audit log never
holds up the rules. The usage part reads only yesterday and today by default (`AUTOMAP_RUNS_DAYS` 1, JMWE `RUNS_DAYS` 1)
and is scheduled every hour: the receiver replaces just the days a push covers and keeps 35, so
short hourly runs fill the history that one long run would not fit. They work within their host's limits. **ScriptRunner**
reads the audit log only while the job has time left (200 s of the run) and skips the runs,
rather than sending some days of them, when it does not fit — `AUTOMAP_RUNS_DAYS` lower is
the answer. **JMWE** takes its switches as template values (`USAGE`, `RUNS`, `RUNS_DAYS`),
reads at most `RUNS_MAX_PAGES` (60) pages of the audit log, proves each push by
`X-Automap-Length` as it does the rules, and sends usage and runs in chunks of 80 000
characters, every rule included.

What travels is counts and codes, nothing else: per rule and UTC day how many runs
succeeded, failed, did nothing (`NO_ACTIONS_PERFORMED`) or were edits (`CONFIG_CHANGE`),
the time spent; and for the rules that failed, up to two of their newest failed runs read in
full (at most 40 per push) reduced to the failing component's id, type and the error's i18n
key or code. No work-item ids, no message text (it can quote field values), no
`appendParameters`, no account ids — the sender drops them and the receiver keeps only the
fields below.

```json
{"runs":{
  "window":{"start":1791331200000,"end":1791991583000},
  "rows":[{"uuid":"019dd4aa-…","day":"2026-10-13","name":"MARKET: Licenses create",
           "success":10,"errors":30,"noop":0,"edits":1,"ms":1200000,"maxMs":31000,
           "hours":{"9":12,"14":28}}],
  "errors":[{"uuid":"019dd4aa-…","componentId":"5ce09150-…","componentType":"BRANCH",
             "type":"jira.smart.values.branch",
             "code":"com.codebarrel.automation.rule.error.smart.value.no.object","at":1791968400000}]},
 "sender":{"name":"python","version":"1.1.0"}}
```

`hours` is optional and sparse: runs (not edits) per UTC hour of that day, only the hours
that had any. It is what shows a burst - hundreds of runs inside one hour after a bulk
edit or an import - which a day's total hides. The window is whole UTC days and at most 31; a push replaces the days it covers and the app
keeps 35 days back (`src/usage/runs.js`). A push holds at most 20,000 rows a day and
100,000 in all (APPS-514); past the whole, the newest days are kept whole, the oldest
dropped, and the window starts at the first day kept, so the dropped days are not
replaced - the log says how many went. The write is a `store-runs` job on the queue, as
for usage: `202 queued` means staged and queued, written within a minute. On Advanced a day leaving the 35 is first added
to its month (`rule_runs_monthly`), kept 13 months, each day once however often a window is
pushed again; nothing about the push changes for it, and old senders feed it as they are.
The card shows a rule's runs over the last 30 days, the failing component in words and,
once a month is folded, its runs by month; the Usage tab lists the rules that fail most,
the ones that mostly do nothing, and the site's runs per month.

## 6c. Old senders keep working

A job is pasted once and runs for years, so every sender version ever released keeps
working against every later receiver. The minimum in `src/push/senders.js` stays `1.0.0`
for every sender. The receiver keeps taking every shape a released sender has sent: rules in
one chunk or many, proven by SHA-256 or by length; usage and runs in one chunk (1.1) or in
many (1.2+). A new feature may ask for a newer sender to *use* it; it never stops an older
one from doing what it did. Raising a minimum (the `426 upgrade` answer) or dropping a shape
is the owner's decision, made explicitly. The test "compatibility: …" in
`test/push-sync.test.mjs` lists every released version and fails if either happens; add a
version there when it ships.

## 7. Reference senders

Six, in [`senders/`](.) — Python (the one in the Docker image), Node, bash,
PowerShell, ScriptRunner for Jira Cloud and JMWE (a Nunjucks template, proven by length,
run locally by `senders/jmwe/test/run-locally.mjs` with the real nunjucks engine) — with the
same payload; [`senders/README.md`](README.md) is what a customer reads.
`npm run test:senders` runs each against a fake Automation API and a fake receiver
([`senders/test/fake-site.mjs`](test/fake-site.mjs)). Source-available under
[`senders/LICENSE`](LICENSE): readable for audit, usable only with this app.

A smoke test by hand, for a tiny payload in one chunk:

```bash
BODY='{"rules":[]}'
SUM=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
curl -sS -X POST "$AUTOMAP_URL" \
  -H "Authorization: Bearer $AUTOMAP_KEY" -H 'Content-Type: text/plain; charset=utf-8' \
  -H "X-Automap-Run: smoke-$(date +%s)" -H 'X-Automap-Seq: 0' \
  -H 'X-Automap-Last: 1' -H "X-Automap-Sha256: $SUM" \
  --data-binary "$BODY" -w '\n%{http_code}\n'
```

An empty rule list is accepted by the receiver (`202 queued`) and then fails the build as
an unrecognised file — enough to prove the key, the URL and the checksum, and it does not
count against the allowance (only finished builds do).
