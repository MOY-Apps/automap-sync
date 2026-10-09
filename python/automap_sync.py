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
  optional: ATLASSIAN_CLOUD_ID, AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE

Usage:  python3 automap_sync.py [--dry-run]

Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
receiver (fix something, do not retry), 5 try later (allowance or rate limit), 6 failed.

Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
"""
import base64
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
VERSION = "1.0.0"
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
        rules = Atlassian().rules()
        doc = {"rules": rules, "sender": {"name": NAME, "version": VERSION, "rules": len(rules)}}
        # compact and ASCII-only: \\uXXXX for everything else, so a byte split is a safe split
        push(json.dumps(doc, separators=(",", ":"), ensure_ascii=True), dry_run)
        return 0
    except Stop as stop:
        log(str(stop))
        return stop.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
