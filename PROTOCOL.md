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
receiver"; this page is what a sender must do.

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

### Answers

Every answer is one of sixteen fixed bodies declared in the manifest; the receiver cannot
put anything else in a response (that is what keeps the app eligible for Runs on
Atlassian). Read the **status code**; the `error` word separates the two 429s.

| Status | `error` / meaning | What the sender does |
|---|---|---|
| 200 | `alive` | — |
| 202 | `{"accepted":true}` — chunk stored | send the next chunk |
| 202 | `{"accepted":true,"queued":true}` — final chunk, checksum good, build queued | done; the map rebuilds in a minute or two |
| 400 | `bad-request` — a header missing or malformed, empty or compressed body, `Last` without a checksum | fix the sender; do not retry as is |
| 401 | `unauthorized` — no key, wrong key, revoked key | stop; the administrator makes a new key |
| 402 | `inactive` — the subscription on this site has ended | stop |
| 403 | `disabled` — this installation does not take pushes | stop |
| 404 / 405 | `not-found` / `method` | wrong URL or verb |
| 409 | `conflict` — out of order, unknown run, run already closed, `Last` sent early | start a **new run** from chunk 0 |
| 413 | `too-large` — chunk over 256 KiB | send smaller chunks |
| 426 | `upgrade` — this sender version is below the minimum | update the image or the script; exit 4 |
| 422 | `checksum` — the joined chunks do not match the SHA-256 or the length; the build is marked failed, nothing loaded, the previous map stays | start a new run; if it repeats, check for line breaks or a body altered in transit |
| 429 | `allowance` — the plan's loads are used up (Basic 7 in 7 days, Advanced 5 a day) | stop this run; the settings page says when the next load is possible. Schedule the sender within the allowance |
| 429 | `rate-limited` — over 300 requests per key in 10 minutes | wait ten minutes, then start a new run |
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
- The receiver cannot return data: its responses are fixed in the manifest.
- Rule configurations can contain credentials typed into rules (and, per AUTO-2211, hidden
  header values). The sender passes them through TLS to the app, where the build replaces
  every recognised secret with a fingerprint before anything is parsed or stored.

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
