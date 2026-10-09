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
 *   AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE
 *
 *   node automap-sync.mjs [--dry-run]
 *
 * Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by the
 * receiver, 5 try later, 6 failed.
 *
 * Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
 */
import { createHash, randomUUID } from 'node:crypto';

const NAME = 'node';
const VERSION = '1.0.0';
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

async function cloudIdOf(site) {
  const base = site.includes('://') ? site : `https://${site}`;
  const res = await request('GET', `${base.replace(/\/$/, '')}/_edge/tenant_info`);
  if (res.status !== 200) throw new Stop(EXIT.atlassian, `could not read the cloud id of ${base} (HTTP ${res.status})`);
  return JSON.parse(res.text).cloudId;
}

async function atlassian() {
  const auth = `Basic ${Buffer.from(`${env('ATLASSIAN_EMAIL')}:${env('ATLASSIAN_API_TOKEN')}`).toString('base64')}`;
  const api = env('ATLASSIAN_API_BASE', 'https://api.atlassian.com').replace(/\/$/, '');
  const cloud = process.env.ATLASSIAN_CLOUD_ID || await cloudIdOf(env('ATLASSIAN_SITE'));
  const base = `${api}/automation/public/jira/${cloud}/rest/v1`;

  const get = async (path) => {
    let wait = 1000;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request('GET', base + path, { Authorization: auth, Accept: 'application/json' });
      if (res.status === 200) return JSON.parse(res.text);
      if (res.status === 401) {
        throw new Stop(EXIT.atlassian, 'the Automation API rejected the token (401): it must be an API token ' +
          'with the Automation scope, for this e-mail');
      }
      if (res.status === 403) {
        throw new Stop(EXIT.atlassian, 'the Automation API refused access (403): the account must be a Jira administrator');
      }
      if ((res.status === null || res.status === 429 || res.status >= 500) && attempt < 5) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(after ? after * 1000 : wait + Math.random() * 500);
        wait = Math.min(wait * 2, 15000);
        continue;
      }
      throw new Stop(EXIT.atlassian, `the Automation API answered ${res.status} for ${path.split('?')[0]}`);
    }
    throw new Stop(EXIT.atlassian, 'gave up on the Automation API');
  };

  const ids = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const page = await get(`/rule/summary?${params}`);
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
  for (const id of ids) {
    const detail = await get(`/rule/${encodeURIComponent(id)}`);
    rules.push({ rule: detail && detail.rule ? detail.rule : detail });
  }
  return rules;
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
      for (let tries = 1; tries <= 3; tries += 1) {
        res = await request('POST', url, headers, chunks[seq]);
        if (res.status === 202 || REFUSED.has(res.status) || [409, 422, 429].includes(res.status) || tries === 3) break;
        await sleep(2 ** tries * 1000);
      }
      if (res.status === 202) continue;
      const w = word(res.text);
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
    const rules = await atlassian();
    await push(asciiJson({ rules, sender: { name: NAME, version: VERSION, rules: rules.length } }), dryRun);
    return 0;
  } catch (err) {
    if (err instanceof Stop) { log(err.message); return err.code; }
    log(`failed: ${err && err.message}`);
    return EXIT.failed;
  }
}

process.exitCode = await main(process.argv.slice(2));
