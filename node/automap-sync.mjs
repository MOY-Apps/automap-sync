#!/usr/bin/env node
/**
 * automap-sync (Node.js) - push this site's automation rules to Automation Map.
 *
 * Reads every automation rule with YOUR Atlassian API token (it never leaves this
 * machine), and pushes them to the Automation Map push receiver with the key the app
 * issued. No dependencies; Node 18+ (built-in fetch and crypto). Contract:
 * docs/push-sync.md. Same environment, flags and exit codes as the Python sender:
 *
 *   ATLASSIAN_SITE | ATLASSIAN_CLOUD_ID, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN,
 *   AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE,
 *   AUTOMAP_USAGE=off, AUTOMAP_RUNS=off, AUTOMAP_RUNS_DAYS (7)
 *
 * Usage and runs (BETA, from 1.1.0), as in the Python sender: after the rules, this month's
 * steps, Rovo credits and flow runs per rule, and the audit log of the last
 * AUTOMAP_RUNS_DAYS days folded into per-rule, per-day counts, are read from the internal
 * API behind Jira's Usage and Audit log tabs and pushed as two separate pushes. That API is
 * undocumented and can change: a failure there is logged and never fails the run. No account
 * ids, no issue ids and no message text leave this machine.
 *
 *   node automap-sync.mjs [--dry-run]
 *
 * Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
 * receiver, 5 try later, 6 failed.
 *
 * From 1.3.0: a 409 to a last chunk sent again (its first answer lost) means the receiver
 * took the first copy - the push is done, no second run; the audit log is read up to the
 * instant the window ends (toTime) and, cut at 50,000 records, pushed from its first complete
 * day; the internal API is retried like the Automation API, honouring Retry-After.
 *
 * Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
 */
import { createHash, randomUUID } from 'node:crypto';

const NAME = 'node';
const VERSION = '1.3.0';
const UA = `automap-sync-${NAME}/${VERSION}`;
const EXIT = { config: 2, atlassian: 3, refused: 4, later: 5, failed: 6 };
const REFUSED = new Set([400, 401, 402, 403, 404, 405, 413, 426]);

class Stop extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const log = (m) => process.stderr.write(`automap-sync ${NAME} ${VERSION}: ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(name, fallback) {
  const v = process.env[name] || fallback;
  if (!v) throw new Stop(EXIT.config, `${name} is not set`);
  return v;
}

/** Status, headers and text for any answer; null status when nothing answered. */
async function request(method, url, headers = {}, body) {
  try {
    const res = await fetch(url, { method, headers: { 'User-Agent': UA, ...headers }, body });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (err) {
    return { status: null, headers: new Headers(), text: String(err && err.message) };
  }
}

/** Sleep Retry-After seconds when given, else `wait` with jitter; the next wait (doubling to 15 s). */
async function pause(headers, wait) {
  const after = Number(headers.get('retry-after'));
  await sleep(after ? after * 1000 : wait + Math.random() * 500);
  return Math.min(wait * 2, 15000);
}

/** The JSON of a 200, or a Stop: a proxy's HTML page is an Atlassian-side failure, not a crash. */
function parse(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Stop(EXIT.atlassian, `the Automation API answered 200 with a body that is not JSON for ${what}`);
  }
}

async function cloudIdOf(site) {
  const base = site.includes('://') ? site : `https://${site}`;
  const res = await request('GET', `${base.replace(/\/$/, '')}/_edge/tenant_info`);
  if (res.status !== 200) throw new Stop(EXIT.atlassian, `could not read the cloud id of ${base} (HTTP ${res.status})`);
  return parse(res.text, 'the cloud id').cloudId;
}

async function atlassian() {
  const auth = `Basic ${Buffer.from(`${env('ATLASSIAN_EMAIL')}:${env('ATLASSIAN_API_TOKEN')}`).toString('base64')}`;
  const api = env('ATLASSIAN_API_BASE', 'https://api.atlassian.com').replace(/\/$/, '');
  const cloud = process.env.ATLASSIAN_CLOUD_ID || await cloudIdOf(env('ATLASSIAN_SITE'));
  const base = `${api}/automation/public/jira/${cloud}/rest/v1`;

  // `what` names the read in the log ("the rule list", "rule 3 of 40"): never the rule's id
  const get = async (path, what) => {
    let wait = 1000;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request('GET', base + path, { Authorization: auth, Accept: 'application/json' });
      if (res.status === 200) return parse(res.text, what);
      if (res.status === 401) {
        throw new Stop(EXIT.atlassian, 'the Automation API rejected the token (401): it must be an API token ' +
          'with the Automation scope, for this e-mail');
      }
      if (res.status === 403) {
        throw new Stop(EXIT.atlassian, 'the Automation API refused access (403): the account must be a Jira administrator');
      }
      if ((res.status === null || res.status === 429 || res.status >= 500) && attempt < 5) {
        wait = await pause(res.headers, wait);
        continue;
      }
      throw new Stop(EXIT.atlassian, `the Automation API answered ${res.status} for ${what}`);
    }
    throw new Stop(EXIT.atlassian, `gave up on the Automation API reading ${what}`);
  };

  const ids = [];
  const seen = new Set();
  const ctx = { auth, api, cloud };
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const page = await get(`/rule/summary?${params}`, 'the rule list');
    pages += 1;
    for (const item of page.data || []) {
      const id = item.id || item.uuid;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const next = page.links && page.links.next;
    cursor = next ? new URL(next, 'https://x').searchParams.get('cursor') : null;
  } while (cursor);
  log(`${ids.length} rules listed in ${pages} page(s)`);

  const rules = [];
  for (const [i, id] of ids.entries()) {
    const detail = await get(`/rule/${encodeURIComponent(id)}`, `rule ${i + 1} of ${ids.length}`);
    rules.push({ rule: detail && detail.rule ? detail.rule : detail });
  }
  return { rules, ctx };
}

const off = (name) => ['off', '0', 'false', 'no'].includes(String(process.env[name] || '').toLowerCase());
const internal = (ctx) => `${ctx.api}/automation/internal-api/jira/${ctx.cloud}/pro/rest/GLOBAL/`;

/**
 * The internal API behind Jira's Usage and Audit log tabs (BETA, undocumented). A 429
 * (Retry-After honoured), a 5xx or no answer is tried three times with the Automation API's
 * backoff; anything else throws, which the callers turn into "skipped".
 */
class Internal {
  constructor(ctx) { this.ctx = ctx; this.base = internal(ctx); }

  async call(path, body) {
    const headers = { Authorization: this.ctx.auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let wait = 1000;
    let status = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await request(body !== undefined ? 'POST' : 'GET', this.base + path, headers,
        body !== undefined ? JSON.stringify(body) : undefined);
      status = res.status;
      if (status === 200) return JSON.parse(res.text);
      if ((status === null || status === 429 || status >= 500) && attempt < 3) {
        wait = await pause(res.headers, wait);
        continue;
      }
      break;
    }
    throw new Error(`${path.split('?')[0]} answered ${status}`);
  }

  get(path) { return this.call(path); }
}

/** Automation usage (BETA) from the internal API behind Jira's Usage tab; account ids are not copied. */
class Usage extends Internal {

  async flows(start, end) {
    const byRule = new Map();
    // sortBy also filters to rules with that metric above zero: read both and merge
    for (const sortBy of ['automationCredits', 'rovoCredits']) {
      let seen = 0;
      for (let page = 0; page < 100; page += 1) {
        const r = await this.get(`highUsageFlows?limit=100&page=${page}&sortBy=${sortBy}&startTime=${start}&endTime=${end}`);
        for (const f of r.flows || []) {
          if (!f.ruleUuid) continue;
          byRule.set(f.ruleUuid, {
            uuid: f.ruleUuid, name: f.ruleName || '', state: f.state || 'ENABLED',
            runs: f.runs || 0, steps: f.automationCredits || 0, rovo: f.rovoCredits || 0,
            deleted: !!f.deleted, agentic: !!f.containsAgentic,
          });
        }
        seen += (r.flows || []).length;
        if (!(r.flows || []).length || seen >= (r.totalCount || 0)) break;
      }
    }
    return [...byRule.values()];
  }

  async month(start, end, month) {
    const credit = await this.get(`creditUsage?startTime=${start}&endTime=${end}`);
    const pair = (c) => ({ total: (c || {}).total || 0, jira: (c || {}).currentProduct || 0, other: (c || {}).everywhereElse || 0 });
    const out = { period: { start, end }, steps: pair(credit.automation), rovo: pair(credit.rovo), flows: await this.flows(start, end) };
    // the rest is the current billing model, and the least stable part: each piece optional
    try {
      const top = await this.get(`highestUsages?limit=100&month=${month}`);
      out.billable = { month, rules: top.filter((t) => t.ruleIdUuid).map((t) => ({ uuid: t.ruleIdUuid, runs: t.executionCount || 0 })) };
    } catch { /* optional */ }
    try {
      const ws = (((await this.get('pagecontext')).tenantPageContext || {}).usage || {}).workspaceUsages || {};
      out.limits = Object.entries(ws).map(([k, v]) => ({ product: k, used: v.executionsUsed || 0, limit: v.executionLimit || 0, edition: v.edition || '' }));
    } catch { /* optional */ }
    try {
      out.trend = ((await this.get('usageTrendData')).data || []).map((t) => ({ month: t.month, runs: t.workspaceCounts || {} }));
    } catch { /* optional */ }
    try {
      out.creditPack = !!(await this.get('hasCreditPack')).hasCreditPack;
    } catch { /* optional */ }
    return out;
  }

  /** This month so far; and in its first three days the whole of the month before. */
  static periods(nowMs) {
    const now = new Date(nowMs);
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const start = Date.UTC(y, m, 1);
    const label = (yy, mm) => `${yy}-${String(mm + 1).padStart(2, '0')}`;
    const out = [[start, nowMs, label(y, m)]];
    if (now.getUTCDate() <= 3) {
      const [py, pm] = m > 0 ? [y, m - 1] : [y - 1, 11];
      out.unshift([Date.UTC(py, pm, 1), start - 1, label(py, pm)]);
    }
    return out;
  }
}

/** The audit log (BETA), folded into what the map needs. Undocumented, like Usage. */
class Runs extends Internal {
  static MAX_RECORDS = 50000;          // 1,000 pages; past that the oldest day read is not whole

  static day(ms) { return new Date(ms).toISOString().slice(0, 10); }

  async read(days, nowMs) {
    let start = nowMs - days * 86400000;
    start -= start % 86400000;          // whole days, so a day pushed is a day complete
    // the log is newest first and paged by offset: runs landing while it is read would
    // shift every page, so the read ends at the instant the window does (toTime)
    const window = { fromTime: new Date(start).toISOString(), toTime: new Date(nowMs).toISOString() };
    let records = [];
    let capped = false;
    for (let offset = 0; ; offset += 50) {   // 50 a page whatever is asked; `total` is always 0
      const page = ((await this.call('auditlog', { ...window, offset, limit: 50 })).items || {}).items || [];
      records.push(...page);
      if (page.length < 50) break;
      if (offset + 50 >= Runs.MAX_RECORDS) { capped = true; break; }
    }
    if (capped) {
      // the oldest day read is cut short: pushed whole, it would replace the map's
      // complete count with a smaller one - so the window starts the day after it
      const at = (r) => r.eventTimestamp || r.startTime || 0;
      const oldest = records.reduce((m, r) => (at(r) && at(r) < m ? at(r) : m), Infinity);
      const cut = (Number.isFinite(oldest) ? oldest - (oldest % 86400000) : start) + 86400000;
      if (cut > nowMs) throw new Error(`more than ${Runs.MAX_RECORDS} runs in one day: no day of the window is complete`);
      records = records.filter((r) => at(r) >= cut);
      log(`runs (beta): the audit log is longer than ${Runs.MAX_RECORDS} records; the window was shortened to start ${Runs.day(cut)}`);
      start = Math.max(start, cut);
    }
    const rows = new Map();
    const failed = new Map();
    for (const r of records) {
      const u = r.ruleIdUuid;
      const t = r.eventTimestamp || r.startTime;
      if (!u || !t || t < start) continue;
      const key = `${u}|${Runs.day(t)}`;
      if (!rows.has(key)) {
        rows.set(key, { uuid: u, day: Runs.day(t), name: r.ruleName || '', success: 0, errors: 0, noop: 0, edits: 0, ms: 0, maxMs: 0 });
      }
      const row = rows.get(key);
      const cat = r.category;
      if (cat === 'CONFIG_CHANGE') { row.edits += 1; continue; }
      row[cat === 'SUCCESS' ? 'success' : cat === 'NO_ACTIONS_PERFORMED' ? 'noop' : 'errors'] += 1;
      // runs per UTC hour, only the hours that had any: a burst is hundreds of runs in one hour
      const hour = String(new Date(t).getUTCHours());
      row.hours = row.hours || {};
      row.hours[hour] = (row.hours[hour] || 0) + 1;
      const ms = r.durationMs || 0;
      row.ms += ms;
      row.maxMs = Math.max(row.maxMs, ms);
      if (cat !== 'SUCCESS' && cat !== 'NO_ACTIONS_PERFORMED' && r.id) {
        if (!failed.has(u)) failed.set(u, []);
        failed.get(u).push(r);
      }
    }
    const errors = [];
    let budget = 40;                    // one request per failed run read in full; two per rule at most
    for (const [u, list] of failed) {
      for (const r of list.sort((a, b) => (b.eventTimestamp || 0) - (a.eventTimestamp || 0)).slice(0, 2)) {
        if (budget <= 0) break;
        budget -= 1;
        let detail;
        try { detail = await this.call(`auditlog/item/${r.id}`); } catch { continue; }
        for (const cl of (detail.content || {}).componentLogs || []) {
          const res = cl.executionResult || {};
          const keys = (cl.changes || []).filter((ch) => (ch.payload || {}).type === 'ERROR').map((ch) => (ch.payload || {}).key || '');
          const code = (keys[0] || '') || res.auditEventErrorType || res.errorType || '';
          if (!code && res.state !== 'SOME_ERRORS') continue;
          const comp = cl.component || {};
          errors.push({ uuid: u, componentId: comp.id || '', componentType: comp.componentType || '',
            type: comp.type || '', code: code || 'SOME_ERRORS', at: r.eventTimestamp || 0 });
        }
      }
    }
    return { window: { start, end: nowMs }, rows: [...rows.values()], errors };
  }
}

/** Usage or runs (beta), in chunks like the rules; the receiver keeps them whole on the last one (APPS-499). */
async function pushKind(kind, payload) {
  const data = Buffer.from(payload, 'ascii');
  const checksum = createHash('sha256').update(data).digest('hex');
  const size = Number(env('AUTOMAP_CHUNK_BYTES', '200000'));
  const chunks = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  const run = randomUUID().replace(/-/g, '');
  let res = { status: null, text: '' };
  for (let seq = 0; seq < chunks.length; seq += 1) {
    const headers = {
      Authorization: `Bearer ${env('AUTOMAP_KEY')}`, 'Content-Type': 'text/plain; charset=utf-8',
      'X-Automap-Run': run, 'X-Automap-Seq': String(seq), 'X-Automap-Sender': `${NAME}/${VERSION}`, 'X-Automap-Kind': kind,
    };
    if (seq === chunks.length - 1) { headers['X-Automap-Last'] = '1'; headers['X-Automap-Sha256'] = checksum; }
    let tries = 1;
    for (; tries <= 3; tries += 1) {
      res = await request('POST', env('AUTOMAP_URL'), headers, chunks[seq]);
      if (res.status !== null && res.status < 500 && res.status !== 429) break;
      if (tries < 3) await sleep(2 ** tries * 1000);
    }
    if (res.status === 409 && tries > 1 && seq === chunks.length - 1) {
      // the first copy of the last chunk was taken and closed the run; its answer was
      // lost on the way back. Nothing to send again: the push is done.
      log(`${kind} (beta): the last chunk was already taken; the push went through`);
      res = { status: 202, headers: res.headers, text: '{"accepted":true,"queued":true}' };
    }
    if (res.status !== 202) break;
  }
  return res;
}

/** Read and push the usage; a failure is logged and the run goes on. */
async function pushUsage(ctx, dryRun) {
  if (off('AUTOMAP_USAGE')) return;
  try {
    const u = new Usage(ctx);
    for (const [start, end, month] of Usage.periods(Date.now())) {
      const doc = { usage: await u.month(start, end, month), sender: { name: NAME, version: VERSION } };
      const payload = asciiJson(doc);
      const steps = doc.usage.steps.total;
      const rules = doc.usage.flows.length;
      if (dryRun) { log(`usage (beta) ${month}: ${steps} steps, ${rules} rules with usage; nothing pushed`); continue; }
      const res = await pushKind('usage', payload);
      if (res.status === 202) log(`usage (beta) ${month}: pushed ${steps} steps for ${rules} rules`);
      else log(`usage (beta) ${month}: not taken, receiver answered ${res.status} ${word(res.text)}`);
    }
  } catch (err) {
    log(`usage (beta) skipped: ${err && err.message}`);
  }
}

/** Read the audit log and push it folded; a failure is logged and the run goes on. */
async function pushRuns(ctx, dryRun) {
  if (off('AUTOMAP_RUNS')) return;
  try {
    const days = Math.max(1, Math.min(30, Number(process.env.AUTOMAP_RUNS_DAYS) || 7));
    const runs = await new Runs(ctx).read(days, Date.now());
    const doc = { runs, sender: { name: NAME, version: VERSION } };
    const payload = asciiJson(doc);
    const total = (rows) => rows.reduce((n, x) => n + x.success + x.errors + x.noop, 0);
    const all = total(runs.rows);
    const failed = runs.rows.reduce((n, x) => n + x.errors, 0);
    if (dryRun) { log(`runs (beta) last ${days} days: ${all} runs, ${failed} with errors; nothing pushed`); return; }
    const res = await pushKind('runs', payload);
    if (res.status === 202) log(`runs (beta) last ${days} days: pushed ${all} runs, ${failed} with errors`);
    else log(`runs (beta): not taken, receiver answered ${res.status} ${word(res.text)}`);
  } catch (err) {
    log(`runs (beta) skipped: ${err && err.message}`);
  }
}

/** Compact JSON with every non-ASCII code unit escaped, so a byte split is a safe split. */
const asciiJson = (doc) => JSON.stringify(doc)
  .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const word = (text) => { try { return JSON.parse(text).error || ''; } catch { return ''; } };

async function push(payload, dryRun) {
  const data = Buffer.from(payload, 'ascii');
  const checksum = createHash('sha256').update(data).digest('hex');
  const size = Number(env('AUTOMAP_CHUNK_BYTES', '200000'));
  const chunks = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  if (dryRun) {
    log(`dry run: ${data.length} bytes in ${chunks.length} chunk(s), sha256 ${checksum}; nothing pushed`);
    return;
  }
  const url = env('AUTOMAP_URL');
  const key = env('AUTOMAP_KEY');

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = randomUUID().replace(/-/g, '');
    let restart = false;
    for (let seq = 0; seq < chunks.length; seq += 1) {
      const headers = {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Automap-Run': run,
        'X-Automap-Seq': String(seq),
        'X-Automap-Sender': `${NAME}/${VERSION}`,
      };
      if (seq === chunks.length - 1) {
        headers['X-Automap-Last'] = '1';
        headers['X-Automap-Sha256'] = checksum;
      }
      let res;
      let tries = 1;
      for (; tries <= 3; tries += 1) {
        res = await request('POST', url, headers, chunks[seq]);
        if (res.status === 202 || REFUSED.has(res.status) || [409, 422, 429].includes(res.status) || tries === 3) break;
        await sleep(2 ** tries * 1000);
      }
      if (res.status === 202) continue;
      const w = word(res.text);
      if (res.status === 409 && tries > 1 && seq === chunks.length - 1) {
        // the first copy of the last chunk was taken and closed the run; its answer was
        // lost on the way back. A new run would load the same rules twice.
        log(`the last chunk was already taken: pushed ${data.length} bytes in ${chunks.length} chunk(s); the map is rebuilding`);
        return;
      }
      if ((res.status === 409 || res.status === 422) && attempt === 1) {
        log(`receiver answered ${res.status} ${w}; starting the push again`);
        restart = true;
        break;
      }
      if (res.status === 429) throw new Stop(EXIT.later, `receiver answered 429 ${w}: try again later`);
      if (REFUSED.has(res.status)) throw new Stop(EXIT.refused, `receiver refused the push: ${res.status} ${w}`);
      throw new Stop(EXIT.failed, `receiver answered ${res.status} ${w}`);
    }
    if (!restart) {
      log(`pushed ${data.length} bytes in ${chunks.length} chunk(s); the map is rebuilding`);
      return;
    }
  }
  throw new Stop(EXIT.failed, 'the push did not go through twice');
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run') || process.env.AUTOMAP_DRY_RUN === '1';
  try {
    const { rules, ctx } = await atlassian();
    let stopped = null;
    try {
      await push(asciiJson({ rules, sender: { name: NAME, version: VERSION, rules: rules.length } }), dryRun);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      stopped = err;
    }
    // usage is a push of its own and spends no load, so it goes even when the rules were
    // refused (an allowance used up, say); it never changes the exit code - but not when the
    // receiver shut the door (403: switched off, or not on this plan)
    if (!(stopped && stopped.code === EXIT.refused && stopped.message.includes('403'))) {
      await pushUsage(ctx, dryRun);
      await pushRuns(ctx, dryRun);
    }
    if (stopped) throw stopped;
    return 0;
  } catch (err) {
    if (err instanceof Stop) { log(err.message); return err.code; }
    log(`failed: ${err && err.message}`);
    return EXIT.failed;
  }
}

process.exitCode = await main(process.argv.slice(2));
