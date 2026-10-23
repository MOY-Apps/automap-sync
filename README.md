# automap-sync — push your Jira automation rules to Automation Map

Automation Map cannot read your automation rules by itself: Atlassian's Automation API
accepts only a personal API token, and a Marketplace app is not allowed to hold one. So a
small job on **your** side reads the rules with **your** token and pushes them to the app.
The token never leaves your infrastructure; the app only ever sees a key it issued
(`amk_…`). The protocol is in [`PROTOCOL.md`](PROTOCOL.md).

Writing your own sender, in another language? See the API reference, [`API.md`](API.md), and
the OpenAPI 3.1 spec, [`openapi.json`](openapi.json).

## Pick one

| Sender | Runs on | Needs | Use it when |
|---|---|---|---|
| **Docker image** `ghcr.io/moy-apps/automap-sync:1` | CI, Kubernetes, any host with Docker | Docker | the default — nothing to install, signed, updated by tag |
| [`python/automap_sync.py`](python/automap_sync.py) | Linux, macOS, Windows | Python 3.8+, nothing else | a server with cron; the image runs this file |
| [`node/automap-sync.mjs`](node/automap-sync.mjs) | anywhere | Node 18+, nothing else | your tooling is JavaScript |
| [`bash/automap-sync.sh`](bash/automap-sync.sh) | Linux, macOS | bash 3.2+, curl, jq 1.6+ | a minimal box with no Python |
| [`powershell/automap-sync.ps1`](powershell/automap-sync.ps1) | Windows, Linux, macOS | PowerShell 7.2+ | a Windows estate, Task Scheduler |
| [`scriptrunner/AutomapSync.groovy`](scriptrunner/AutomapSync.groovy) + [`AutomapUsage.groovy`](scriptrunner/AutomapUsage.groovy) | inside Jira | ScriptRunner for Jira Cloud, two Scheduled Jobs: the rules, and the usage and runs | you already have ScriptRunner and a small site (see its limits) |
| [`jmwe/automap-sync.njk`](jmwe/automap-sync.njk) + [`automap-usage.njk`](jmwe/automap-usage.njk) | inside Jira | JMWE for Jira Cloud (Nunjucks templates in two Scheduled actions: the rules, and the usage and runs) | you already have JMWE and a small site; the token sits in the template, the payload is proven by length |

All of them read the same settings, send the same thing and exit the same way.

## Settings

| Variable | |
|---|---|
| `ATLASSIAN_SITE` | `your-site.atlassian.net` (or `ATLASSIAN_CLOUD_ID` instead). Not needed in ScriptRunner: it uses the site it runs in |
| `ATLASSIAN_EMAIL` | the account the token belongs to — a Jira administrator; a service account is best |
| `ATLASSIAN_API_TOKEN` | an API token **with the Automation scope** (id.atlassian.com → Security → API tokens) |
| `AUTOMAP_URL` | Jira settings → Apps → Automation Map → Data → *Push from your side* → **Set up**: the guide shows the receiver URL |
| `AUTOMAP_KEY` | the same guide makes it the moment a tool is picked, and shows it once |
| `AUTOMAP_CHUNK_BYTES` | optional, default `200000` |
| `PART` | ScriptRunner and JMWE only (1.4.0), optional: `1/2` and `2/2` on two scheduled copies of the rules job, each pushing its slice; for a site past the host's time limit. Empty = all in one. A rule's slice follows from its own id (1.5.0), so the slices are roughly, not exactly, equal |

`--dry-run` (PowerShell: `-DryRun`; ScriptRunner: `AUTOMAP_DRY_RUN=1`) reads everything and
pushes nothing — a safe first test of the Atlassian side.

## Usage and runs (beta, every sender from 1.1.0)

On the Advanced edition every sender also pushes two things after the rules, each as a
separate push:

- **Usage**: this month's steps, Rovo credits and flow runs per rule, read from the same
  API Jira's *Usage* tab uses. Account ids it returns are dropped.
- **Runs**: the audit log of the last `AUTOMAP_RUNS_DAYS` days (default 7, at most 30),
  folded on your side into per-rule, per-day counts, plus the failing component and the
  error's code for the rules that failed. No issue ids, no message text, no account ids.

From 1.2.0 (ScriptRunner and JMWE 1.3.0) both go in chunks like the rules, so a large site
sends every rule, not only the busiest. From 1.3.0 (ScriptRunner and JMWE 1.5.0) the audit
log is read up to the instant the sender started, so runs landing while it reads shift no
page, and the internal API is retried on 429 and 5xx like the Automation API. Python,
Node.js, bash and PowerShell read at most 50,000 audit records (1,000 pages); past that
the oldest day read is not whole, so it is dropped and the window shortened - the log says
so, and `AUTOMAP_RUNS_DAYS` lower keeps the window whole.

Both read an internal Atlassian API that is not documented and can change. If either
fails, the rules are pushed anyway and the run still succeeds. `AUTOMAP_USAGE=off` and
`AUTOMAP_RUNS=off` switch them off; in JMWE they are the template values `USAGE` and
`RUNS`. Inside Jira they are a job of their own (`AutomapUsage.groovy`, `automap-usage.njk`),
so the rules job keeps the host's whole time limit. ScriptRunner reads the audit log only while its run has time left, and JMWE reads
at most `RUNS_MAX_PAGES` pages of it: past that the runs are skipped, not sent in part, and
`AUTOMAP_RUNS_DAYS` (JMWE: `RUNS_DAYS`) lower is the fix. Inside Jira the usage job runs every hour and,
from ScriptRunner and JMWE 1.6.0, each run pushes the previous full UTC hour as a slice the map adds to the
day and takes once (`AUTOMAP_RUNS_MODE` / `RUNS_MODE` = `slice`, the default; `days` is the earlier
behaviour, `AUTOMAP_RUNS_DAYS` whole days, 1 = yesterday and today). An hour the job missed stays out,
so run one copy, every hour. The map keeps 35 days of what they bring.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | pushed; the map rebuilds in a minute or two (or a dry run finished) | — |
| 2 | a setting is missing | set it |
| 3 | the Automation API refused or failed (401 token/scope, 403 not an administrator) | fix the token or the account |
| 4 | the receiver refused: wrong or revoked key, subscription ended, sync not switched on, sender too old (`upgrade`) | fix it; retrying will not help |
| 5 | try later: the plan's load allowance is used up, or too many requests | run less often |
| 6 | failed after retries | run again; if it repeats, contact us with the log |

The log has counts and status words only — never a token, a key or a rule. A sender that
sent its last chunk and never heard back sends it again; a `409` to that resend means the
receiver took the first copy, and the sender exits 0 saying so (from 1.3.0, ScriptRunner
and JMWE 1.5.0) rather than loading the day's rules a second time.

## Schedule

Once a day is right for almost everyone. On the Marketplace app each push that loads
counts against the plan's loads (Basic 7 in 7 days, Advanced 5 a day); on Automation Map
Enterprise a new push may start an hour after the last one. A sender scheduled more often
gets exit 5.

- **GitHub Actions** — [`ci/github-actions.yml`](ci/github-actions.yml)
- **GitLab CI** — [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml)
- **Kubernetes** — [`ci/kubernetes-cronjob.yml`](ci/kubernetes-cronjob.yml)
- **cron** — `17 3 * * * docker run --rm --pull always --env-file /etc/automap-sync.env ghcr.io/moy-apps/automap-sync:1`
- **Windows** — Task Scheduler: `pwsh -NoProfile -File C:\automap\automap-sync.ps1`, with the variables set for the task's account
- **ScriptRunner** — two Scheduled Jobs: `AutomapSync.groovy` (the rules) daily, `AutomapUsage.groovy` (usage and runs) every hour; the variables in Script Variables, shared
- **JMWE** — two Scheduled actions on one anchor work item: `automap-sync.njk` and `automap-usage.njk`, both filled with the same values; the usage one every hour

## Updates

- The image tag `:1` always points at the newest compatible release; `--pull always` (or
  `imagePullPolicy: Always`) picks it up on the next run. Pin `:1.3.0` or a digest if you
  update through Renovate/Dependabot instead. The image's tags are the **Python sender's
  version** inside it - what the receiver sees as `python/1.3.0` - not the repository's
  tag, which also counts the in-Jira senders (1.5.0).
- Every sender sends its version (`X-Automap-Sender: python/1.2.0`). The settings card
  says when a newer one is out. If a version is ever too old for the protocol, the
  receiver answers `426 upgrade` and the sender exits 4 with a message saying so — a
  scheduled job stops loudly instead of loading something wrong.
- Nothing updates itself. A sender that downloads code at run time is exactly what a
  security review should refuse.

## Security notes for your reviewers

- Read-only on the Atlassian side: `GET` on the rule list and on each rule.
- The Atlassian token is sent only to `api.atlassian.com` (Basic auth). The bash sender
  passes it to curl through a file, not the command line.
- The app's key goes only to the receiver URL. The app stores its SHA-256, not the key.
- Rule configurations can hold credentials typed into rules. They travel over TLS to the
  app, which replaces every one it recognises with a fingerprint before parsing or storing.
- The receiver cannot return data: its answers are fixed in the app's manifest.

## Testing the senders (for us)

`npm run test:senders` starts a fake Automation API and a fake receiver
([`test/fake-site.mjs`](test/fake-site.mjs)) and runs every sender against them: paging,
a 429 on the API, a 500 on the receiver, non-ASCII rule names, a wrong key, an exhausted
allowance and a dry run. A sender whose runtime is not on the machine is skipped and says
so; PowerShell and Groovy fall back to Docker when Docker can run containers.

## Licence

Source-available, not open source: read it, audit it, run it with Automation Map. See
[`LICENSE`](LICENSE).
