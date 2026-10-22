import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * One local server playing both ends a sender talks to: the Automation Rule Management
 * API (what it reads) and the Automation Map push receiver (where it pushes). It follows
 * the receiver's contract in docs/push-sync.md closely enough that a sender passing here
 * passes against the real one - ordered chunks, the checksum on the last, the status
 * codes - and it misbehaves on purpose where real life does: a 429 on the second page of
 * summaries, a 500 on the second chunk of the first run.
 */

export const CLOUD_ID = '33333333-3333-4333-8333-333333333333';
export const EMAIL = 'robot@example.com';
export const TOKEN = 'atlassian-token-for-tests';
export const KEY = 'amk_test_key_for_the_fake_receiver_000000000';

/** Rules with names a byte-wise split would break if the sender left them as UTF-8. */
export function makeRules(n = 7) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      uuid: `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`,
      name: i % 3 === 0 ? `Закрыть задачу №${i} — готово ✓` : i % 3 === 1 ? `Notify 😀 rule ${i}` : `Plain rule ${i}`,
      state: i % 4 === 3 ? 'DISABLED' : 'ENABLED',
      created: 1757000000 + i,
      updated: 1757000500 + i,
      canOtherRuleTrigger: i % 2 === 0,
      ruleScopeARIs: [`ari:cloud:jira:${CLOUD_ID}:project/1000${i}`],
      description: i === 2 ? 'Line one\nLine two "quoted" \\ backslash' : '',
      trigger: { component: 'TRIGGER', type: 'jira.issue.event.trigger:created', value: { eventKey: 'issue_created' } },
      components: [{ component: 'ACTION', type: 'jira.issue.comment', value: { comment: 'x'.repeat(200 + i * 50) } }],
      labels: [],
    });
  }
  return out;
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const ANSWERS = {
  accepted: [202, { accepted: true }],
  queued: [202, { accepted: true, queued: true }],
  'bad-request': [400, { error: 'bad-request' }],
  unauthorized: [401, { error: 'unauthorized' }],
  conflict: [409, { error: 'conflict' }],
  'too-large': [413, { error: 'too-large' }],
  checksum: [422, { error: 'checksum' }],
  upgrade: [426, { error: 'upgrade' }],
  allowance: [429, { error: 'allowance', retryable: true }],
  failed: [500, { error: 'failed', retryable: true }],
};

/**
 * @param rules        what the API holds
 * @param pageSize     summaries per page (small, so paging is exercised)
 * @param refuse       answer every push with this output instead (e.g. 'allowance')
 * @param flaky        whether to fail once: page 2 with 429, chunk 1 of run 1 with 500
 * @param host         the name the sender should use for this server
 */
/**
 * The internal API behind Jira's Usage tab (docs/automation-usage-api.md), as observed:
 * the first two rules spent steps this month, nobody spent Rovo credits. `usage: 'broken'`
 * answers 500 everywhere, as it will the day Atlassian changes it.
 */
function usageAnswer(name, url, rules) {
  const [a, b] = rules;
  const flows = [
    { ruleUuid: a.uuid, ruleName: a.name, state: 'ENABLED', runs: 14, automationCredits: 1303, rovoCredits: 0,
      containsAgentic: false, deleted: false, actorAccountId: '557058:actor-secret', authorAccountId: '712020:author-secret' },
    { ruleUuid: b.uuid, ruleName: b.name, state: 'ENABLED', runs: 5, automationCredits: 7, rovoCredits: 0 },
  ];
  switch (name) {
    case 'creditUsage':
      return { automation: { total: 1310, currentProduct: 1310, everywhereElse: 0 }, rovo: { total: 0, currentProduct: 0, everywhereElse: 0 } };
    case 'highUsageFlows': {
      const list = url.searchParams.get('sortBy') === 'rovoCredits' ? [] : flows;
      const page = Number(url.searchParams.get('page') || 0);
      return { flows: page === 0 ? list : [], totalCount: list.length, page, pageSize: 100 };
    }
    case 'highestUsages':
      return [{ ruleIdUuid: a.uuid, executionCount: 14, ruleMetadata: { name: a.name, authorAccountId: '712020:author-secret' } }];
    case 'pagecontext':
      return { tenantPageContext: { usage: { workspaceUsages: { JIRA_SERVICE_MANAGEMENT: { executionsUsed: 18, executionLimit: 3000, edition: 'premium' } } } } };
    case 'usageTrendData':
      return { data: [{ month: '2026-09', workspaceCounts: { JIRA_SERVICE_MANAGEMENT: 1073 } }] };
    case 'hasCreditPack':
      return { hasCreditPack: false };
    case 'auditlog': {
      // the audit log: two runs of the first rule (one failed), one idle run of the second, an edit
      const now = Date.now();
      const items = [
        { id: 101, ruleIdUuid: a.uuid, ruleName: a.name, category: 'SOME_ERRORS', eventTimestamp: now - 3600000, durationMs: 31000, associatedIds: ['10042'] },
        { id: 102, ruleIdUuid: a.uuid, ruleName: a.name, category: 'SUCCESS', eventTimestamp: now - 7200000, durationMs: 29000 },
        { id: 103, ruleIdUuid: b.uuid, ruleName: b.name, category: 'NO_ACTIONS_PERFORMED', eventTimestamp: now - 3600000, durationMs: 120 },
        { id: 104, ruleIdUuid: b.uuid, ruleName: b.name, category: 'CONFIG_CHANGE', eventTimestamp: now - 3600000 },
      ];
      return { items: { items: url.searchParams.get('offset') ? [] : items, total: 0 } };
    }
    case 'auditlog/item/101':
      return { id: 101, content: { componentLogs: [
        { component: { id: 'c-trigger', componentType: 'TRIGGER', type: 'jira.jql.scheduled' }, changes: [], executionResult: { state: null } },
        { component: { id: 'c-branch', componentType: 'BRANCH', type: 'jira.smart.values.branch' },
          changes: [{ payload: { type: 'ERROR', key: 'com.codebarrel.automation.rule.error.smart.value.no.object', appendParameters: ['secret-field-value'] } }],
          executionResult: { state: 'SOME_ERRORS', displayMessages: ['projectName: secret-project-name'] } },
      ] } };
    default:
      return null;
  }
}

export function startFakeSite({ rules = makeRules(), pageSize = 3, refuse = null, flaky = true, host = '127.0.0.1', usage = true } = {}) {
  const state = {
    // the usage and runs pushes (beta), apart from the rules: `runs` below is the rule runs' staging
    pushed: { usage: [], runs: [] },
    usageCalls: 0,
    apiCalls: [],
    runs: new Map(),
    loaded: [],
    answers: [],
    senders: new Set(),
    nonAscii: false,
    pushRequests: 0,
  };
  let tripped429 = false;
  let tripped500 = false;
  const byId = new Map(rules.map((r) => [r.uuid, r]));
  const basic = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      if (p === '/_edge/tenant_info') return json(res, 200, { cloudId: CLOUD_ID });

      const internal = `/automation/internal-api/jira/${CLOUD_ID}/pro/rest/GLOBAL/`;
      if (p.startsWith(internal)) {
        state.usageCalls += 1;
        if (req.headers.authorization !== basic) return json(res, 403, {});
        if (usage === 'broken') return json(res, 500, { errorMessages: ['gone'] });
        let ask = url;
        if (req.method === 'POST' && raw.length) {
          // the audit log list is a POST with its paging in the body
          const b = JSON.parse(raw.toString('utf8'));
          ask = new URL(`http://x/?offset=${b.offset ? b.offset : ''}`);
        }
        const body = usageAnswer(p.slice(internal.length), ask, rules);
        return body === null ? json(res, 404, {}) : json(res, 200, body);
      }

      const api = `/automation/public/jira/${CLOUD_ID}/rest/v1`;
      if (p.startsWith(api)) {
        state.apiCalls.push(p + url.search);
        if (req.headers.authorization !== basic) return json(res, 401, { message: 'Unauthorized' });
        if (p === `${api}/rule/summary`) {
          const cursor = Number(url.searchParams.get('cursor') || 0);
          const limit = Number(url.searchParams.get('limit') || 100);
          if (cursor === pageSize && flaky && !tripped429) {
            tripped429 = true;
            return json(res, 429, { message: 'slow down' }, { 'Retry-After': '1' });
          }
          const size = Math.min(limit, pageSize);
          const page = rules.slice(cursor, cursor + size);
          const next = cursor + size < rules.length
            ? `https://api.atlassian.com${api}/rule/summary?limit=${limit}&cursor=${cursor + size}`
            : undefined;
          // summaries name the rule by `id` on some sites and `uuid` on others
          return json(res, 200, {
            data: page.map((r, i) => (i % 2 ? { uuid: r.uuid, name: r.name } : { id: r.uuid, name: r.name })),
            links: next ? { next } : {},
          });
        }
        const m = p.match(/\/rule\/([^/]+)$/);
        if (m && byId.has(decodeURIComponent(m[1]))) {
          const r = byId.get(decodeURIComponent(m[1]));
          // the detail comes back bare or wrapped, and the sender must wrap it either way
          return json(res, 200, r.state === 'DISABLED' ? r : { rule: r });
        }
        return json(res, 404, { message: 'no such rule' });
      }

      if (p === '/push/v1' && req.method === 'GET') return json(res, 200, { ok: true, receiver: 'fake' });
      if (p !== '/push/v1/push') return json(res, 404, { error: 'not-found' });
      state.pushRequests += 1;
      const answer = (key) => {
        state.answers.push(key);
        const [status, body] = ANSWERS[key];
        return json(res, status, body);
      };
      const h = (name) => req.headers[name.toLowerCase()];
      const given = h('x-automap-key') || String(h('authorization') || '').replace(/^Bearer\s+/i, '');
      if (given !== KEY) return answer('unauthorized');
      if (refuse) return answer(refuse);
      if (h('x-automap-sender')) state.senders.add(String(h('x-automap-sender')));
      const run = String(h('x-automap-run') || '');
      const seq = Number(h('x-automap-seq'));
      const last = h('x-automap-last') === '1' || h('x-automap-last') === 'true';
      const sum = String(h('x-automap-sha256') || '').toLowerCase();
      const lengthText = String(h('x-automap-length') || '');
      const partText = String(h('x-automap-part') || '');
      state.requests = state.requests || [];
      state.requests.push({ run, seq: h('x-automap-seq'), last: h('x-automap-last'), length: lengthText, sha: sum, bytes: raw.length, sender: h('x-automap-sender'), part: partText });
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(run) || !Number.isInteger(seq) || seq < 0) return answer('bad-request');
      // like the real receiver: the last chunk proves the payload by SHA-256, by length, or both
      if (last && !/^[0-9a-f]{64}$/.test(sum) && !/^\d{1,10}$/.test(lengthText)) return answer('bad-request');
      if (String(h('content-encoding') || '').includes('gzip') || !raw.length) return answer('bad-request');
      if (raw.length > 256 * 1024) return answer('too-large');
      if (raw.some((b) => b > 0x7f)) state.nonAscii = true;

      // usage (beta): one chunk, checked and kept apart from the rules, like the real receiver
      const kind = String(h('x-automap-kind') || 'rules');
      if (kind === 'usage' || kind === 'runs') {
        // staged in order like the rules, kept whole on the last chunk (APPS-499)
        const key = `${kind}|${run}`;
        state.extra = state.extra || new Map();
        if (seq === 0) state.extra.set(key, []);
        const parts = state.extra.get(key);
        if (!parts || seq > parts.length) return answer('conflict');
        parts[seq] = raw;
        state.extraChunks = (state.extraChunks || 0) + 1;
        if (!last) return answer('accepted');
        const whole = Buffer.concat(parts);
        state.extra.delete(key);
        if (sum && createHash('sha256').update(whole).digest('hex') !== sum) return answer('checksum');
        if (lengthText && whole.toString('utf8').length !== Number(lengthText)) return answer('checksum');
        state.pushed[kind].push(JSON.parse(whole.toString('utf8')));
        return answer('queued');
      }

      // rules in parts (X-Automap-Part: N/M, senders 1.4.0): the parts of one run are staged
      // apart, each proven by its own last chunk, and merged by uuid into one build once all
      // M have arrived. Another M for the same run, or a run already built, is a conflict.
      if (partText) {
        const pm = /^(\d{1,2})\/(\d{1,2})$/.exec(partText);
        const n = pm ? Number(pm[1]) : 0;
        const m = pm ? Number(pm[2]) : 0;
        if (!pm || m < 2 || m > 20 || n < 1 || n > m) return answer('bad-request');
        state.partRuns = state.partRuns || new Map();
        let group = state.partRuns.get(run);
        if (group && (group.built || group.m !== m)) return answer('conflict');
        if (!group) {
          group = { m, staging: new Map(), done: new Map(), built: false };
          state.partRuns.set(run, group);
        }
        let piece = group.staging.get(n);
        if (seq === 0) {
          piece = { parts: [] };
          group.staging.set(n, piece);
        } else if (!piece || seq > piece.parts.length) {
          return answer('conflict');
        }
        if (seq === 1 && flaky && !tripped500) {
          tripped500 = true;
          return answer('failed');
        }
        piece.parts[seq] = raw;
        if (!last) return answer('accepted');
        if (piece.parts.length !== seq + 1) return answer('conflict');
        const whole = Buffer.concat(piece.parts);
        group.staging.delete(n);
        if (sum && createHash('sha256').update(whole).digest('hex') !== sum) return answer('checksum');
        if (lengthText && whole.toString('utf8').length !== Number(lengthText)) return answer('checksum');
        group.done.set(n, JSON.parse(whole.toString('utf8')));
        if (group.done.size < m) return answer('accepted');
        const seenIds = new Set();
        const merged = [];
        for (let i = 1; i <= m; i += 1) {
          for (const r of group.done.get(i).rules) {
            const id = r.rule && r.rule.uuid;
            if (!id || !seenIds.has(id)) merged.push(r);
            if (id) seenIds.add(id);
          }
        }
        group.built = true;
        state.loaded.push({ rules: merged, sender: group.done.get(m).sender, parts: m });
        return answer('queued');
      }

      let entry = state.runs.get(run);
      if (seq === 0) {
        if (entry && entry.closed) return answer('conflict');
        entry = { parts: [], closed: false };
        state.runs.set(run, entry);
      } else if (!entry || entry.closed || seq > entry.parts.length) {
        return answer('conflict');
      }
      if (seq === 1 && flaky && !tripped500) {
        tripped500 = true;
        return answer('failed');
      }
      entry.parts[seq] = raw;
      if (!last) return answer('accepted');
      if (entry.parts.length !== seq + 1) return answer('conflict');
      const whole = Buffer.concat(entry.parts);
      if (sum && createHash('sha256').update(whole).digest('hex') !== sum) return answer('checksum');
      if (lengthText && whole.toString('utf8').length !== Number(lengthText)) return answer('checksum');
      entry.closed = true;
      state.loaded.push(JSON.parse(whole.toString('utf8')));
      return answer('queued');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address();
      const base = `http://${host}:${port}`;
      resolve({
        state,
        base,
        env: {
          ATLASSIAN_SITE: base,
          ATLASSIAN_API_BASE: base,
          ATLASSIAN_EMAIL: EMAIL,
          ATLASSIAN_API_TOKEN: TOKEN,
          AUTOMAP_URL: `${base}/push/v1/push`,
          AUTOMAP_KEY: KEY,
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** The payload a correct sender produces for `rules`: each one wrapped, in order. */
export const expectedRules = (rules) => rules.map((r) => ({ rule: r }));
