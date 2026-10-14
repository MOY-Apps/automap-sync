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

/** The version a sender announces, read from its own file so a release never has to touch this test. */
const FILES = {
  python: 'python/automap_sync.py', node: 'node/automap-sync.mjs', bash: 'bash/automap-sync.sh',
  powershell: 'powershell/automap-sync.ps1', scriptrunner: 'scriptrunner/AutomapSync.groovy',
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
    run: (e, envv, local) => (local
      ? ['groovy', [join(root, 'scriptrunner/test/run-locally.groovy'), join(root, 'scriptrunner/AutomapSync.groovy')]]
      : ['docker', ['run', '--rm', '-v', `${root}:/s:ro`, ...dockerEnv(envv), ...PLATFORM,
        'groovy:4.0-jdk17', 'groovy', '/s/scriptrunner/test/run-locally.groovy', '/s/scriptrunner/AutomapSync.groovy']]),
    dryRunByEnv: true,
  },
];

function dockerEnv(envv) {
  return Object.entries(envv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

function runSender(s, site, extraEnv = {}, args = []) {
  const envv = { ...site.env, AUTOMAP_CHUNK_BYTES: '900', ...extraEnv };
  if (s.dryRunByEnv && args.includes('--dry-run')) envv.AUTOMAP_DRY_RUN = '1';
  const [cmd, argv] = s.run(args, envv, s.local);
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

// usage (beta): only the Python sender reads it so far
const py = SENDERS.find((x) => x.name === 'python');
test('python: usage (beta) is pushed apart from the rules, without account ids, and never fails the run', { skip: py.ok ? false : 'no python3', timeout: 120_000 }, async () => {
  const rules = makeRules(3);
  const site = await startFakeSite({ rules, flaky: false });
  const broken = await startFakeSite({ rules, flaky: false, usage: 'broken' });
  try {
    const { code, out } = await runSender(py, site);
    assert.equal(code, 0, out);
    assert.equal(site.state.loaded.length, 1, 'the rules, once');
    assert.equal(site.state.pushed.usage.length >= 1, true, out);
    const u = site.state.pushed.usage[site.state.pushed.usage.length - 1].usage;
    assert.equal(u.steps.total, 1310);
    assert.deepEqual(u.flows.map((f) => [f.uuid, f.runs, f.steps]), [[rules[0].uuid, 14, 1303], [rules[1].uuid, 5, 7]]);
    assert.deepEqual(u.billable.rules, [{ uuid: rules[0].uuid, runs: 14 }]);
    assert.deepEqual(u.limits, [{ product: 'JIRA_SERVICE_MANAGEMENT', used: 18, limit: 3000, edition: 'premium' }]);
    assert.ok(!JSON.stringify(site.state.pushed.usage).includes('secret'), 'no account id leaves the sender');
    assert.match(out, /usage \(beta\) \d{4}-\d{2}: pushed 1310 steps for 2 rules/);

    // runs (beta): counted per rule and day, the failing component by code - and nothing else
    assert.ok(site.state.pushed.runs.length >= 1, out);
    const r = site.state.pushed.runs[site.state.pushed.runs.length - 1].runs;
    const a = r.rows.find((x) => x.uuid === rules[0].uuid);
    assert.deepEqual([a.success, a.errors, a.noop], [1, 1, 0]);
    const b = r.rows.find((x) => x.uuid === rules[1].uuid);
    assert.deepEqual([b.noop, b.edits], [1, 1]);
    assert.deepEqual(r.errors.map((e) => [e.componentId, e.code]), [['c-branch', 'com.codebarrel.automation.rule.error.smart.value.no.object']]);
    const sent = JSON.stringify(site.state.pushed.runs);
    assert.ok(!sent.includes('secret-') && !sent.includes('10042'), 'no message text, no parameters, no work item ids');
    assert.match(out, /runs \(beta\) last 7 days: pushed 3 runs, 1 with errors/);

    // the internal API gone: the rules still go, the run still succeeds
    const gone = await runSender(py, broken);
    assert.equal(gone.code, 0, gone.out);
    assert.equal(broken.state.loaded.length, 1);
    assert.equal(broken.state.pushed.usage.length, 0);
    assert.match(gone.out, /usage \(beta\) skipped/);
    assert.match(gone.out, /runs \(beta\) skipped/);

    // switched off: not even read
    const before = site.state.pushed.usageCalls;
    assert.equal((await runSender(py, site, { AUTOMAP_USAGE: 'off', AUTOMAP_RUNS: 'off' })).code, 0);
    assert.equal(site.state.pushed.usageCalls, before);
  } finally {
    await site.close();
    await broken.close();
  }
});
