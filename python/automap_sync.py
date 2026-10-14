#!/usr/bin/env python3
"""automap-sync (Python) - push this site's automation rules to Automation Map.

Reads every automation rule with YOUR Atlassian API token (it never leaves this
machine), and pushes them to the Automation Map push receiver with the key the app
issued. Standard library only; Python 3.8+. Contract: docs/push-sync.md.

Environment
  ATLASSIAN_SITE        your-site.atlassian.net (or set ATLASSIAN_CLOUD_ID instead)
  ATLASSIAN_EMAIL       the account the token belongs to (a Jira administrator)
  ATLASSIAN_API_TOKEN   an API token with the Automation scope
  AUTOMAP_URL           the receiver URL from the app's settings, ending /v1/push
  AUTOMAP_KEY           the amk_... key from the app's settings
  optional: ATLASSIAN_CLOUD_ID, AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE,
            AUTOMAP_USAGE=off (do not read or push automation usage)
            AUTOMAP_RUNS=off (do not read or push the audit log), AUTOMAP_RUNS_DAYS (7)

Automation usage (BETA, from 1.1.0): after the rules, the steps, Rovo credits and flow runs
of the month are read from the same internal API Jira's Usage tab uses, and pushed as a
second, separate push. That API is undocumented and can change; if it fails, the rules are
pushed anyway and the run still succeeds. Account ids it returns are dropped here.

Rule runs (BETA, from 1.1.0): the audit log of the last AUTOMAP_RUNS_DAYS days, folded here
into per-rule, per-day counts (success / errors / nothing done / edits, time spent) plus, for
the rules that failed, which component failed and the error's code - read from the same
internal API as Jira's Audit log tab and pushed as a third push. Only codes travel: no
issue ids, no message text (it can quote field values), no account ids.

Usage:  python3 automap_sync.py [--dry-run]

Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
receiver (fix something, do not retry), 5 try later (allowance or rate limit), 6 failed.

Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
"""
import base64
import calendar
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

NAME = "python"
VERSION = "1.1.0"
UA = f"automap-sync-{NAME}/{VERSION}"

EXIT_CONFIG, EXIT_ATLASSIAN, EXIT_REFUSED, EXIT_LATER, EXIT_FAILED = 2, 3, 4, 5, 6
REFUSED = {400, 401, 402, 403, 404, 405, 413, 426}


class Stop(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def log(message):
    print(f"automap-sync {NAME} {VERSION}: {message}", file=sys.stderr, flush=True)


def env(name, default=None, required=True):
    value = os.environ.get(name, default)
    if required and not value:
        raise Stop(EXIT_CONFIG, f"{name} is not set")
    return value


def request(method, url, headers=None, body=None, timeout=60):
    """(status, headers, bytes) for any answer, including 4xx/5xx; raises on no answer."""
    req = urllib.request.Request(url, data=body, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


class Atlassian:
    def __init__(self):
        self.email = env("ATLASSIAN_EMAIL")
        token = env("ATLASSIAN_API_TOKEN")
        self.auth = "Basic " + base64.b64encode(f"{self.email}:{token}".encode()).decode()
        self.api = env("ATLASSIAN_API_BASE", "https://api.atlassian.com").rstrip("/")
        self.cloud = os.environ.get("ATLASSIAN_CLOUD_ID") or self.cloud_id(env("ATLASSIAN_SITE"))
        self.base = f"{self.api}/automation/public/jira/{self.cloud}/rest/v1"

    @staticmethod
    def cloud_id(site):
        site = site if "://" in site else f"https://{site}"
        status, _, body = request("GET", site.rstrip("/") + "/_edge/tenant_info")
        if status != 200:
            raise Stop(EXIT_ATLASSIAN, f"could not read the cloud id of {site} (HTTP {status})")
        return json.loads(body)["cloudId"]

    def get(self, path):
        """GET with retries on 429/5xx and network trouble; the decoded JSON."""
        wait = 1.0
        for attempt in range(1, 6):
            try:
                status, headers, body = request("GET", self.base + path,
                                                {"Authorization": self.auth, "Accept": "application/json"})
            except OSError as err:
                status, headers, body = None, {}, str(err).encode()
            if status == 200:
                return json.loads(body)
            if status == 401:
                raise Stop(EXIT_ATLASSIAN, "the Automation API rejected the token (401): it must be an API "
                                           "token with the Automation scope, for this e-mail")
            if status == 403:
                raise Stop(EXIT_ATLASSIAN, "the Automation API refused access (403): the account must be a "
                                           "Jira administrator")
            if (status is None or status == 429 or status >= 500) and attempt < 5:
                retry_after = headers.get("Retry-After") if headers else None
                time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else wait + random.random() / 2)
                wait = min(wait * 2, 15)
                continue
            raise Stop(EXIT_ATLASSIAN, f"the Automation API answered {status} for {path.split('?')[0]}")
        raise Stop(EXIT_ATLASSIAN, "gave up on the Automation API")

    def rules(self):
        ids, seen, cursor, pages = [], set(), None, 0
        while True:
            params = {"limit": "100"}
            if cursor:
                params["cursor"] = cursor
            page = self.get("/rule/summary?" + urllib.parse.urlencode(params))
            pages += 1
            for item in page.get("data") or []:
                rid = item.get("id") or item.get("uuid")
                if rid and rid not in seen:
                    seen.add(rid)
                    ids.append(rid)
            nxt = (page.get("links") or {}).get("next")
            cursor = urllib.parse.parse_qs(urllib.parse.urlparse(nxt).query).get("cursor", [None])[0] if nxt else None
            if not cursor:
                break
        log(f"{len(ids)} rules listed in {pages} page(s)")
        out = []
        for rid in ids:
            detail = self.get("/rule/" + urllib.parse.quote(str(rid), safe=""))
            out.append({"rule": detail.get("rule", detail) if isinstance(detail, dict) else detail})
        return out


class Usage:
    """Automation usage (BETA) from the internal API behind Jira's Usage tab.

    Undocumented: every failure here is a reason to skip usage, never to fail the run.
    Mapped to the receiver's own shape (docs/push-sync.md, "Usage"), so a change on
    Atlassian's side is fixed in the senders. Account ids are not copied.
    """

    def __init__(self, atlassian):
        self.a = atlassian
        self.base = f"{atlassian.api}/automation/internal-api/jira/{atlassian.cloud}/pro/rest/GLOBAL/"

    def get(self, path):
        status, _, body = request("GET", self.base + path, {"Authorization": self.a.auth, "Accept": "application/json"})
        if status != 200:
            raise ValueError(f"{path.split('?')[0]} answered {status}")
        return json.loads(body)

    def flows(self, start, end):
        by_rule = {}
        # sortBy also filters to rules with that metric above zero: read both and merge
        for sort_by in ("automationCredits", "rovoCredits"):
            seen, page = 0, 0
            while page < 100:
                r = self.get(f"highUsageFlows?limit=100&page={page}&sortBy={sort_by}&startTime={start}&endTime={end}")
                for f in r.get("flows") or []:
                    if f.get("ruleUuid"):
                        by_rule[f["ruleUuid"]] = {
                            "uuid": f["ruleUuid"], "name": f.get("ruleName") or "", "state": f.get("state") or "ENABLED",
                            "runs": f.get("runs") or 0, "steps": f.get("automationCredits") or 0,
                            "rovo": f.get("rovoCredits") or 0, "deleted": bool(f.get("deleted")),
                            "agentic": bool(f.get("containsAgentic")),
                        }
                seen += len(r.get("flows") or [])
                if not r.get("flows") or seen >= (r.get("totalCount") or 0):
                    break
                page += 1
        return list(by_rule.values())

    def month(self, start, end, month):
        credit = self.get(f"creditUsage?startTime={start}&endTime={end}")
        pair = lambda c: {"total": (c or {}).get("total") or 0, "jira": (c or {}).get("currentProduct") or 0,
                          "other": (c or {}).get("everywhereElse") or 0}
        out = {"period": {"start": start, "end": end}, "steps": pair(credit.get("automation")),
               "rovo": pair(credit.get("rovo")), "flows": self.flows(start, end)}
        # the rest is the current billing model, and the least stable part: each piece optional
        try:
            top = self.get(f"highestUsages?limit=100&month={month}")
            out["billable"] = {"month": month, "rules": [{"uuid": t.get("ruleIdUuid"), "runs": t.get("executionCount") or 0}
                                                         for t in top if t.get("ruleIdUuid")]}
        except (ValueError, OSError):
            pass
        try:
            ws = ((self.get("pagecontext").get("tenantPageContext") or {}).get("usage") or {}).get("workspaceUsages") or {}
            out["limits"] = [{"product": k, "used": v.get("executionsUsed") or 0, "limit": v.get("executionLimit") or 0,
                              "edition": v.get("edition") or ""} for k, v in ws.items()]
        except (ValueError, OSError, AttributeError):
            pass
        try:
            out["trend"] = [{"month": t.get("month"), "runs": t.get("workspaceCounts") or {}}
                            for t in self.get("usageTrendData").get("data") or []]
        except (ValueError, OSError, AttributeError):
            pass
        try:
            out["creditPack"] = bool(self.get("hasCreditPack").get("hasCreditPack"))
        except (ValueError, OSError, AttributeError):
            pass
        return out

    def periods(self, now_ms):
        """This month so far; and in its first three days the whole of the month before."""
        now = time.gmtime(now_ms / 1000)
        start = int(calendar.timegm((now.tm_year, now.tm_mon, 1, 0, 0, 0)) * 1000)
        out = [(start, now_ms, f"{now.tm_year:04d}-{now.tm_mon:02d}")]
        if now.tm_mday <= 3:
            y, m = (now.tm_year, now.tm_mon - 1) if now.tm_mon > 1 else (now.tm_year - 1, 12)
            out.insert(0, (int(calendar.timegm((y, m, 1, 0, 0, 0)) * 1000), start - 1, f"{y:04d}-{m:02d}"))
        return out


class Runs:
    """The audit log (BETA), folded into what the map needs. Undocumented, like Usage."""

    MAX_DETAILS = 40          # one request per failed run read in full; two per rule at most

    def __init__(self, atlassian):
        self.a = atlassian
        self.base = f"{atlassian.api}/automation/internal-api/jira/{atlassian.cloud}/pro/rest/GLOBAL/"

    def call(self, path, body=None):
        headers = {"Authorization": self.a.auth, "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        for attempt in range(1, 4):
            try:
                status, _, raw = request("POST" if body is not None else "GET", self.base + path, headers, data)
            except OSError:
                status, raw = None, b""
            if status == 200:
                return json.loads(raw)
            if status not in (None, 429) and status < 500:
                break
            time.sleep(2 * attempt)
        raise ValueError(f"{path.split('?')[0]} answered {status}")

    @staticmethod
    def day(ms):
        return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))

    def read(self, days, now_ms):
        start = now_ms - days * 86400000
        start -= start % 86400000          # whole days, so a day pushed is a day complete
        records, offset = [], 0
        while offset < 50000:              # 50 a page whatever is asked; `total` is always 0
            page = (self.call("auditlog", {"fromTime": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(start / 1000)),
                                           "offset": offset, "limit": 50}).get("items") or {}).get("items") or []
            records += page
            if len(page) < 50:
                break
            offset += 50
        rows = {}
        failed = {}
        for r in records:
            u = r.get("ruleIdUuid")
            t = r.get("eventTimestamp") or r.get("startTime")
            if not u or not t or t < start:
                continue
            key = (u, self.day(t))
            row = rows.setdefault(key, {"uuid": u, "day": key[1], "name": r.get("ruleName") or "",
                                        "success": 0, "errors": 0, "noop": 0, "edits": 0, "ms": 0, "maxMs": 0})
            cat = r.get("category")
            if cat == "CONFIG_CHANGE":
                row["edits"] += 1
                continue
            row["success" if cat == "SUCCESS" else "noop" if cat == "NO_ACTIONS_PERFORMED" else "errors"] += 1
            ms = r.get("durationMs") or 0
            row["ms"] += ms
            row["maxMs"] = max(row["maxMs"], ms)
            if cat not in ("SUCCESS", "NO_ACTIONS_PERFORMED") and r.get("id"):
                failed.setdefault(u, []).append(r)
        errors, budget = [], self.MAX_DETAILS
        for u, runs in failed.items():
            for r in sorted(runs, key=lambda x: -(x.get("eventTimestamp") or 0))[:2]:
                if budget <= 0:
                    break
                budget -= 1
                try:
                    detail = self.call(f"auditlog/item/{r['id']}")
                except (ValueError, OSError):
                    continue
                for cl in (detail.get("content") or {}).get("componentLogs") or []:
                    res = cl.get("executionResult") or {}
                    keys = [((ch.get("payload") or {}).get("key") or "") for ch in cl.get("changes") or []
                            if (ch.get("payload") or {}).get("type") == "ERROR"]
                    code = (keys[0] if keys else "") or res.get("auditEventErrorType") or res.get("errorType") or ""
                    if not code and res.get("state") != "SOME_ERRORS":
                        continue
                    comp = cl.get("component") or {}
                    errors.append({"uuid": u, "componentId": comp.get("id") or "", "componentType": comp.get("componentType") or "",
                                   "type": comp.get("type") or "", "code": code or "SOME_ERRORS",
                                   "at": r.get("eventTimestamp") or 0})
        return {"window": {"start": start, "end": now_ms}, "rows": list(rows.values()), "errors": errors}


def push_runs(atlassian, dry_run):
    """Read the audit log and push it folded; a failure is logged and the run goes on."""
    if os.environ.get("AUTOMAP_RUNS", "").lower() in ("off", "0", "false", "no"):
        return
    try:
        days = max(1, min(30, int(os.environ.get("AUTOMAP_RUNS_DAYS") or 7)))
        runs = Runs(atlassian).read(days, int(time.time() * 1000))
        doc = {"runs": runs, "sender": {"name": NAME, "version": VERSION}}
        payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=True)
        while len(payload) > 250000 and runs["rows"]:
            runs["rows"] = sorted(runs["rows"], key=lambda x: -(x["success"] + x["errors"] + x["noop"]))[: len(runs["rows"]) * 3 // 4]
            payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=True)
        total = sum(x["success"] + x["errors"] + x["noop"] for x in runs["rows"])
        failed = sum(x["errors"] for x in runs["rows"])
        if dry_run:
            log(f"runs (beta) last {days} days: {total} runs, {failed} with errors; nothing pushed")
            return
        data = payload.encode("ascii")
        status, _, body = request("POST", env("AUTOMAP_URL"), {
            "Authorization": f"Bearer {env('AUTOMAP_KEY')}", "Content-Type": "text/plain; charset=utf-8",
            "X-Automap-Run": uuid.uuid4().hex, "X-Automap-Seq": "0", "X-Automap-Last": "1",
            "X-Automap-Sha256": hashlib.sha256(data).hexdigest(), "X-Automap-Sender": f"{NAME}/{VERSION}",
            "X-Automap-Kind": "runs",
        }, data)
        if status == 202:
            log(f"runs (beta) last {days} days: pushed {total} runs, {failed} with errors")
        else:
            log(f"runs (beta): not taken, receiver answered {status} {_word(body)}")
    except (ValueError, OSError, KeyError, TypeError) as err:
        log(f"runs (beta) skipped: {err}")


def push_usage(atlassian, dry_run):
    """Read and push the usage; a failure is logged and the run goes on."""
    if os.environ.get("AUTOMAP_USAGE", "").lower() in ("off", "0", "false", "no"):
        return
    try:
        u = Usage(atlassian)
        for start, end, month in u.periods(int(time.time() * 1000)):
            doc = {"usage": u.month(start, end, month), "sender": {"name": NAME, "version": VERSION}}
            payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=True)
            # one chunk: keep the busiest rules if a huge site does not fit
            while len(payload) > 250000 and doc["usage"]["flows"]:
                doc["usage"]["flows"] = sorted(doc["usage"]["flows"], key=lambda f: -f["steps"])[: len(doc["usage"]["flows"]) * 3 // 4]
                payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=True)
            steps, rules = doc["usage"]["steps"]["total"], len(doc["usage"]["flows"])
            if dry_run:
                log(f"usage (beta) {month}: {steps} steps, {rules} rules with usage; nothing pushed")
                continue
            data = payload.encode("ascii")
            status, _, body = request("POST", env("AUTOMAP_URL"), {
                "Authorization": f"Bearer {env('AUTOMAP_KEY')}", "Content-Type": "text/plain; charset=utf-8",
                "X-Automap-Run": uuid.uuid4().hex, "X-Automap-Seq": "0", "X-Automap-Last": "1",
                "X-Automap-Sha256": hashlib.sha256(data).hexdigest(), "X-Automap-Sender": f"{NAME}/{VERSION}",
                "X-Automap-Kind": "usage",
            }, data)
            if status == 202:
                log(f"usage (beta) {month}: pushed {steps} steps for {rules} rules")
            else:
                log(f"usage (beta) {month}: not taken, receiver answered {status} {_word(body)}")
    except (ValueError, OSError, KeyError, TypeError) as err:
        log(f"usage (beta) skipped: {err}")


def push(payload, dry_run):
    data = payload.encode("ascii")
    checksum = hashlib.sha256(data).hexdigest()
    size = int(env("AUTOMAP_CHUNK_BYTES", "200000"))
    chunks = [data[i:i + size] for i in range(0, len(data), size)] or [b""]
    if dry_run:
        log(f"dry run: {len(data)} bytes in {len(chunks)} chunk(s), sha256 {checksum}; nothing pushed")
        return
    url, key = env("AUTOMAP_URL"), env("AUTOMAP_KEY")

    for attempt in (1, 2):
        run = uuid.uuid4().hex
        restart = False
        for seq, chunk in enumerate(chunks):
            headers = {
                "Authorization": f"Bearer {key}",
                "Content-Type": "text/plain; charset=utf-8",
                "X-Automap-Run": run,
                "X-Automap-Seq": str(seq),
                "X-Automap-Sender": f"{NAME}/{VERSION}",
            }
            if seq == len(chunks) - 1:
                headers["X-Automap-Last"] = "1"
                headers["X-Automap-Sha256"] = checksum
            for tries in range(1, 4):
                try:
                    status, _, body = request("POST", url, headers, chunk)
                except OSError as err:
                    status, body = None, str(err).encode()
                if status == 202 or status in REFUSED or status in (409, 422, 429) or tries == 3:
                    break
                time.sleep(2 ** tries)
            word = _word(body)
            if status == 202:
                continue
            if status in (409, 422) and attempt == 1:
                log(f"receiver answered {status} {word}; starting the push again")
                restart = True
                break
            if status == 429:
                raise Stop(EXIT_LATER, f"receiver answered 429 {word}: try again later")
            if status in REFUSED:
                raise Stop(EXIT_REFUSED, f"receiver refused the push: {status} {word}")
            raise Stop(EXIT_FAILED, f"receiver answered {status} {word}")
        if not restart:
            log(f"pushed {len(data)} bytes in {len(chunks)} chunk(s); the map is rebuilding")
            return
    raise Stop(EXIT_FAILED, "the push did not go through twice")


def _word(body):
    try:
        return json.loads(body or b"{}").get("error", "")
    except (ValueError, AttributeError):
        return ""


def main(argv):
    dry_run = "--dry-run" in argv or os.environ.get("AUTOMAP_DRY_RUN") == "1"
    try:
        atlassian = Atlassian()
        rules = atlassian.rules()
        doc = {"rules": rules, "sender": {"name": NAME, "version": VERSION, "rules": len(rules)}}
        stopped = None
        try:
            # compact and ASCII-only: \\uXXXX for everything else, so a byte split is a safe split
            push(json.dumps(doc, separators=(",", ":"), ensure_ascii=True), dry_run)
        except Stop as stop:
            stopped = stop
        # usage is a push of its own and spends no load, so it goes even when the rules
        # were refused (an allowance used up, say); it never changes the exit code
        # ...but not when the receiver shut the door (403: switched off, or not on this
        # plan) - reading the internal APIs for an answer known in advance is wasted
        if not (stopped and stopped.code == EXIT_REFUSED and "403" in str(stopped)):
            push_usage(atlassian, dry_run)
            push_runs(atlassian, dry_run)
        if stopped:
            raise stopped
        return 0
    except Stop as stop:
        log(str(stop))
        return stop.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
