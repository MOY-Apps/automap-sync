/*
 * automap-sync (ScriptRunner for Jira Cloud) - push this site's automation rules to
 * Automation Map, as a ScriptRunner Scheduled Job.
 *
 * Reads every automation rule with an Atlassian API token kept in ScriptRunner's Script
 * Variables, and pushes them to the Automation Map push receiver with the key the app
 * issued. Contract: docs/push-sync.md.
 *
 * This is the first of two scripts. AutomapUsage.groovy, a job of its own, pushes this
 * month's usage and the audit log (beta, Advanced edition); each job gets ScriptRunner's
 * whole time limit, and a slow audit log never holds up the rules.
 *
 * SETUP
 *
 * 1. ScriptRunner -> Settings -> Script Variables. Add four variables, one per line below
 *    (Name = Value). Tick "secret" on the two marked SECRET.
 *
 *      ATLASSIAN_EMAIL      = the e-mail of a Jira administrator, best a service account
 *      ATLASSIAN_API_TOKEN  = that account's API token, made at id.atlassian.com ->
 *                             Security -> API tokens WITH THE AUTOMATION SCOPE      SECRET
 *      AUTOMAP_URL          = the receiver address from Automation Map's set-up guide,
 *                             ending /v1/push
 *      AUTOMAP_KEY          = the amk_ key from the same guide (shown once)        SECRET
 *
 *    Not needed: ATLASSIAN_SITE. The script uses the Jira site it runs in. Set it only to
 *    read the rules of a different site (your-site.atlassian.net).
 *
 * 2. Try it: ScriptRunner -> Script Console. Add one more variable, AUTOMAP_DRY_RUN = 1,
 *    paste this script, Run. It reads every rule and sends nothing; the log says how many.
 *    Delete AUTOMAP_DRY_RUN and run again to push.
 *
 * 3. Schedule it: ScriptRunner -> Scheduled Jobs -> Create, run as a Jira administrator,
 *    once a day, and paste this script.
 *
 * Rarely needed: ATLASSIAN_CLOUD_ID (skips looking it up), AUTOMAP_CHUNK_BYTES (200000).
 *
 * Limits: a ScriptRunner Cloud script has a time limit per run. Reading a rule takes one
 * request, so a site with more than a few hundred rules may not finish in one run - split
 * the job (below) or use the Python sender or the Docker image. The job fails with a
 * message starting "[n]" where n is the exit code the other senders use (2 a setting,
 * 4 refused, 5 try later, 6 failed).
 *
 * MANY RULES: PART
 *
 * A site past the time limit runs this script as several Scheduled Jobs, each pushing a
 * slice of the rules. Leave PART empty on a small site. To split in two: make two jobs
 * with this script, an hour apart, with the same Script Variables except PART = 1/2 on
 * the first and PART = 2/2 on the second. Each pushes its half; the map is built when
 * the last half of the day has arrived. Three jobs are 1/3, 2/3, 3/3, up to 20. The
 * limit is honest: each copy must finish within ScriptRunner's time limit; raise M until
 * it does. Each rule's part is a function of its own id (its uuid's first 8 hex digits
 * modulo M), so a rule made or deleted between the jobs moves no other rule across the
 * cut; the slices are therefore roughly, not exactly, equal. A rule made between the two
 * jobs may be missed until the next day. The copies find each other by the UTC date they
 * start on, so schedule them inside the same UTC day - e.g. 01:00 and 02:00 UTC - never
 * either side of 00:00 UTC.
 *
 * From 1.5.0: a 409 to a last chunk sent again (its first answer lost) means the receiver
 * took the first copy - the push is done, no second run.
 *
 * Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
 */
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.security.MessageDigest

final String NAME = 'scriptrunner'
final String VERSION = '1.5.0'
final Set<Integer> REFUSED = [400, 401, 402, 403, 404, 405, 413, 426] as Set


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

// PART = N/M: this job pushes the Nth of M slices of the rules (see the header); empty = all
String partText = lookup('PART')?.toString()?.trim() ?: ''
int partN = 0
int partM = 0
if (partText) {
  def pm = partText =~ /^(\d{1,2})\/(\d{1,2})$/
  if (pm.matches()) { partN = pm.group(1).toInteger(); partM = pm.group(2).toInteger() }
  if (!pm.matches() || partM < 2 || partM > 20 || partN < 1 || partN > partM) {
    throw new IllegalStateException("[2] PART must be N/M with 1 <= N <= M <= 20 (e.g. 1/2), or empty; got '${partText}'")
  }
}
String part = partM ? "${partN}/${partM}".toString() : ''
// parts of one day share the run: the UTC date, stamped now rather than after the minutes
// of reading, so copies started on the same side of 00:00 UTC agree on it
String dayRun = 'd' + new Date().format('yyyyMMdd', TimeZone.getTimeZone('UTC'))

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
  try { cloud = new JsonSlurper().parseText(r.body).cloudId } catch (Exception e) { throw new IllegalStateException('[3] the Automation API answered 200 with a body that is not JSON for the cloud id') }
}
String base = "${api}/automation/public/jira/${cloud}/rest/v1"

// sleep Retry-After seconds when given, else `wait` with jitter; answers the next wait (doubling to 15 s)
def pause = { def r, long wait ->
  String after = r ? r.headers.getFirst('Retry-After') : ''
  Thread.sleep(after?.isInteger() ? after.toInteger() * 1000L : wait + (long) (Math.random() * 500))
  Math.min(wait * 2, 15000L)
}

// the JSON of a 200; `what` names the read in the log ("the rule list", "rule 3 of 40"), never the rule's id
def getJson = { String path, String what ->
  long wait = 1000
  for (int attempt = 1; attempt <= 5; attempt++) {
    def r
    try {
      r = Unirest.get(base + path).header('Authorization', auth).header('Accept', 'application/json').asString()
    } catch (Exception e) {
      r = null
    }
    int status = r ? r.status : 0
    if (status == 200) {
      // a proxy's HTML page is an Atlassian-side failure, not a crash
      try { return new JsonSlurper().parseText(r.body) } catch (Exception e) { throw new IllegalStateException("[3] the Automation API answered 200 with a body that is not JSON for ${what}") }
    }
    if (status == 401) throw new IllegalStateException('[3] the Automation API rejected the token (401): it must be an API token with the Automation scope, for this e-mail')
    if (status == 403) throw new IllegalStateException('[3] the Automation API refused access (403): the account must be a Jira administrator')
    if ((status == 0 || status == 429 || status >= 500) && attempt < 5) {
      wait = pause(r, wait)
      continue
    }
    throw new IllegalStateException("[3] the Automation API answered ${status} for ${what}")
  }
  throw new IllegalStateException("[3] gave up on the Automation API reading ${what}")
}

// the list, page by page
List<String> ids = []
Set<String> seen = [] as Set
String cursor = null
int pages = 0
while (true) {
  String q = 'limit=100' + (cursor ? '&cursor=' + URLEncoder.encode(cursor, 'UTF-8') : '')
  def page = getJson("/rule/summary?${q}", 'the rule list')
  pages++
  (page.data ?: []).each { item ->
    String id = (item.id ?: item.uuid)?.toString()
    if (id && seen.add(id)) ids << id
  }
  String next = page.links?.next
  def m = next =~ /[?&]cursor=([^&]+)/
  cursor = m.find() ? URLDecoder.decode(m.group(1), 'UTF-8') : null
  if (!cursor) break
}
say("${ids.size()} rules listed in ${pages} page(s)")

// the slice: a rule's part is a function of its own id - its first 8 hex digits as a
// number, modulo M, plus 1 - so a rule made or deleted between the jobs moves no other
// rule across the cut, whatever order the API listed them in
int total = ids.size()
if (partM) {
  ids = ids.sort(false).findAll { String id ->
    String hex = id.toLowerCase().replaceAll('[^0-9a-f]', '').take(8)
    (hex ? Long.parseLong(hex, 16) : 0L) % partM + 1 == partN
  }
  say("part ${part}: ${ids.size()} of ${total} rules are this job's")
}

// each rule, wrapped in "rule"
List<String> parts = []
ids.eachWithIndex { id, i ->
  def detail = getJson('/rule/' + URLEncoder.encode(id, 'UTF-8').replace('+', '%20'), "rule ${i + 1} of ${ids.size()}")
  def rule = (detail instanceof Map && detail.containsKey('rule')) ? detail.rule : detail
  parts << '{"rule":' + JsonOutput.toJson(rule) + '}'
}

// compact and ASCII-only: every non-ASCII UTF-16 unit as \uXXXX, so a byte split is safe
String payload = '{"rules":[' + parts.join(',') + '],"sender":' +
  JsonOutput.toJson([name: NAME, version: VERSION, rules: parts.size()]) + '}'
StringBuilder ascii = new StringBuilder(payload.length())
payload.each { String ch ->
  char c = ch.charAt(0)
  if (c == '\n' || c == '\r') return
  if ((int) c > 0x7f) ascii.append(String.format('\\u%04x', (int) c)) else ascii.append(c)
}
byte[] data = ascii.toString().getBytes('US-ASCII')
String sum = MessageDigest.getInstance('SHA-256').digest(data).encodeHex().toString()
int size = cfg('AUTOMAP_CHUNK_BYTES', '200000').toInteger()
List<byte[]> chunks = []
for (int i = 0; i < data.length; i += size) chunks << Arrays.copyOfRange(data, i, Math.min(i + size, data.length))

def word = { String body -> try { new JsonSlurper().parseText(body ?: '{}').error ?: '' } catch (Exception e) { '' } }

// the rules, in chunks: answers [code, say], which the end of the script turns into the outcome
def pushRules = { ->
  if (dryRun) {
    say("dry run: ${part ? 'part ' + part + ', ' : ''}${data.length} bytes in ${chunks.size()} chunk(s), sha256 ${sum}; nothing pushed")
    return [0, 'dry run']
  }
  String url = cfg('AUTOMAP_URL')
  String key = cfg('AUTOMAP_KEY')
  for (int attempt = 1; attempt <= 2; attempt++) {
    String run = part ? dayRun : UUID.randomUUID().toString().replace('-', '')
    boolean restart = false
    boolean queued = false
    for (int seq = 0; seq < chunks.size(); seq++) {
      Map<String, String> h = [
        'Authorization'   : "Bearer ${key}".toString(),
        'Content-Type'    : 'text/plain; charset=utf-8',
        'X-Automap-Run'   : run,
        'X-Automap-Seq'   : seq.toString(),
        'X-Automap-Sender': "${NAME}/${VERSION}".toString(),
      ]
      if (part) h['X-Automap-Part'] = part
      if (seq == chunks.size() - 1) {
        h['X-Automap-Last'] = '1'
        h['X-Automap-Sha256'] = sum
      }
      def r = null
      int status = 0
      int tries = 1
      for (; tries <= 3; tries++) {
        try {
          r = Unirest.post(url).headers(h).body(chunks[seq]).asString()
          status = r.status
        } catch (Exception e) {
          status = 0
        }
        if (status == 202 || REFUSED.contains(status) || status in [409, 422, 429] || tries == 3) break
        Thread.sleep(1000L << tries)
      }
      if (status == 202) {
        if (seq == chunks.size() - 1) { try { queued = new JsonSlurper().parseText(r.body ?: '{}').queued == true } catch (Exception e) { queued = false } }
        continue
      }
      String w = word(r?.body)
      // the first copy of the last chunk was taken; its answer was lost on the way back.
      // A new run would load the same rules twice; a part sent again would change nothing.
      if (status == 409 && tries > 1 && seq == chunks.size() - 1) {
        if (part) {
          say("part ${part}: ${parts.size()} rules already taken (the answer to the last chunk was lost)")
          return [0, "part ${part}: pushed ${chunks.size()} chunk(s)"]
        }
        say("the last chunk was already taken: pushed ${data.length} bytes in ${chunks.size()} chunk(s); the map is rebuilding")
        return [0, "pushed ${chunks.size()} chunk(s)"]
      }
      // a part's run is the day's: a 409 means the map was built today already, or the
      // other job was set up with another M, and sending again would not change that
      if (status == 409 && part) return [4, "receiver answered 409 ${w}: today's map is already built, or another copy of this job has a different M in PART"]
      if ((status == 409 || status == 422) && attempt == 1) {
        say("receiver answered ${status} ${w}; starting the push again")
        restart = true
        break
      }
      if (status == 429) return [5, "receiver answered 429 ${w}: try again later"]
      if (REFUSED.contains(status)) return [4, "receiver refused the push: ${status} ${w}"]
      return [6, "receiver answered ${status} ${w}"]
    }
    if (!restart && part) {
      String rest = partM == 2 ? 'part' : 'parts'
      say("part ${part}: ${parts.size()} rules pushed, ${queued ? 'map queued' : 'waiting for the other ' + rest}")
      return [0, "part ${part}: pushed ${chunks.size()} chunk(s)"]
    }
    if (!restart) {
      say("pushed ${data.length} bytes in ${chunks.size()} chunk(s); the map is rebuilding")
      return [0, "pushed ${chunks.size()} chunk(s)"]
    }
  }
  return [6, 'the push did not go through twice']
}


def (int code, String said) = pushRules()
if (code != 0) throw new IllegalStateException("[${code}] ${said}")
return said
