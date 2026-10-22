#!/usr/bin/env node
/**
 * Renders senders/jmwe/automap-sync.njk the way JMWE would, outside Jira: the real
 * nunjucks engine, plus stand-ins for the two JMWE additions the template uses -
 * `callRest` (as documented: verb, body, options.auth / headers / timeout, noJSON,
 * dontFail) and `date` - and the `now` global. callRest is synchronous here (curl),
 * because JMWE's is used synchronously inside loops.
 *
 *   NUNJUCKS_DIR=<dir with node_modules/nunjucks> \
 *   ATLASSIAN_SITE=... ATLASSIAN_EMAIL=... ATLASSIAN_API_TOKEN=... \
 *   AUTOMAP_URL=... AUTOMAP_KEY=... [ATLASSIAN_API_BASE=http://127.0.0.1:port] \
 *   node senders/jmwe/test/run-locally.mjs
 *
 * ATLASSIAN_SITE may carry a scheme (http://127.0.0.1:port) to point the template at the
 * fake site; requests the template makes to https://<site> and https://api.atlassian.com
 * are then sent there. Prints the template's one-line result.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const nunjucksDir = process.env.NUNJUCKS_DIR;
if (!nunjucksDir) throw new Error('NUNJUCKS_DIR is not set');
const nunjucks = createRequire(join(nunjucksDir, 'package.json'))('nunjucks');

const env = (k) => {
  if (!process.env[k]) throw new Error(`${k} is not set`);
  return process.env[k];
};
const site = env('ATLASSIAN_SITE');
const siteHost = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
const siteBase = site.includes('://') ? site.replace(/\/$/, '') : `https://${site}`;
const apiBase = (process.env.ATLASSIAN_API_BASE || 'https://api.atlassian.com').replace(/\/$/, '');

/** Where the template thinks it is calling, and where it really goes. */
function rewrite(url) {
  if (url.startsWith(`https://${siteHost}`)) return siteBase + url.slice(`https://${siteHost}`.length);
  if (url.startsWith('https://api.atlassian.com')) return apiBase + url.slice('https://api.atlassian.com'.length);
  return url;
}

export const calls = [];

function callRest(url, kw = {}) {
  const verb = String(kw.verb || 'GET').toUpperCase();
  const opts = kw.options || {};
  const args = ['-sS', '-X', verb, '-o', '-', '-w', '\n%{http_code}', '--max-time', String(Math.ceil((opts.timeout || 20000) / 1000))];
  if (opts.auth) args.push('-u', `${opts.auth.username}:${opts.auth.password}`);
  let input;
  if (kw.body !== undefined) {
    input = kw.noJSON ? String(kw.body) : JSON.stringify(kw.body);
    if (!kw.noJSON) args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', '@-');
  }
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  args.push(rewrite(url));
  const out = execFileSync('curl', args, { input: input === undefined ? '' : Buffer.from(input, 'utf8'), maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const cut = out.lastIndexOf('\n');
  const status = Number(out.slice(cut + 1));
  const text = out.slice(0, cut);
  calls.push({ verb, url, status, bodyChars: input === undefined ? 0 : input.length, headers: opts.headers || {} });
  if (status >= 400 || !status) {
    if (kw.dontFail) return { _error: { code: status, description: text.slice(0, 200) }, _statusCode: status };
    throw new Error(`callRest ${verb} ${url} answered ${status}`);
  }
  if (kw.noJSON) return text;
  return text ? JSON.parse(text) : null;
}

export function render(templateText) {
  const e = new nunjucks.Environment(null, { autoescape: false });
  e.addFilter('callRest', (url, kw) => callRest(url, kw || {}));
  e.addFilter('date', (value, fmt) => (fmt === 'x' ? String(new Date(value || Date.now()).getTime()) : new Date(value || Date.now()).toISOString()));
  e.addGlobal('now', new Date());
  return e.renderString(templateText, {});
}

export function filled() {
  // the rules template by default; JMWE_TEMPLATE=automap-usage.njk for the usage and runs one
  let t = readFileSync(join(here, '..', process.env.JMWE_TEMPLATE || 'automap-sync.njk'), 'utf8');
  const values = {
    '"your-site.atlassian.net"': JSON.stringify(siteHost),
    '"you@example.com"': JSON.stringify(env('ATLASSIAN_EMAIL')),
    '"an API token with the Automation scope"': JSON.stringify(env('ATLASSIAN_API_TOKEN')),
    '"the receiver URL from Automation Map, ending /v1/push"': JSON.stringify(env('AUTOMAP_URL')),
    '"the amk_ key from Automation Map"': JSON.stringify(env('AUTOMAP_KEY')),
  };
  for (const [from, to] of Object.entries(values)) {
    if (!t.includes(from)) throw new Error(`placeholder ${from} not found in the template`);
    t = t.replace(from, to);
  }
  // the switches the other senders take from the environment: AUTOMAP_USAGE, AUTOMAP_RUNS, AUTOMAP_RUNS_DAYS
  const isOff = (k) => ['off', '0', 'false', 'no'].includes(String(process.env[k] || '').toLowerCase());
  if (isOff('AUTOMAP_USAGE')) t = t.replace('{%- set USAGE = true -%}', '{%- set USAGE = false -%}');
  if (isOff('AUTOMAP_RUNS')) t = t.replace('{%- set RUNS = true -%}', '{%- set RUNS = false -%}');
  if (/^\d+$/.test(process.env.AUTOMAP_CHUNK_BYTES || '')) t = t.replace('{%- set CHUNK_CHARS = 80000 -%}', `{%- set CHUNK_CHARS = ${process.env.AUTOMAP_CHUNK_BYTES} -%}`);
  if (/^\d+$/.test(process.env.AUTOMAP_RUNS_DAYS || '')) t = t.replace('{%- set RUNS_DAYS = 1 -%}', `{%- set RUNS_DAYS = ${process.env.AUTOMAP_RUNS_DAYS} -%}`);
  return t;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(render(filled()).trim());
}
