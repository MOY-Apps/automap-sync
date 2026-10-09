# automap-sync — push your Jira automation rules to Automation Map

Automation Map cannot read your automation rules by itself: Atlassian's Automation API
accepts only a personal API token, and a Marketplace app is not allowed to hold one. So a
small job on **your** side reads the rules with **your** token and pushes them to the app.
The token never leaves your infrastructure; the app only ever sees a key it issued
(`amk_…`). The protocol is in [`docs/push-sync.md`](../docs/push-sync.md).

## Pick one

| Sender | Runs on | Needs | Use it when |
|---|---|---|---|
| **Docker image** `ghcr.io/moy-apps/automap-sync:1` | CI, Kubernetes, any host with Docker | Docker | the default — nothing to install, signed, updated by tag |
| [`python/automap_sync.py`](python/automap_sync.py) | Linux, macOS, Windows | Python 3.8+, nothing else | a server with cron; the image runs this file |
| [`node/automap-sync.mjs`](node/automap-sync.mjs) | anywhere | Node 18+, nothing else | your tooling is JavaScript |
| [`bash/automap-sync.sh`](bash/automap-sync.sh) | Linux, macOS | bash 3.2+, curl, jq 1.6+ | a minimal box with no Python |
| [`powershell/automap-sync.ps1`](powershell/automap-sync.ps1) | Windows, Linux, macOS | PowerShell 7.2+ | a Windows estate, Task Scheduler |
| [`scriptrunner/AutomapSync.groovy`](scriptrunner/AutomapSync.groovy) | inside Jira | ScriptRunner for Jira Cloud | you already have ScriptRunner and a small site (see its limits) |

All of them read the same settings, send the same thing and exit the same way.

## Settings

| Variable | |
|---|---|
| `ATLASSIAN_SITE` | `your-site.atlassian.net` (or `ATLASSIAN_CLOUD_ID` instead) |
| `ATLASSIAN_EMAIL` | the account the token belongs to — a Jira administrator; a service account is best |
| `ATLASSIAN_API_TOKEN` | an API token **with the Automation scope** (id.atlassian.com → Security → API tokens) |
| `AUTOMAP_URL` | Jira settings → Apps → Automation Map → Data → *Automatic sync from your side* → Receiver |
| `AUTOMAP_KEY` | the same card → **Make a key** (shown once) |
| `AUTOMAP_CHUNK_BYTES` | optional, default `200000` |

`--dry-run` (PowerShell: `-DryRun`; ScriptRunner: `AUTOMAP_DRY_RUN=1`) reads everything and
pushes nothing — a safe first test of the Atlassian side.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | pushed; the map rebuilds in a minute or two (or a dry run finished) | — |
| 2 | a setting is missing | set it |
| 3 | the Automation API refused or failed (401 token/scope, 403 not an administrator) | fix the token or the account |
| 4 | the receiver refused: wrong or revoked key, subscription ended, sync not switched on, sender too old (`upgrade`) | fix it; retrying will not help |
| 5 | try later: the plan's load allowance is used up, or too many requests | run less often |
| 6 | failed after retries | run again; if it repeats, contact us with the log |

The log has counts and status words only — never a token, a key or a rule.

## Schedule

Once a day is right for almost everyone. Each push that loads counts against the plan's
loads (Basic 7 in 7 days, Advanced 5 a day); a sender scheduled more often gets exit 5.

- **GitHub Actions** — [`ci/github-actions.yml`](ci/github-actions.yml)
- **GitLab CI** — [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml)
- **Kubernetes** — [`ci/kubernetes-cronjob.yml`](ci/kubernetes-cronjob.yml)
- **cron** — `17 3 * * * docker run --rm --pull always --env-file /etc/automap-sync.env ghcr.io/moy-apps/automap-sync:1`
- **Windows** — Task Scheduler: `pwsh -NoProfile -File C:\automap\automap-sync.ps1`, with the variables set for the task's account
- **ScriptRunner** — Scheduled Jobs, daily, the script pasted in, the variables in Script Variables

## Updates

- The image tag `:1` always points at the newest compatible release; `--pull always` (or
  `imagePullPolicy: Always`) picks it up on the next run. Pin `:1.0.0` or a digest if you
  update through Renovate/Dependabot instead.
- Every sender sends its version (`X-Automap-Sender: python/1.0.0`). The settings card
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
