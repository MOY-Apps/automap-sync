/*
 * automap-sync (ScriptRunner for Jira Cloud) - push this site's automation rules to
 * Automation Map, as a ScriptRunner Scheduled Job.
 *
 * Reads every automation rule with an Atlassian API token kept in ScriptRunner's Script
 * Variables, and pushes them to the Automation Map push receiver with the key the app
 * issued. Contract: docs/push-sync.md.
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
 * request, so a site with more than a few hundred rules may not finish in one run - use
 * the Python sender or the Docker image there. The job fails with a message starting
 * "[n]" where n is the exit code the other senders use (4 refused, 5 try later, 6 failed).
 *
 * Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
 */
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.security.MessageDigest

final String NAME = 'scriptrunner'
final String VERSION = '1.0.1'
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
String base = "${api}/automation/public/jira/${cloud}/rest/v1"

def getText = { String path ->
  long wait = 1000
  for (int attempt = 1; attempt <= 5; attempt++) {
    def r
    try {
      r = Unirest.get(base + path).header('Authorization', auth).header('Accept', 'application/json').asString()
    } catch (Exception e) {
      r = null
    }
    int status = r ? r.status : 0
    if (status == 200) return r.body
    if (status == 401) throw new IllegalStateException('[3] the Automation API rejected the token (401): it must be an API token with the Automation scope, for this e-mail')
    if (status == 403) throw new IllegalStateException('[3] the Automation API refused access (403): the account must be a Jira administrator')
    if ((status == 0 || status == 429 || status >= 500) && attempt < 5) {
      String after = r ? r.headers.getFirst('Retry-After') : ''
      Thread.sleep(after?.isInteger() ? after.toInteger() * 1000L : wait + (long) (Math.random() * 500))
      wait = Math.min(wait * 2, 15000L)
      continue
    }
    throw new IllegalStateException("[3] the Automation API answered ${status} for ${path.tokenize('?')[0]}")
  }
  throw new IllegalStateException('[3] gave up on the Automation API')
}

// the list, page by page
List<String> ids = []
Set<String> seen = [] as Set
String cursor = null
int pages = 0
while (true) {
  String q = 'limit=100' + (cursor ? '&cursor=' + URLEncoder.encode(cursor, 'UTF-8') : '')
  def page = new JsonSlurper().parseText(getText("/rule/summary?${q}"))
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

// each rule, wrapped in "rule"
List<String> parts = []
ids.each { id ->
  def detail = new JsonSlurper().parseText(getText('/rule/' + URLEncoder.encode(id, 'UTF-8').replace('+', '%20')))
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

if (dryRun) {
  say("dry run: ${data.length} bytes in ${chunks.size()} chunk(s), sha256 ${sum}; nothing pushed")
  return 'dry run'
}
String url = cfg('AUTOMAP_URL')
String key = cfg('AUTOMAP_KEY')
def word = { String body -> try { new JsonSlurper().parseText(body ?: '{}').error ?: '' } catch (Exception e) { '' } }

for (int attempt = 1; attempt <= 2; attempt++) {
  String run = UUID.randomUUID().toString().replace('-', '')
  boolean restart = false
  for (int seq = 0; seq < chunks.size(); seq++) {
    Map<String, String> h = [
      'Authorization'   : "Bearer ${key}".toString(),
      'Content-Type'    : 'text/plain; charset=utf-8',
      'X-Automap-Run'   : run,
      'X-Automap-Seq'   : seq.toString(),
      'X-Automap-Sender': "${NAME}/${VERSION}".toString(),
    ]
    if (seq == chunks.size() - 1) {
      h['X-Automap-Last'] = '1'
      h['X-Automap-Sha256'] = sum
    }
    def r = null
    int status = 0
    for (int tries = 1; tries <= 3; tries++) {
      try {
        r = Unirest.post(url).headers(h).body(chunks[seq]).asString()
        status = r.status
      } catch (Exception e) {
        status = 0
      }
      if (status == 202 || REFUSED.contains(status) || status in [409, 422, 429] || tries == 3) break
      Thread.sleep(1000L << tries)
    }
    if (status == 202) continue
    String w = word(r?.body)
    if ((status == 409 || status == 422) && attempt == 1) {
      say("receiver answered ${status} ${w}; starting the push again")
      restart = true
      break
    }
    if (status == 429) throw new IllegalStateException("[5] receiver answered 429 ${w}: try again later")
    if (REFUSED.contains(status)) throw new IllegalStateException("[4] receiver refused the push: ${status} ${w}")
    throw new IllegalStateException("[6] receiver answered ${status} ${w}")
  }
  if (!restart) {
    say("pushed ${data.length} bytes in ${chunks.size()} chunk(s); the map is rebuilding")
    return "pushed ${chunks.size()} chunk(s)"
  }
}
throw new IllegalStateException('[6] the push did not go through twice')
