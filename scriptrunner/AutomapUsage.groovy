/*
 * automap-sync usage (ScriptRunner for Jira Cloud) - push this month's automation usage and
 * the audit log to Automation Map (BETA, Advanced edition), as a ScriptRunner Scheduled Job
 * of its own, next to AutomapSync.groovy, which pushes the rules.
 *
 * Reads, with the same Script Variables as AutomapSync.groovy, this month's steps, Rovo
 * credits and flow runs per rule, and the audit log of the previous full UTC hour folded
 * into per-rule, per-day counts, from the internal API behind Jira's Usage and Audit log
 * tabs, and pushes them as two separate pushes. That API is undocumented and can change: a
 * failure there is logged and never fails the job. No account ids, no issue ids and no
 * message text leave the job. A usage push spends no load of the map, so schedule this job
 * every hour: each run reads one hour of the log, which fits ScriptRunner's time limit on
 * any site, and the map keeps 35 days of what the runs bring.
 *
 * The runs go as hourly SLICES (1.6.0): a run started at 10:05 reads 09:00:00.000 up to
 * (not including) 10:00:00.000 UTC and pushes it as one slice; the map adds it to the day
 * and takes each hour once, so the same hour pushed again changes nothing. The hour is cut
 * by the clock, not by what was pushed before: a run that did not happen (ScriptRunner
 * paused, the job disabled for a while) leaves its hour out of the map. Schedule the job
 * every hour, and run ONE copy of it.
 *
 * SETUP: the Script Variables of AutomapSync.groovy, nothing more. Script Console: Run to
 * try it (AUTOMAP_DRY_RUN = 1 reads and sends nothing); then Scheduled Jobs -> Create, run as
 * a Jira administrator, every hour, and paste this script.
 *
 * Rarely needed: AUTOMAP_USAGE = off, AUTOMAP_RUNS = off, AUTOMAP_RUNS_MODE = days (the
 * behaviour before 1.6.0: whole days, the last AUTOMAP_RUNS_DAYS of them - 1 is yesterday
 * and today - each push replacing those days on the map; for a one-off backfill, then back
 * to slice), ATLASSIAN_CLOUD_ID.
 *
 * Limits: the audit log is read only while the run has time left (200 s); if it does not
 * fit, the runs are skipped, not sent in part - a partial slice would count as the whole
 * hour. An hour is a few pages and never gets there; in days mode set AUTOMAP_RUNS_DAYS lower.
 *
 * From 1.5.0: the internal API is retried like the Automation API, honouring Retry-After;
 * the audit log is read up to the instant the window ends (toTime); a 409 to a last chunk
 * sent again (its first answer lost) means the receiver took the first copy.
 * From 1.6.0: the runs as hourly slices (mode "slice" in the document), AUTOMAP_RUNS_MODE.
 *
 * Tests only: AUTOMAP_NOW_MS (Unix ms) stops the clock at that instant, so a test can
 * place the slice. Do not set it on a site.
 *
 * Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
 */
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.security.MessageDigest

final String NAME = 'scriptrunner'
final String VERSION = '1.6.0'
final long STARTED = System.currentTimeMillis()
// ScriptRunner Cloud stops a script after a few minutes; the runs (beta) are read only
// while there is time left, and skipped rather than sent in part when there is not
final long BUDGET_MS = 200000L


// Script Variables arrive as variables of the script (ScriptRunner resolves them by name,
// not always through binding.hasVariable); the environment is for local runs.
def lookup = { String k ->
  def v = null
  try { v = binding.getVariable(k) } catch (MissingPropertyException ignore) { v = null }
  if (v == null) { try { v = this."$k" } catch (MissingPropertyException ignore) { v = null } }
  if (v == null) v = System.getenv(k)
  v
}
def cfg = { String k, String fallback = null ->
  def v = lookup(k)
  v = v ? v.toString() : fallback
  if (!v) throw new IllegalStateException("[2] ${k} is not set")
  v
}
def say = { String m ->
  def line = "automap-sync ${NAME} ${VERSION}: ${m}"
  if (binding.hasVariable('logger')) binding.getVariable('logger').info(line) else System.err.println(line)
}


boolean dryRun = lookup('AUTOMAP_DRY_RUN')?.toString() == '1'
// the clock: now, or the instant a test stopped it at (AUTOMAP_NOW_MS, never on a site)
String nowOverride = lookup('AUTOMAP_NOW_MS')?.toString()
final long NOW_MS = nowOverride?.isLong() ? nowOverride.toLong() : System.currentTimeMillis()
// the runs (beta) as hourly slices (the default from 1.6.0) or as whole days (AUTOMAP_RUNS_DAYS)
String runsMode = lookup('AUTOMAP_RUNS_MODE')?.toString()?.toLowerCase() ?: 'slice'
if (!(runsMode in ['slice', 'days'])) throw new IllegalStateException("[2] AUTOMAP_RUNS_MODE must be slice or days, not ${runsMode}")
String auth = 'Basic ' + "${cfg('ATLASSIAN_EMAIL')}:${cfg('ATLASSIAN_API_TOKEN')}".bytes.encodeBase64().toString()
String api = cfg('ATLASSIAN_API_BASE', 'https://api.atlassian.com').replaceAll('/$', '')

String cloud = lookup('ATLASSIAN_CLOUD_ID')?.toString()
if (!cloud) {
  // ATLASSIAN_SITE names the site; without it, the site this script runs on: inside
  // ScriptRunner a relative Unirest call goes to the current site
  String site = lookup('ATLASSIAN_SITE')?.toString()
  String where = site ? ((site.contains('://') ? site : "https://${site}").replaceAll('/$', '') + '/_edge/tenant_info') : '/_edge/tenant_info'
  def r = Unirest.get(where).asString()
  if (r.status != 200) throw new IllegalStateException("[3] could not read the cloud id of ${site ?: 'this site'} (HTTP ${r.status})")
  cloud = new JsonSlurper().parseText(r.body).cloudId
}

def word = { String body -> try { new JsonSlurper().parseText(body ?: '{}').error ?: '' } catch (Exception e) { '' } }

boolean off = { String k -> (lookup(k)?.toString()?.toLowerCase() ?: '') in ['off', '0', 'false', 'no'] }.call('AUTOMAP_USAGE')
boolean runsOff = (lookup('AUTOMAP_RUNS')?.toString()?.toLowerCase() ?: '') in ['off', '0', 'false', 'no']
String internal = "${api}/automation/internal-api/jira/${cloud}/pro/rest/GLOBAL/"

// the internal API behind Jira's Usage and Audit log tabs (BETA, undocumented): a 429
// (Retry-After honoured), a 5xx or no answer is tried three times with the Automation API's
// backoff; anything else throws, which the callers turn into "skipped"
def internalCall = { String path, Object body = null ->
  int status = 0
  long wait = 1000
  for (int attempt = 1; attempt <= 3; attempt++) {
    def r = null
    try {
      r = body == null
        ? Unirest.get(internal + path).header('Authorization', auth).header('Accept', 'application/json').asString()
        : Unirest.post(internal + path).header('Authorization', auth).header('Accept', 'application/json')
            .header('Content-Type', 'application/json').body(JsonOutput.toJson(body)).asString()
      status = r.status
      if (status == 200) return new JsonSlurper().parseText(r.body)
    } catch (Exception e) {
      status = 0
    }
    if (status != 0 && status != 429 && status < 500) break
    if (attempt < 3) {
      String after = r ? r.headers.getFirst('Retry-After') : ''
      Thread.sleep(after?.isInteger() ? after.toInteger() * 1000L : wait + (long) (Math.random() * 500))
      wait = Math.min(wait * 2, 15000L)
    }
  }
  throw new IllegalStateException("${path.tokenize('?')[0]} answered ${status}")
}

// compact, ASCII-only JSON of a document built here
def asciiJson = { Object doc ->
  String j = JsonOutput.toJson(doc)
  StringBuilder b = new StringBuilder(j.length())
  for (int i = 0; i < j.length(); i++) {
    char c = j.charAt(i)
    if ((int) c > 0x7f) b.append(String.format('\\u%04x', (int) c)) else b.append(c)
  }
  b.toString()
}

// usage or runs (beta), in chunks like the rules; the receiver keeps them whole on the last one
def pushKind = { String kind, String text ->
  byte[] bytes = text.getBytes('US-ASCII')
  String whole = MessageDigest.getInstance('SHA-256').digest(bytes).encodeHex().toString()
  int size = cfg('AUTOMAP_CHUNK_BYTES', '200000').toInteger()
  List<byte[]> parts = []
  for (int i = 0; i < bytes.length; i += size) parts << Arrays.copyOfRange(bytes, i, Math.min(i + size, bytes.length))
  String run = UUID.randomUUID().toString().replace('-', '')
  def r = null
  for (int seq = 0; seq < parts.size(); seq++) {
    Map<String, String> h = [
      'Authorization'   : "Bearer ${cfg('AUTOMAP_KEY')}".toString(),
      'Content-Type'    : 'text/plain; charset=utf-8',
      'X-Automap-Run'   : run,
      'X-Automap-Seq'   : seq.toString(),
      'X-Automap-Sender': "${NAME}/${VERSION}".toString(),
      'X-Automap-Kind'  : kind,
    ]
    if (seq == parts.size() - 1) { h['X-Automap-Last'] = '1'; h['X-Automap-Sha256'] = whole }
    int tries = 1
    for (; tries <= 3; tries++) {
      try { r = Unirest.post(cfg('AUTOMAP_URL')).headers(h).body(parts[seq]).asString() } catch (Exception e) { r = null }
      int st = r ? r.status : 0
      if (st != 0 && st < 500 && st != 429) break
      if (tries < 3) Thread.sleep(1000L << tries)
    }
    if (r && r.status == 409 && tries > 1 && seq == parts.size() - 1) {
      // the first copy of the last chunk was taken and closed the run; its answer was lost
      // on the way back. Nothing to send again: the push is done.
      say("${kind} (beta): the last chunk was already taken; the push went through")
      return [status: 202, body: '{"accepted":true,"queued":true}']
    }
    if (!r || r.status != 202) break
  }
  r ?: [status: 0, body: '']
}

def n0 = { v -> v == null ? 0 : v }
// the receiver shut the door on the usage (403: switched off, or not on this plan): no runs either
List<Boolean> shut = [false]

// Automation usage (BETA): this month so far, and in its first three days the month before
def pushUsage = { ->
  if (off) return
  try {
    def now = Calendar.getInstance(TimeZone.getTimeZone('UTC'))
    now.timeInMillis = NOW_MS
    long nowMs = NOW_MS
    def first = Calendar.getInstance(TimeZone.getTimeZone('UTC'))
    first.clear(); first.set(now.get(Calendar.YEAR), now.get(Calendar.MONTH), 1)
    def label = { Calendar c -> String.format('%04d-%02d', c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1) }
    List periods = []
    if (now.get(Calendar.DAY_OF_MONTH) <= 3) {
      def prev = (Calendar) first.clone(); prev.add(Calendar.MONTH, -1)
      periods << [prev.timeInMillis, first.timeInMillis - 1, label(prev)]
    }
    periods << [first.timeInMillis, nowMs, label(first)]
    periods.each { pd ->
      long start = pd[0], end = pd[1]
      String month = pd[2]
      def credit = internalCall("creditUsage?startTime=${start}&endTime=${end}")
      def pair = { c -> [total: n0(c?.total), jira: n0(c?.currentProduct), other: n0(c?.everywhereElse)] }
      Map byRule = [:]
      // sortBy also filters to rules with that metric above zero: read both and merge
      ['automationCredits', 'rovoCredits'].each { sortBy ->
        int seenFlows = 0
        for (int page = 0; page < 100; page++) {
          def r = internalCall("highUsageFlows?limit=100&page=${page}&sortBy=${sortBy}&startTime=${start}&endTime=${end}")
          def flows = r.flows ?: []
          flows.each { f ->
            if (!f.ruleUuid) return
            byRule[f.ruleUuid.toString()] = [uuid: f.ruleUuid, name: f.ruleName ?: '', state: f.state ?: 'ENABLED',
              runs: n0(f.runs), steps: n0(f.automationCredits), rovo: n0(f.rovoCredits),
              deleted: f.deleted == true, agentic: f.containsAgentic == true]
          }
          seenFlows += flows.size()
          if (!flows || seenFlows >= n0(r.totalCount)) break
        }
      }
      Map u = [period: [start: start, end: end], steps: pair(credit.automation), rovo: pair(credit.rovo), flows: byRule.values() as List]
      // the rest is the current billing model, and the least stable part: each piece optional
      try {
        def top = internalCall("highestUsages?limit=100&month=${month}")
        u.billable = [month: month, rules: top.findAll { it.ruleIdUuid }.collect { [uuid: it.ruleIdUuid, runs: n0(it.executionCount)] }]
      } catch (Exception ignore) { }
      try {
        def ws = internalCall('pagecontext')?.tenantPageContext?.usage?.workspaceUsages
        if (ws instanceof Map) u.limits = ws.collect { k, v -> [product: k, used: n0(v.executionsUsed), limit: n0(v.executionLimit), edition: v.edition ?: ''] }
      } catch (Exception ignore) { }
      try {
        u.trend = (internalCall('usageTrendData').data ?: []).collect { [month: it.month, runs: it.workspaceCounts ?: [:]] }
      } catch (Exception ignore) { }
      try { u.creditPack = internalCall('hasCreditPack').hasCreditPack == true } catch (Exception ignore) { }
      Map doc = [usage: u, sender: [name: NAME, version: VERSION]]
      String text = asciiJson(doc)
      if (dryRun) { say("usage (beta) ${month}: ${u.steps.total} steps, ${u.flows.size()} rules with usage; nothing pushed"); return }
      def r = pushKind('usage', text)
      if (r.status == 403) shut[0] = true
      if (r.status == 202) say("usage (beta) ${month}: pushed ${u.steps.total} steps for ${u.flows.size()} rules")
      else say("usage (beta) ${month}: not taken, receiver answered ${r.status} ${word(r.body)}")
    }
  } catch (Exception e) {
    say("usage (beta) skipped: ${e.message}")
  }
}

// the audit log (BETA), folded into what the map needs
def pushRuns = { ->
  if (runsOff) return
  if (shut[0]) { say('runs (beta) skipped: the map does not take them (403)'); return }
  try {
    boolean slice = runsMode == 'slice'
    int days = 1
    long nowMs = NOW_MS
    long start, end
    String span
    if (slice) {
      // the previous full UTC hour, half-open [start, end): at 10:05, 09:00:00.000 to 10:00:00.000
      end = nowMs - nowMs % 3600000L
      start = end - 3600000L
      def hhmm = { long ms -> String.format('%02d:00', (int) ((ms % 86400000L) / 3600000L)) }
      span = "slice ${hhmm(start)}\u2013${hhmm(end)} UTC".toString()
    } else {
      // whole days (the behaviour before 1.6.0): yesterday and today, or AUTOMAP_RUNS_DAYS of them
      String d = lookup('AUTOMAP_RUNS_DAYS')?.toString()
      if (d?.isInteger()) days = Math.max(1, Math.min(30, d.toInteger()))
      start = nowMs - days * 86400000L
      start -= start % 86400000L          // whole days, so a day pushed is a day complete
      end = nowMs
      span = days == 1 ? 'yesterday and today' : "last ${days} days"
    }
    // the log is newest first and paged by offset: runs landing while it is read would
    // shift every page, so the read ends at the instant the window does (toTime)
    def fmt = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
    fmt.timeZone = TimeZone.getTimeZone('UTC')
    def dayOf = { long ms -> def f = new java.text.SimpleDateFormat('yyyy-MM-dd'); f.timeZone = TimeZone.getTimeZone('UTC'); f.format(new Date(ms)) }
    List records = []
    for (int offset = 0; offset < 50000; offset += 50) {   // 50 a page whatever is asked; `total` is always 0
      if (System.currentTimeMillis() - STARTED > BUDGET_MS) {
        // never a part of it: a partial slice would count as the whole hour
        throw new IllegalStateException(slice
          ? "the audit log of ${span} did not fit in this run; that hour is left out"
          : "the audit log of ${days} days did not fit in this run; set AUTOMAP_RUNS_DAYS lower")
      }
      def page = internalCall('auditlog', [fromTime: fmt.format(new Date(start)), toTime: fmt.format(new Date(end)), offset: offset, limit: 50])?.items?.items ?: []
      records.addAll(page)
      if (page.size() < 50) break
      // newest first: a page reaching past the window's start is the last one worth reading
      if (slice && page.any { (it.eventTimestamp ?: it.startTime ?: end) < start }) break
    }
    Map rows = [:]
    Map failed = [:]
    records.each { r ->
      String u = r.ruleIdUuid
      def t = r.eventTimestamp ?: r.startTime
      if (!u || !t || t < start || (slice && t >= end)) return
      long tm = t as long
      String day = dayOf(tm)
      String k = u + '|' + day
      if (!rows.containsKey(k)) rows[k] = [uuid: u, day: day, name: r.ruleName ?: '', success: 0, errors: 0, noop: 0, edits: 0, ms: 0, maxMs: 0]
      Map row = rows[k]
      String cat = r.category
      if (cat == 'CONFIG_CHANGE') { row.edits += 1; return }
      if (cat == 'SUCCESS') row.success += 1 else if (cat == 'NO_ACTIONS_PERFORMED') row.noop += 1 else row.errors += 1
      // runs per UTC hour, only the hours that had any: a burst is hundreds of runs in one hour
      def cal = Calendar.getInstance(TimeZone.getTimeZone('UTC')); cal.timeInMillis = tm
      String hour = cal.get(Calendar.HOUR_OF_DAY).toString()
      if (!row.hours) row.hours = [:]
      row.hours[hour] = n0(row.hours[hour]) + 1
      long ms = n0(r.durationMs) as long
      row.ms += ms
      row.maxMs = Math.max(row.maxMs as long, ms)
      if (cat != 'SUCCESS' && cat != 'NO_ACTIONS_PERFORMED' && r.id) {
        if (!failed.containsKey(u)) failed[u] = []
        failed[u] << r
      }
    }
    List errors = []
    int budget = 40                     // one request per failed run read in full; two per rule at most
    failed.each { u, list ->
      list.sort { -(n0(it.eventTimestamp) as long) }.take(2).each { r ->
        if (budget <= 0 || System.currentTimeMillis() - STARTED > BUDGET_MS) return
        budget -= 1
        def detail
        try { detail = internalCall("auditlog/item/${r.id}") } catch (Exception ignore) { return }
        (detail?.content?.componentLogs ?: []).each { cl ->
          def res = cl.executionResult ?: [:]
          def keys = (cl.changes ?: []).findAll { it?.payload?.type == 'ERROR' }.collect { it.payload.key ?: '' }
          String errCode = (keys ? keys[0] : '') ?: res.auditEventErrorType ?: res.errorType ?: ''
          if (!errCode && res.state != 'SOME_ERRORS') return
          def comp = cl.component ?: [:]
          errors << [uuid: u, componentId: comp.id ?: '', componentType: comp.componentType ?: '', type: comp.type ?: '',
                     code: errCode ?: 'SOME_ERRORS', at: n0(r.eventTimestamp)]
        }
      }
    }
    // a slice says so (mode); whole days are the document of 1.5.0, unchanged
    Map runs = slice ? [mode: 'slice'] : [:]
    runs << [window: [start: start, end: end], rows: rows.values() as List, errors: errors]
    Map doc = [runs: runs, sender: [name: NAME, version: VERSION]]
    String text = asciiJson(doc)
    int total = runs.rows.sum(0) { it.success + it.errors + it.noop }
    int bad = runs.rows.sum(0) { it.errors }
    if (dryRun) { say("runs (beta) ${span}: ${total} runs, ${bad} with errors; nothing pushed"); return }
    def r = pushKind('runs', text)
    if (r.status == 202) say("runs (beta) ${span}: pushed ${total} runs, ${bad} with errors")
    else say("runs (beta): not taken, receiver answered ${r.status} ${word(r.body)}")
  } catch (Exception e) {
    say("runs (beta) skipped: ${e.message}")
  }
}


pushUsage()
pushRuns()
return 'usage and runs (beta): done'
