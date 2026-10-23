import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFakeSite, makeRules, expectedRules, KEY } from './fake-site.mjs';

/**
 * Every published sender, run against the same fake site. Not part of `npm test`: it
 * starts interpreters and, for PowerShell and ScriptRunner's Groovy, Docker containers.
 * Run with `npm run test:senders`. A sender whose runtime is missing is skipped, loudly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
// `docker info` answering is not enough: on some hosts the daemon answers and never runs a container
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0
  && spawnSync('docker', ['run', '--rm', 'alpine:3', 'true'], { stdio: 'ignore', timeout: 20_000, killSignal: 'SIGKILL' }).status === 0;
const PLATFORM = ['--platform', process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'];
// GROOVY_GRAPES: a host folder mounted as the Groovy container's Grape cache, so unirest is
// fetched once, not by every container - Maven Central answers 429 to a burst of them
const GRAPES = process.env.GROOVY_GRAPES ? ['-v', `${process.env.GROOVY_GRAPES}:/home/groovy/.groovy/grapes`] : [];

/** The version a sender announces, read from its own file so a release never has to touch this test. */
const FILES = {
  python: 'python/automap_sync.py', node: 'node/automap-sync.mjs', bash: 'bash/automap-sync.sh',
  powershell: 'powershell/automap-sync.ps1', scriptrunner: 'scriptrunner/AutomapSync.groovy',
  scriptrunnerUsage: 'scriptrunner/AutomapUsage.groovy', jmwe: 'jmwe/automap-sync.njk', jmweUsage: 'jmwe/automap-usage.njk',
};
function versionOf(name) {
  const text = readFileSync(join(root, FILES[name]), 'utf8');
  const m = text.match(/VERSION\s*=\s*['"]?(\d+\.\d+\.\d+)/i);
  if (!m) throw new Error(`${name}: no VERSION in ${FILES[name]}`);
  return m[1];
}

const SENDERS = [
  { name: 'python', run: (e) => ['python3', [join(root, 'python/automap_sync.py'), ...e]], ok: has('python3') },
  { name: 'node', run: (e) => ['node', [join(root, 'node/automap-sync.mjs'), ...e]], ok: has('node') },
  { name: 'bash', run: (e) => ['bash', [join(root, 'bash/automap-sync.sh'), ...e]], ok: has('bash') && has('jq') && has('curl') },
  {
    name: 'powershell',
    local: has('pwsh', ['-NoProfile', '-c', 'exit 0']),
    run: (e, envv, local) => (local
      ? ['pwsh', ['-NoProfile', '-File', join(root, 'powershell/automap-sync.ps1'), ...e.map((a) => (a === '--dry-run' ? '-DryRun' : a))]]
      : ['docker', ['run', '--rm', '-v', `${root}:/s:ro`, ...dockerEnv(envv), ...PLATFORM,
        'mcr.microsoft.com/dotnet/sdk:8.0', 'pwsh', '-NoProfile', '-File', '/s/powershell/automap-sync.ps1',
        ...e.map((a) => (a === '--dry-run' ? '-DryRun' : a))]]),
  },
  {
    name: 'scriptrunner',
    local: has('groovy'),
    run: (e, envv, local, file = 'AutomapSync.groovy') => (local
      ? ['groovy', [join(root, 'scriptrunner/test/run-locally.groovy'), join(root, 'scriptrunner', file)]]
      : ['docker', ['run', '--rm', '-v', `${root}:/s:ro`, ...GRAPES, ...dockerEnv(envv), ...PLATFORM,
        'groovy:4.0-jdk17', 'groovy', '/s/scriptrunner/test/run-locally.groovy', `/s/scriptrunner/${file}`]]),
    dryRunByEnv: true,
    // two Scheduled Jobs: the rules, and the usage and runs (beta), each with the whole time limit
    usageFile: 'AutomapUsage.groovy',
    // the rules in parts (PART=N/M), for a site past the host's time limit
    parts: true,
  },
];

/** The run id the in-Jira senders use for parts: the UTC date, shared by every copy of the job. */
const todayRun = () => `d${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const uuidsOf = (doc) => doc.rules.map((r) => r.rule.uuid);

function dockerEnv(envv) {
  return Object.entries(envv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

function runSender(s, site, extraEnv = {}, args = [], file) {
  const envv = { ...site.env, AUTOMAP_CHUNK_BYTES: '900', ...extraEnv };
  if (s.dryRunByEnv && args.includes('--dry-run')) envv.AUTOMAP_DRY_RUN = '1';
  const [cmd, argv] = s.run(args, envv, s.local, file);
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: { ...process.env, ...envv } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

for (const s of SENDERS) {
  const available = s.ok || s.local || dockerUp;
  const opts = { skip: available ? false : `${s.name}: runtime not available (no local interpreter, Docker cannot run containers)`, timeout: 240_000 };
  const host = !s.ok && !s.local ? 'host.docker.internal' : '127.0.0.1';

  test(`${s.name}: reads every rule, pushes them in ASCII chunks, survives a 429 and a 500`, opts, async () => {
    const rules = makeRules(7);
    const site = await startFakeSite({ rules, host });
    try {
      const { code, out } = await runSender(s, site);
      assert.equal(code, 0, out);
      assert.equal(site.state.loaded.length, 1, out);
      assert.deepEqual(site.state.loaded[0].rules, expectedRules(rules));
      assert.equal(site.state.loaded[0].sender.name, s.name);
      assert.deepEqual([...site.state.senders], [`${s.name}/${versionOf(s.name)}`]);
      assert.equal(site.state.nonAscii, false, 'the body must be ASCII so a byte split is safe');
      assert.ok(site.state.answers.filter((a) => a === 'accepted').length >= 2, 'small chunks mean several requests');
      assert.ok(!out.includes(KEY) && !out.includes('atlassian-token-for-tests'), 'no secret in the log');
      assert.ok(!out.includes('Закрыть'), 'no rule content in the log');
      if (s.usageFile) assert.equal(site.state.usageCalls, 0, 'the rules script leaves usage and runs to the other one');
      assert.ok(site.state.requests.every((r) => !r.part && !r.run.startsWith('d2')), 'without PART nothing changes on the wire');
    } finally {
      await site.close();
    }
  });

  // the rules in parts (1.4.0): two scheduled copies of the job, PART=1/2 and 2/2, build one map
  test(`${s.name}: PART=1/2 then 2/2 push two slices of one day's run, and the map has every rule`, { ...opts, skip: s.parts ? opts.skip : `${s.name}: has no PART` }, async () => {
    const rules = makeRules(7);
    const site = await startFakeSite({ rules, host });
    try {
      const first = await runSender(s, site, { PART: '1/2' });
      assert.equal(first.code, 0, first.out);
      assert.match(first.out, /part 1\/2: 4 rules pushed, waiting for the other part/);
      assert.equal(site.state.loaded.length, 0, 'half the rules build nothing');
      assert.equal(site.state.answers[site.state.answers.length - 1], 'accepted');

      const second = await runSender(s, site, { PART: '2/2' });
      assert.equal(second.code, 0, second.out);
      assert.match(second.out, /part 2\/2: 3 rules pushed, map queued/);
      assert.equal(site.state.answers[site.state.answers.length - 1], 'queued');
      assert.equal(site.state.loaded.length, 1, second.out);
      assert.deepEqual(new Set(uuidsOf(site.state.loaded[0])), new Set(rules.map((r) => r.uuid)), 'every rule, once');
      assert.deepEqual([...site.state.senders], [`${s.name}/${versionOf(s.name)}`]);

      // one run for the day, the header on every chunk, the slices cut by each rule's own id
      // (its first 8 hex digits mod M), so a rule's part never depends on the rest of the list
      const run = todayRun();
      assert.ok(site.state.requests.every((r) => r.run === run && /^[12]\/2$/.test(r.part)), JSON.stringify(site.state.requests));
      const group = site.state.partRuns.get(run);
      const sorted = rules.map((r) => r.uuid).sort();
      assert.deepEqual(uuidsOf(group.done.get(1)), sorted.filter((u) => partOf(u, 2) === 1));
      assert.deepEqual(uuidsOf(group.done.get(2)), sorted.filter((u) => partOf(u, 2) === 2));

      // the same part again today: the run is built, and the sender says so instead of retrying
      const again = await runSender(s, site, { PART: '1/2' });
      assert.equal(again.code, 4, again.out);
      assert.match(again.out, /already built/);
      assert.equal(site.state.loaded.length, 1);

      // a bad PART is a configuration error, found before anything is read
      for (const bad of ['2/1', 'x', '1/1', '0/2', '1/21', '1/2/3']) {
        const calls = site.state.apiCalls.length;
        const r = await runSender(s, site, { PART: bad });
        assert.equal(r.code, 2, `PART=${bad}: ${r.out}`);
        assert.match(r.out, /PART must be/);
        assert.equal(site.state.apiCalls.length, calls, `PART=${bad}: nothing read`);
      }
    } finally {
      await site.close();
    }
    // two rules deleted between the copies move no other rule across the cut: a slice by
    // position would start part 2 later and leave a rule near the boundary in neither part
    const eight = makeRules(8);
    const shrinking = await startFakeSite({ rules: eight, host, flaky: false });
    try {
      const first = await runSender(s, shrinking, { PART: '1/2' });
      assert.equal(first.code, 0, first.out);
      const carried = eight.filter((r) => partOf(r.uuid, 2) === 1);
      assert.equal(carried.length, 4);
      eight.splice(eight.indexOf(carried[0]), 1);
      eight.splice(eight.indexOf(carried[1]), 1);
      const second = await runSender(s, shrinking, { PART: '2/2' });
      assert.equal(second.code, 0, second.out);
      assert.equal(shrinking.state.loaded.length, 1, second.out);
      assert.deepEqual(new Set(uuidsOf(shrinking.state.loaded[0])), new Set(makeRules(8).map((r) => r.uuid)), 'every rule listed that day, once');
    } finally {
      await shrinking.close();
    }
  });

  // the answer to the last chunk lost after the receiver took it (a timeout): the resend is 409,
  // and that is the push done - not a fresh run that would load the day's rules twice
  test(`${s.name}: a lost answer to the last chunk is not a second push`, opts, async () => {
    const site = await startFakeSite({ rules: makeRules(5), host, flaky: false, lose: 'rules' });
    try {
      const { code, out } = await runSender(s, site, { AUTOMAP_USAGE: 'off', AUTOMAP_RUNS: 'off' });
      assert.equal(code, 0, out);
      assert.equal(site.state.lost, 1, 'the fake lost the answer to the last chunk');
      assert.equal(site.state.loaded.length, 1, `${out}\n${JSON.stringify(site.state.answers)}`);
      assert.deepEqual(site.state.answers.slice(-2), ['queued', 'conflict'], JSON.stringify(site.state.answers));
      assert.match(out, /already taken/);
      if (s.parts) {
        const parts = await startFakeSite({ rules: makeRules(7), host, flaky: false, lose: 'rules' });
        try {
          const one = await runSender(s, parts, { PART: '1/2' });
          assert.equal(one.code, 0, one.out);
          assert.match(one.out, /part 1\/2: .*already taken/);
          assert.equal(parts.state.loaded.length, 0);
          const two = await runSender(s, parts, { PART: '2/2' });
          assert.equal(two.code, 0, two.out);
          assert.equal(parts.state.loaded.length, 1, two.out);
          assert.deepEqual(new Set(uuidsOf(parts.state.loaded[0])), new Set(makeRules(7).map((r) => r.uuid)));
        } finally {
          await parts.close();
        }
      }
    } finally {
      await site.close();
    }
  });

  // the audit log is newest first and offset-paged; runs that land while the sender pages
  // shift every page unless the read is bounded by toTime = the window's end
  test(`${s.name}: the audit log is read up to the instant the window ends, so runs landing meanwhile shift no page`, opts, async () => {
    const site = await startFakeSite({ rules: makeRules(3), host, flaky: false, audit: { size: 130, grow: 7 } });
    try {
      // the in-Jira usage job pushes hourly slices from 1.6.0; whole days are its `days` mode
      const { code, out } = s.usageFile ? await runSender(s, site, { AUTOMAP_RUNS_MODE: 'days' }, [], s.usageFile) : await runSender(s, site);
      assert.equal(code, 0, out);
      assert.equal(site.state.pushed.runs.length, 1, out);
      const r = site.state.pushed.runs[0].runs;
      const calls = site.state.audit.calls;
      assert.ok(calls.length >= 3, `${calls.length} pages read`);
      for (const c of calls) {
        assert.match(String(c.toTime), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `toTime on every page: ${JSON.stringify(c)}`);
        assert.equal(Date.parse(c.toTime), r.window.end, 'toTime is the instant stamped as window.end');
        assert.equal(Date.parse(c.fromTime), r.window.start, 'fromTime is window.start');
      }
      const runs = r.rows.reduce((n, x) => n + x.success + x.errors + x.noop, 0);
      assert.equal(runs, 130, `every run before the window's end once, none of the ${site.state.audit.records.length - 130} that landed meanwhile: ${out}`);
    } finally {
      await site.close();
    }
  });

  // a non-retryable answer from the Automation API names what was being read and how far
  // the sender got - never the rule's id (the README promises the log holds no rule)
  test(`${s.name}: a rule the API will not give names no rule id in the log, and a 200 that is not JSON is exit 3`, opts, async () => {
    const rules = makeRules(3);
    const site = await startFakeSite({ rules, host, flaky: false, missing: rules[1].uuid });
    const junk = await startFakeSite({ rules, host, flaky: false, garbage: true });
    try {
      const { code, out } = await runSender(s, site);
      assert.equal(code, 3, out);
      assert.ok(!out.includes(rules[1].uuid) && !out.includes('aaaa-4bbb'), `no rule id in the log: ${out}`);
      assert.match(out, /answered 404 for rule 2 of 3/);
      assert.equal(site.state.loaded.length, 0);
      const bad = await runSender(s, junk);
      assert.equal(bad.code, 3, bad.out);
      assert.match(bad.out, /not JSON/);
      assert.ok(!/Traceback|Exception|at .*\.(mjs|js|groovy):\d+/.test(bad.out), `a plain message, not a stack: ${bad.out}`);
      assert.equal(junk.state.loaded.length, 0);
    } finally {
      await site.close();
      await junk.close();
    }
  });

  // the audit log is read 50,000 records deep at most; past that the oldest day read is
  // incomplete, and pushing it whole would replace the map's complete count with a smaller one
  test(`${s.name}: an audit log past 50,000 records drops its oldest, incomplete day and shortens the window`, { ...opts, timeout: 600_000, skip: s.usageFile ? `${s.name}: reads yesterday and today within its host's time budget instead` : opts.skip }, async () => {
    const site = await startFakeSite({ rules: makeRules(3), host, flaky: false, audit: { size: 50050 } });
    try {
      const { code, out } = await runSender(s, site, { AUTOMAP_USAGE: 'off' });
      assert.equal(code, 0, out);
      assert.equal(site.state.pushed.runs.length, 1, out);
      const r = site.state.pushed.runs[0].runs;
      const read = site.state.audit.records.slice(0, 50000);
      const oldest = Math.min(...read.map((x) => x.eventTimestamp));
      const cut = oldest - (oldest % 86400000) + 86400000;
      assert.equal(r.window.start, cut, 'the window starts on the first complete day');
      const expected = site.state.audit.records.filter((x) => x.eventTimestamp >= cut).length;
      const runs = r.rows.reduce((n, x) => n + x.success + x.errors + x.noop, 0);
      assert.equal(runs, expected, out);
      assert.ok(r.rows.every((x) => Date.parse(`${x.day}T00:00:00Z`) >= cut), 'no row of the dropped day');
      assert.match(out, /shortened/);
    } finally {
      await site.close();
    }
  });

  test(`${s.name}: a wrong key stops with exit 4, an allowance with exit 5, a dry run pushes nothing`, opts, async () => {
    const site = await startFakeSite({ rules: makeRules(2), host, flaky: false });
    const later = await startFakeSite({ rules: makeRules(2), host, flaky: false, refuse: 'allowance' });
    try {
      assert.equal((await runSender(s, site, { AUTOMAP_KEY: 'amk_wrong' })).code, 4);
      assert.equal((await runSender(s, later)).code, 5);
      const dry = await runSender(s, site, {}, ['--dry-run']);
      assert.equal(dry.code, 0, dry.out);
      assert.equal(site.state.loaded.length, 0);
    } finally {
      await site.close();
      await later.close();
    }
  });
}

// usage and runs (beta): every sender reads them the same way (APPS-488)
for (const s of SENDERS) {
  const available = s.ok || s.local || dockerUp;
  const host = !s.ok && !s.local ? 'host.docker.internal' : '127.0.0.1';
  test(`${s.name}: usage and runs (beta) are pushed apart from the rules, without ids, and never fail the run`, { skip: available ? false : `${s.name}: runtime not available`, timeout: 360_000 }, async () => {
  // a sender split in two (ScriptRunner) runs its usage script after the rules one, as two jobs would
  // (whole days, as before 1.6.0: the usage job's default became hourly slices, tested below)
  const runBoth = async (site2, extra = {}) => {
    const first = await runSender(s, site2, extra);
    if (!s.usageFile) return first;
    const second = await runSender(s, site2, { AUTOMAP_RUNS_MODE: 'days', ...extra }, [], s.usageFile);
    return { code: first.code || second.code, out: first.out + second.out };
  };
  const rules = makeRules(3);
  const site = await startFakeSite({ rules, host, flaky: false, internalFlaky: true });
  const broken = await startFakeSite({ rules, host, flaky: false, usage: 'broken' });
  const lost = await startFakeSite({ rules, host, flaky: false, lose: 'usage' });
  try {
    const { code, out } = await runBoth(site);
    assert.equal(code, 0, out);
    assert.deepEqual(site.state.internalTrips, ['creditUsage', 'auditlog', 'auditlog/item/101'], 'a 500, a 429 with Retry-After and a 500 on a detail, each retried');
    assert.equal(site.state.loaded.length, 1, 'the rules, once');
    assert.equal(site.state.pushed.usage.length >= 1, true, out);
    const u = site.state.pushed.usage[site.state.pushed.usage.length - 1].usage;
    assert.equal(u.steps.total, 1310);
    assert.deepEqual(u.flows.map((f) => [f.uuid, f.runs, f.steps]), [[rules[0].uuid, 14, 1303], [rules[1].uuid, 5, 7]]);
    assert.deepEqual(u.billable.rules, [{ uuid: rules[0].uuid, runs: 14 }]);
    assert.deepEqual(u.limits, [{ product: 'JIRA_SERVICE_MANAGEMENT', used: 18, limit: 3000, edition: 'premium' }]);
    assert.ok(!JSON.stringify(site.state.pushed.usage).includes('secret'), 'no account id leaves the sender');
    assert.match(out, /usage \(beta\) \d{4}-\d{2}: pushed 1310 steps for 2 rules/);
    // with AUTOMAP_CHUNK_BYTES at 900, usage and runs go in several chunks like the rules (APPS-499)
    assert.ok(site.state.extraChunks > site.state.pushed.usage.length + site.state.pushed.runs.length, `${s.name}: usage and runs in several chunks`);

    // runs (beta): counted per rule and day, the failing component by code - and nothing else
    assert.ok(site.state.pushed.runs.length >= 1, out);
    const r = site.state.pushed.runs[site.state.pushed.runs.length - 1].runs;
    const a = r.rows.find((x) => x.uuid === rules[0].uuid);
    assert.deepEqual([a.success, a.errors, a.noop], [1, 1, 0]);
    const b = r.rows.find((x) => x.uuid === rules[1].uuid);
    assert.deepEqual([b.noop, b.edits], [1, 1]);
    // runs per UTC hour, edits not among them
    const perHour = (u) => r.rows.filter((x) => x.uuid === u)
      .reduce((n, x) => n + Object.values(x.hours || {}).reduce((m, v) => m + v, 0), 0);
    assert.equal(perHour(rules[0].uuid), 2);
    assert.equal(perHour(rules[1].uuid), 1);
    assert.deepEqual(r.errors.map((e) => [e.componentId, e.code]), [['c-branch', 'com.codebarrel.automation.rule.error.smart.value.no.object']]);
    const sent = JSON.stringify(site.state.pushed.runs);
    assert.ok(!sent.includes('secret-') && !sent.includes('10042'), 'no message text, no parameters, no work item ids');
    // inside Jira the usage job runs every hour over yesterday and today; the map keeps 35 days
    if (s.usageFile) {
      assert.match(out, /runs \(beta\) yesterday and today: pushed 3 runs, 1 with errors/);
      const y = new Date(); y.setUTCHours(0, 0, 0, 0);
      assert.equal(r.window.start, y.getTime() - 86400000, 'the window starts yesterday 00:00 UTC');
    } else {
      assert.match(out, /runs \(beta\) last 7 days: pushed 3 runs, 1 with errors/);
    }

    // the internal API gone: the rules still go, the run still succeeds
    const gone = await runBoth(broken);
    assert.equal(gone.code, 0, gone.out);
    assert.equal(broken.state.loaded.length, 1);
    assert.equal(broken.state.pushed.usage.length, 0);
    assert.match(gone.out, /usage \(beta\) skipped/);
    assert.match(gone.out, /runs \(beta\) skipped/);

    // the answer to a usage push's last chunk lost: the resend is 409, and that is the push taken
    const late = await runBoth(lost);
    assert.equal(late.code, 0, late.out);
    assert.equal(lost.state.lost, 1);
    assert.equal(lost.state.pushed.usage.length, 1, late.out);
    assert.match(late.out, /usage \(beta\) \d{4}-\d{2}: pushed 1310 steps for 2 rules/);
    assert.doesNotMatch(late.out, /usage \(beta\) \d{4}-\d{2}: not taken/);

    // switched off: not even read
    const before = site.state.usageCalls;
    assert.equal((await runBoth(site, { AUTOMAP_USAGE: 'off', AUTOMAP_RUNS: 'off' })).code, 0);
    assert.equal(site.state.usageCalls, before);
  } finally {
    await site.close();
    await broken.close();
    await lost.close();
  }
});

  test(`${s.name}: the usage job pushes the previous full UTC hour as a slice; the same hour again is dropped; RUNS_MODE=days is the old shape`, { timeout: 600_000, skip: !s.usageFile ? `${s.name}: reads whole days, no slices` : available ? false : `${s.name}: runtime not available` }, async () => {
    const site = await startFakeSite({ rules: makeRules(3), host, flaky: false, audit: { at: SLICE_AT, perHour: PER_HOUR } });
    try {
      const run = (extra) => runSender(s, site, extra, [], s.usageFile);
      await checkSlices(run, site, (r) => assert.equal(r.code, 0, r.out));
      // a bad mode is a configuration failure, found before anything is read
      const calls = site.state.usageCalls;
      const bad = await run({ AUTOMAP_NOW_MS: String(SLICE_AT), AUTOMAP_RUNS_MODE: 'hourly' });
      assert.equal(bad.code, 2, bad.out);
      assert.match(bad.out, /AUTOMAP_RUNS_MODE must be slice or days, not hourly/);
      assert.equal(site.state.usageCalls, calls, 'nothing read');
    } finally {
      await site.close();
    }
  });
}

/**
 * The hourly slices of the in-Jira usage jobs (1.6.0): with its clock fixed at SLICE_AT
 * (10:05 UTC) and the fake's log laid out by hour, the job pushes exactly the previous
 * full hour, 09:00-10:00, as `mode: "slice"`; the same job again is `queued` but dropped;
 * the hour after adds; `days` is the shape of 1.5.0 to the byte, apart from the version.
 */
const SLICE_AT = Date.UTC(2026, 9, 23, 10, 5, 0, 0);
const PER_HOUR = [3, 7, 5, 4];     // 10:00-10:05, 09:00-10:00, 08:00-09:00, 07:00-08:00
const ISO = (ms) => new Date(ms).toISOString();
const runsOf = (rows) => rows.reduce((n, x) => n + x.success + x.errors + x.noop, 0);
async function checkSlices(run, site, okay) {
  const H = 3600000;
  const at = SLICE_AT;
  const start = at - (at % H) - H;
  const end = start + H;
  const first = await run({ AUTOMAP_NOW_MS: String(at) });
  okay(first);
  // usage untouched
  const u = site.state.pushed.usage[site.state.pushed.usage.length - 1].usage;
  assert.equal(u.steps.total, 1310);
  assert.match(first.out, /usage \(beta\) 2026-10: pushed 1310 steps for 2 rules/);
  // the slice: the previous full hour, half-open, every run of it once
  assert.equal(site.state.pushed.runs.length, 1, first.out);
  const doc = site.state.pushed.runs[0];
  assert.equal(doc.runs.mode, 'slice');
  assert.deepEqual(doc.runs.window, { start, end });
  assert.equal(ISO(start), '2026-10-23T09:00:00.000Z');
  assert.equal(runsOf(doc.runs.rows), PER_HOUR[1], JSON.stringify(doc.runs.rows));
  assert.ok(doc.runs.rows.every((x) => x.day === '2026-10-23'));
  assert.equal(doc.runs.rows.reduce((n, x) => n + x.errors, 0), 1);
  assert.deepEqual(doc.runs.errors.map((e) => [e.componentId, e.code]), [['c-branch', 'com.codebarrel.automation.rule.error.smart.value.no.object']]);
  assert.ok(site.state.audit.calls.length >= 1);
  for (const c of site.state.audit.calls) assert.deepEqual([c.fromTime, c.toTime], [ISO(start), ISO(end)], JSON.stringify(c));
  assert.match(first.out, /runs \(beta\) slice 09:00\u201310:00 UTC: pushed 7 runs, 1 with errors/);
  assert.deepEqual(site.state.runsLog.map((l) => l.outcome), ['stored']);
  assert.equal(runsOf([...site.state.days.values()]), PER_HOUR[1]);

  // the same job again in the same hour (a second copy, a retry): dropped by the receiver, silently
  const again = await run({ AUTOMAP_NOW_MS: String(at + 600000) });
  okay(again);
  assert.deepEqual(site.state.runsLog.map((l) => l.outcome), ['stored', 'skipped']);
  assert.equal(runsOf([...site.state.days.values()]), PER_HOUR[1], 'counts unchanged');
  assert.match(again.out, /runs \(beta\) slice 09:00\u201310:00 UTC: pushed 7 runs, 1 with errors/);
  assert.doesNotMatch(again.out, /duplicate|already|skipped/);

  // an hour later: the next hour, added to the day
  const next = await run({ AUTOMAP_NOW_MS: String(at + H) });
  okay(next);
  const d2 = site.state.pushed.runs[2];
  assert.deepEqual(d2.runs.window, { start: end, end: end + H });
  assert.equal(runsOf(d2.runs.rows), PER_HOUR[0]);
  assert.match(next.out, /runs \(beta\) slice 10:00\u201311:00 UTC: pushed 3 runs, 0 with errors/);
  assert.deepEqual(site.state.runsLog.map((l) => l.outcome), ['stored', 'skipped', 'stored']);
  assert.equal(runsOf([...site.state.days.values()]), PER_HOUR[0] + PER_HOUR[1]);

  // RUNS_MODE=days: yesterday and today, the document of 1.5.0 - no `mode`, the same keys in the same order
  const days = await run({ AUTOMAP_NOW_MS: String(at), AUTOMAP_RUNS_MODE: 'days' });
  okay(days);
  const d3 = site.state.pushed.runs[3];
  assert.deepEqual(Object.keys(d3), ['runs', 'sender']);
  assert.deepEqual(Object.keys(d3.runs), ['window', 'rows', 'errors']);
  assert.deepEqual(d3.runs.window, { start: Date.UTC(2026, 9, 22), end: at });
  assert.equal(runsOf(d3.runs.rows), PER_HOUR.reduce((n, x) => n + x, 0));
  assert.match(days.out, /runs \(beta\) yesterday and today: pushed 19 runs, 1 with errors/);
  assert.equal(site.state.runsLog[3].outcome, 'stored');
  assert.equal(runsOf([...site.state.days.values()]), 19, 'whole days replace what the slices brought');
}

/** The part a rule belongs to: its uuid's first 8 hex digits as a number, mod M, plus 1. */
const partOf = (uuid, m) => (parseInt(uuid.slice(0, 8), 16) % m) + 1;

// JMWE renders a template instead of running a program: no exit codes, one line of output.
// It needs the nunjucks package (NUNJUCKS_DIR, a folder with node_modules/nunjucks).
const nunjucksDir = process.env.NUNJUCKS_DIR;
function runJmwe(site, extraEnv = {}) {
  const envv = { ...process.env, ...site.env, ATLASSIAN_SITE: site.env.ATLASSIAN_API_BASE, NUNJUCKS_DIR: nunjucksDir, AUTOMAP_CHUNK_BYTES: '300', ...extraEnv };
  // spawn, not spawnSync: the fake site answers from this very process
  return new Promise((resolve) => {
    const child = spawn('node', [join(root, 'jmwe/test/run-locally.mjs')], { env: envv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
test('jmwe: rules, usage and runs (beta), apart from each other, without ids, never stopping the rules', { skip: nunjucksDir ? false : 'jmwe: set NUNJUCKS_DIR to a folder with nunjucks installed', timeout: 240_000 }, async () => {
  const rules = makeRules(7);
  // flaky: a 429 with Retry-After on the second page of summaries, a 500 on the second chunk,
  // and once each a 500 and a 429 on the internal API - a template cannot wait, but it can retry
  const site = await startFakeSite({ rules, internalFlaky: true });
  const broken = await startFakeSite({ rules, flaky: false, usage: 'broken' });
  const lost = await startFakeSite({ rules, flaky: false, lose: 'usage' });
  try {
    // two Scheduled actions: the rules template alone reads no usage and no audit log
    const rulesOnly = await runJmwe(site);
    assert.equal(rulesOnly.code, 0, rulesOnly.out);
    assert.equal(site.state.loaded.length, 1, rulesOnly.out);
    assert.deepEqual(site.state.loaded[0].rules, expectedRules(rules));
    assert.ok(site.state.answers.includes('failed'), 'the 500 was met and retried');
    assert.equal(site.state.usageCalls, 0, 'the rules template leaves usage and runs to the other one');
    // whole days, as before 1.6.0: the usage template's default became hourly slices, tested below
    const { code, out } = await runJmwe(site, { JMWE_TEMPLATE: 'automap-usage.njk', AUTOMAP_RUNS_MODE: 'days' });
    assert.equal(code, 0, out);
    assert.deepEqual(site.state.internalTrips, ['creditUsage', 'auditlog', 'auditlog/item/101'], 'each refusal retried');
    assert.equal(site.state.loaded.length, 1, 'the usage template pushes no rules');
    const u = site.state.pushed.usage[site.state.pushed.usage.length - 1].usage;
    assert.equal(u.steps.total, 1310);
    assert.deepEqual(u.flows.map((f) => [f.uuid, f.runs, f.steps]), [[rules[0].uuid, 14, 1303], [rules[1].uuid, 5, 7]]);
    assert.deepEqual(u.billable.rules, [{ uuid: rules[0].uuid, runs: 14 }]);
    assert.deepEqual(u.limits, [{ product: 'JIRA_SERVICE_MANAGEMENT', used: 18, limit: 3000, edition: 'premium' }]);
    assert.ok(!JSON.stringify(site.state.pushed.usage).includes('secret'), 'no account id leaves the template');
    assert.match(out, /usage \(beta\) \d{4}-\d{2}: pushed 1310 steps for 2 rules/);
    assert.ok(site.state.extraChunks > 2, 'jmwe: usage and runs in several chunks');
    const r = site.state.pushed.runs[site.state.pushed.runs.length - 1].runs;
    const a = r.rows.find((x) => x.uuid === rules[0].uuid);
    assert.deepEqual([a.success, a.errors, a.noop], [1, 1, 0]);
    const b = r.rows.find((x) => x.uuid === rules[1].uuid);
    assert.deepEqual([b.noop, b.edits], [1, 1]);
    const perHour = (id) => r.rows.filter((x) => x.uuid === id)
      .reduce((n, x) => n + Object.values(x.hours || {}).reduce((m, v) => m + v, 0), 0);
    assert.equal(perHour(rules[0].uuid), 2);
    assert.equal(perHour(rules[1].uuid), 1);
    assert.deepEqual(r.errors.map((e) => [e.componentId, e.code]), [['c-branch', 'com.codebarrel.automation.rule.error.smart.value.no.object']]);
    const sent = JSON.stringify(site.state.pushed.runs);
    assert.ok(!sent.includes('secret-') && !sent.includes('10042'), 'no message text, no parameters, no work item ids');
    assert.match(out, /runs \(beta\) yesterday and today: pushed 3 runs, 1 with errors/);
    const y0 = new Date(); y0.setUTCHours(0, 0, 0, 0);
    assert.equal(r.window.start, y0.getTime() - 86400000, 'the window starts yesterday 00:00 UTC');
    // the day each run is filed under is the UTC day, worked out without a date library
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    assert.ok(r.rows.every((x) => x.day === today || x.day === yesterday), JSON.stringify(r.rows.map((x) => x.day)));
    // the audit log read up to the instant the window ends, on every page
    for (const c of site.state.audit.calls) {
      assert.match(String(c.toTime), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, JSON.stringify(c));
      assert.equal(Date.parse(c.toTime), r.window.end);
    }

    assert.equal((await runJmwe(broken)).code, 0);
    assert.equal(broken.state.loaded.length, 1, 'the rules go whatever the internal API does');
    const gone = await runJmwe(broken, { JMWE_TEMPLATE: 'automap-usage.njk' });
    assert.equal(gone.code, 0, gone.out);
    assert.equal(broken.state.pushed.usage.length, 0);
    assert.match(gone.out, /usage \(beta\) skipped/);
    assert.match(gone.out, /runs \(beta\) skipped/);

    // the answer to a usage push's last chunk lost: the resend is 409, and that is the push taken
    const late = await runJmwe(lost, { JMWE_TEMPLATE: 'automap-usage.njk' });
    assert.equal(late.code, 0, late.out);
    assert.equal(lost.state.lost, 1);
    assert.equal(lost.state.pushed.usage.length, 1, late.out);
    assert.match(late.out, /usage \(beta\) \d{4}-\d{2}: pushed 1310 steps for 2 rules/);

    const before = site.state.usageCalls;
    assert.equal((await runJmwe(site, { JMWE_TEMPLATE: 'automap-usage.njk', AUTOMAP_USAGE: 'off', AUTOMAP_RUNS: 'off' })).code, 0);
    assert.equal(site.state.usageCalls, before);
  } finally {
    await site.close();
    await broken.close();
    await lost.close();
  }
});

test('jmwe: a lost answer to the last chunk is not a second push; a lost chunk is sent again; the log grows under the paging', { skip: nunjucksDir ? false : 'jmwe: set NUNJUCKS_DIR to a folder with nunjucks installed', timeout: 240_000 }, async () => {
  const site = await startFakeSite({ rules: makeRules(5), flaky: false, lose: 'rules' });
  const parts = await startFakeSite({ rules: makeRules(7), flaky: false, lose: 'rules' });
  const growing = await startFakeSite({ rules: makeRules(3), flaky: false, audit: { size: 130, grow: 7 } });
  const missing = await startFakeSite({ rules: makeRules(3), flaky: false, missing: makeRules(3)[1].uuid });
  try {
    const { code, out } = await runJmwe(site);
    assert.equal(code, 0, out);
    assert.equal(site.state.lost, 1);
    assert.equal(site.state.loaded.length, 1, `${out}\n${JSON.stringify(site.state.answers)}`);
    assert.deepEqual(site.state.answers.slice(-2), ['queued', 'conflict']);
    assert.match(out, /already taken/);

    const one = await runJmwe(parts, { PART: '1/2' });
    assert.equal(one.code, 0, one.out);
    assert.match(one.out, /part 1\/2: .*already taken/);
    assert.equal(parts.state.loaded.length, 0);
    const two = await runJmwe(parts, { PART: '2/2' });
    assert.equal(two.code, 0, two.out);
    assert.equal(parts.state.loaded.length, 1, two.out);
    assert.deepEqual(new Set(uuidsOf(parts.state.loaded[0])), new Set(makeRules(7).map((r) => r.uuid)));

    const grew = await runJmwe(growing, { JMWE_TEMPLATE: 'automap-usage.njk', AUTOMAP_RUNS_MODE: 'days' });
    assert.equal(grew.code, 0, grew.out);
    const r = growing.state.pushed.runs[0].runs;
    assert.ok(growing.state.audit.calls.length >= 3);
    for (const c of growing.state.audit.calls) assert.equal(Date.parse(c.toTime), r.window.end, JSON.stringify(c));
    assert.equal(r.rows.reduce((n, x) => n + x.success + x.errors + x.noop, 0), 130, grew.out);

    // a rule the API will not give: the result line says which read failed, never the rule's id
    const gone = await runJmwe(missing);
    assert.match(gone.out, /failed - \[3\] the Automation API answered 404 for rule 2 of 3/, gone.out);
    assert.ok(!gone.out.includes('aaaa-4bbb'), `no rule id in the log: ${gone.out}`);
    assert.equal(missing.state.loaded.length, 0);
  } finally {
    await site.close();
    await parts.close();
    await growing.close();
    await missing.close();
  }
});

// the rules in parts (1.4.0): two Scheduled actions, PART = "1/2" and "2/2", build one map
test('jmwe: PART "1/2" then "2/2" push two slices of one day\'s run, and the map has every rule', { skip: nunjucksDir ? false : 'jmwe: set NUNJUCKS_DIR to a folder with nunjucks installed', timeout: 240_000 }, async () => {
  const rules = makeRules(7);
  const site = await startFakeSite({ rules, flaky: false });
  try {
    const first = await runJmwe(site, { PART: '1/2' });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /part 1\/2: 4 rules pushed, waiting for the other part/);
    assert.equal(site.state.loaded.length, 0, 'half the rules build nothing');
    assert.equal(site.state.answers[site.state.answers.length - 1], 'accepted');

    const second = await runJmwe(site, { PART: '2/2' });
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /part 2\/2: 3 rules pushed, map queued/);
    assert.equal(site.state.answers[site.state.answers.length - 1], 'queued');
    assert.equal(site.state.loaded.length, 1, second.out);
    assert.deepEqual(new Set(uuidsOf(site.state.loaded[0])), new Set(rules.map((r) => r.uuid)), 'every rule, once');
    assert.deepEqual([...site.state.senders], [`jmwe/${versionOf('jmwe')}`]);

    const run = todayRun();
    assert.ok(site.state.requests.every((r) => r.run === run && /^[12]\/2$/.test(r.part)), JSON.stringify(site.state.requests));
    assert.ok(site.state.requests.length > 2, 'small chunks mean several requests per part');
    const group = site.state.partRuns.get(run);
    const sorted = rules.map((r) => r.uuid).sort();
    assert.deepEqual(uuidsOf(group.done.get(1)), sorted.filter((u) => partOf(u, 2) === 1));
    assert.deepEqual(uuidsOf(group.done.get(2)), sorted.filter((u) => partOf(u, 2) === 2));

    // the same part again today: 409, said plainly in the result line
    const again = await runJmwe(site, { PART: '1/2' });
    assert.match(again.out, /HTTP 409 \(today's map is already built/);
    assert.equal(site.state.loaded.length, 1);

    // a bad PART is a configuration error, found before anything is read
    for (const bad of ['2/1', 'x', '1/1', '0/2', '1/21', '1/2/3']) {
      const calls = site.state.apiCalls.length;
      const r = await runJmwe(site, { PART: bad });
      assert.match(r.out, new RegExp(`^automap-sync jmwe ${versionOf('jmwe').replace(/\./g, '\\.')}: failed - \\[2\\] PART must be`), `PART=${bad}: ${r.out}`);
      assert.equal(site.state.apiCalls.length, calls, `PART=${bad}: nothing read`);
    }
    // so is a JMWE without a clock: a part cannot name its day, and must not push as 1970's
    const calls = site.state.apiCalls.length;
    const noClock = await runJmwe(site, { PART: '1/2', JMWE_NO_CLOCK: '1' });
    assert.match(noClock.out, /^automap-sync jmwe \d+\.\d+\.\d+: failed - \[2\] no clock \(now\): parts need the UTC date/, noClock.out);
    assert.equal(site.state.apiCalls.length, calls, 'nothing read without a clock');
    assert.ok(!site.state.requests.some((r) => r.run === 'd19700101'), 'no push under 1970');
    // without PART nothing changes on the wire
    const plain = await startFakeSite({ rules: makeRules(3), flaky: false });
    try {
      assert.equal((await runJmwe(plain)).code, 0);
      assert.ok(plain.state.requests.every((r) => !r.part && r.run.startsWith('jmwe-')), JSON.stringify(plain.state.requests));
    } finally {
      await plain.close();
    }
    // two rules deleted between the copies move no other rule across the cut
    const eight = makeRules(8);
    const shrinking = await startFakeSite({ rules: eight, flaky: false });
    try {
      const one = await runJmwe(shrinking, { PART: '1/2' });
      assert.equal(one.code, 0, one.out);
      const carried = eight.filter((r) => partOf(r.uuid, 2) === 1);
      eight.splice(eight.indexOf(carried[0]), 1);
      eight.splice(eight.indexOf(carried[1]), 1);
      const two = await runJmwe(shrinking, { PART: '2/2' });
      assert.equal(two.code, 0, two.out);
      assert.equal(shrinking.state.loaded.length, 1, two.out);
      assert.deepEqual(new Set(uuidsOf(shrinking.state.loaded[0])), new Set(makeRules(8).map((r) => r.uuid)), 'every rule listed that day, once');
    } finally {
      await shrinking.close();
    }
  } finally {
    await site.close();
  }
});

test('jmwe: the usage template pushes the previous full UTC hour as a slice; the same hour again is dropped; RUNS_MODE=days is the old shape', { skip: nunjucksDir ? false : 'jmwe: set NUNJUCKS_DIR to a folder with nunjucks installed', timeout: 240_000 }, async () => {
  const site = await startFakeSite({ rules: makeRules(3), flaky: false, audit: { at: SLICE_AT, perHour: PER_HOUR } });
  try {
    const run = (extra) => runJmwe(site, { JMWE_TEMPLATE: 'automap-usage.njk', ...extra });
    await checkSlices(run, site, (r) => assert.equal(r.code, 0, r.out));
    // a bad mode is a configuration failure, found before anything is read
    const calls = site.state.usageCalls;
    const bad = await run({ AUTOMAP_NOW_MS: String(SLICE_AT), AUTOMAP_RUNS_MODE: 'hourly' });
    assert.match(bad.out, new RegExp(`^automap-sync jmwe ${versionOf('jmwe').replace(/\./g, '\\.')} usage: failed - \\[2\\] RUNS_MODE must be "slice" or "days", not "hourly"`), bad.out);
    assert.equal(site.state.usageCalls, calls, 'nothing read');
  } finally {
    await site.close();
  }
});

// what ships next to the senders: the CI examples, the image and its release
test('the published files: GitLab runs the image through Docker, the release is pinned, the image tag is the Python version', () => {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const gitlab = read('ci/gitlab-ci.yml');
  assert.doesNotMatch(gitlab, /name:\s*ghcr\.io\/moy-apps\/automap-sync/, 'a distroless image has no shell for GitLab to run script: in');
  assert.match(gitlab, /docker run .*ghcr\.io\/moy-apps\/automap-sync:1/);
  const release = read('.github/workflows/release.yml');
  for (const m of release.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}\b/, `${m[1]}: pin the action by commit`);
  assert.match(release, /automap_sync\.py/, 'the image tags come from VERSION in the Python sender');
  const docker = read('docker/Dockerfile');
  assert.match(docker, /^FROM \S+@sha256:[0-9a-f]{64}/m, 'the base image is pinned by digest');
  assert.match(read('powershell/automap-sync.ps1').split('\n').slice(0, 2).join('\n'), /^#Requires -Version 7\.2$/m);
  // one version per sender, in the file, the README's matrix and the package
  const api = read('API.md');
  for (const name of ['python', 'node', 'bash', 'powershell', 'scriptrunner', 'jmwe']) {
    const v = versionOf(name);
    assert.ok(api.split('\n').some((l) => l.startsWith(`| ${v} |`) && l.includes(name)), `API.md: no version-matrix row for ${name} ${v}`);
  }
  assert.equal(versionOf('scriptrunnerUsage'), versionOf('scriptrunner'), 'both ScriptRunner scripts carry one version');
  assert.equal(versionOf('jmweUsage'), versionOf('jmwe'), 'both JMWE templates carry one version');
});
