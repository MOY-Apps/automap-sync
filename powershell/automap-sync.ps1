#!/usr/bin/env pwsh
<#
.SYNOPSIS
  automap-sync (PowerShell) - push this site's automation rules to Automation Map.

.DESCRIPTION
  Reads every automation rule with YOUR Atlassian API token (it never leaves this
  machine), and pushes them to the Automation Map push receiver with the key the app
  issued. PowerShell 7.2+ (Windows, Linux, macOS), no modules. Contract:
  docs/push-sync.md. Same environment, flags and exit codes as the Python sender:

    ATLASSIAN_SITE | ATLASSIAN_CLOUD_ID, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN,
    AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE,
    AUTOMAP_USAGE=off, AUTOMAP_RUNS=off, AUTOMAP_RUNS_DAYS (7)

    pwsh ./automap-sync.ps1 [-DryRun]

  Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by
  the receiver, 5 try later, 6 failed.

  Usage and runs (BETA, from 1.1.0), as in the Python sender: after the rules, this
  month's steps, Rovo credits and flow runs per rule, and the audit log of the last
  AUTOMAP_RUNS_DAYS days folded into per-rule, per-day counts, are read from the internal
  API behind Jira's Usage and Audit log tabs and pushed as two separate pushes. That API is
  undocumented and can change: a failure there is logged and never fails the run. No
  account ids, no issue ids and no message text leave this machine.

  Rule bodies are carried as the API's own JSON text (System.Text.Json), never through
  ConvertFrom-Json: that turns date-looking strings into DateTime and would change them.

  Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$Name = 'powershell'
$Version = '1.2.0'
$UA = "automap-sync-$Name/$Version"
$Refused = @(400, 401, 402, 403, 404, 405, 413, 426)

function Write-Log([string]$m) { [Console]::Error.WriteLine("automap-sync $Name ${Version}: $m") }
function Stop-Sync([int]$code, [string]$m) { Write-Log $m; exit $code }
function Get-Setting([string]$n, [string]$fallback = '') {
  $v = [Environment]::GetEnvironmentVariable($n)
  if ([string]::IsNullOrEmpty($v)) { $v = $fallback }
  if ([string]::IsNullOrEmpty($v)) { Stop-Sync 2 "$n is not set" }
  return $v
}

# Status, headers and text for any answer; status 0 when nothing answered.
function Invoke-Http([string]$method, [string]$url, [hashtable]$headers = @{}, [byte[]]$body = $null) {
  $p = @{ Method = $method; Uri = $url; Headers = $headers; UserAgent = $UA; SkipHttpErrorCheck = $true }
  if ($null -ne $body) { $p.Body = $body; $p.ContentType = 'text/plain; charset=utf-8' }
  try {
    $r = Invoke-WebRequest @p
    $text = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
    return @{ Status = [int]$r.StatusCode; Headers = $r.Headers; Text = $text }
  } catch {
    return @{ Status = 0; Headers = @{}; Text = $_.Exception.Message }
  }
}

$DryRun = $DryRun -or ($env:AUTOMAP_DRY_RUN -eq '1')
$email = Get-Setting 'ATLASSIAN_EMAIL'
$token = Get-Setting 'ATLASSIAN_API_TOKEN'
$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:$token"))
$api = (Get-Setting 'ATLASSIAN_API_BASE' 'https://api.atlassian.com').TrimEnd('/')

$cloud = $env:ATLASSIAN_CLOUD_ID
if ([string]::IsNullOrEmpty($cloud)) {
  $site = Get-Setting 'ATLASSIAN_SITE'
  if ($site -notmatch '://') { $site = "https://$site" }
  $r = Invoke-Http 'GET' ($site.TrimEnd('/') + '/_edge/tenant_info')
  if ($r.Status -ne 200) { Stop-Sync 3 "could not read the cloud id of $site (HTTP $($r.Status))" }
  $cloud = ($r.Text | ConvertFrom-Json).cloudId
}
$base = "$api/automation/public/jira/$cloud/rest/v1"

function Get-Atlassian([string]$path) {
  $wait = 1.0
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $r = Invoke-Http 'GET' ($base + $path) @{ Authorization = $auth; Accept = 'application/json' }
    if ($r.Status -eq 200) { return $r.Text }
    if ($r.Status -eq 401) { Stop-Sync 3 'the Automation API rejected the token (401): it must be an API token with the Automation scope, for this e-mail' }
    if ($r.Status -eq 403) { Stop-Sync 3 'the Automation API refused access (403): the account must be a Jira administrator' }
    if (($r.Status -eq 0 -or $r.Status -eq 429 -or $r.Status -ge 500) -and $attempt -lt 5) {
      $after = 0
      if ($r.Headers -and $r.Headers['Retry-After']) { [int]::TryParse([string]($r.Headers['Retry-After'] | Select-Object -First 1), [ref]$after) | Out-Null }
      Start-Sleep -Milliseconds ([int]($(if ($after -gt 0) { $after * 1000 } else { $wait * 1000 + (Get-Random -Maximum 500) })))
      $wait = [Math]::Min($wait * 2, 15)
      continue
    }
    Stop-Sync 3 "the Automation API answered $($r.Status) for $($path.Split('?')[0])"
  }
  Stop-Sync 3 'gave up on the Automation API'
}

# the list of rules, page by page
$ids = [System.Collections.Generic.List[string]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new()
$cursor = $null
$pages = 0
do {
  $q = 'limit=100'
  if ($cursor) { $q += '&cursor=' + [Uri]::EscapeDataString($cursor) }
  $page = (Get-Atlassian "/rule/summary?$q") | ConvertFrom-Json
  $pages++
  foreach ($item in @($page.data)) {
    $id = if ($item.id) { [string]$item.id } else { [string]$item.uuid }
    if ($id -and $seen.Add($id)) { $ids.Add($id) }
  }
  $cursor = $null
  $next = $page.links.next
  if ($next -and $next -match '[?&]cursor=([^&]+)') { $cursor = [Uri]::UnescapeDataString($Matches[1]) }
} while ($cursor)
Write-Log "$($ids.Count) rules listed in $pages page(s)"

# each rule as the API wrote it, wrapped in "rule"
$parts = [System.Collections.Generic.List[string]]::new()
foreach ($id in $ids) {
  $text = Get-Atlassian ('/rule/' + [Uri]::EscapeDataString($id))
  $doc = [System.Text.Json.JsonDocument]::Parse($text)
  # the rule as the API wrote it: inside "rule" when wrapped, the whole answer when bare.
  # Properties are walked rather than TryGetProperty'd: PowerShell cannot bind the [ref]
  # out-parameter of a struct it has not been told the type of.
  $raw = $doc.RootElement.GetRawText()
  if ($doc.RootElement.ValueKind -eq 'Object') {
    foreach ($prop in $doc.RootElement.EnumerateObject()) {
      if ($prop.Name -eq 'rule') { $raw = $prop.Value.GetRawText(); break }
    }
  }
  $doc.Dispose()
  $parts.Add('{"rule":' + $raw + '}')
}

# compact and ASCII-only. Line breaks in JSON text can only be whitespace (inside strings
# they are escaped), so they go; every non-ASCII UTF-16 unit becomes \uXXXX, so a byte
# split is a safe split.
$payload = '{"rules":[' + ($parts -join ',') + '],"sender":{"name":"' + $Name + '","version":"' + $Version + '","rules":' + $parts.Count + '}}'
$payload = $payload -replace "[`r`n]", ''
$payload = [regex]::Replace($payload, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
$data = [Text.Encoding]::ASCII.GetBytes($payload)
$sum = -join ([Security.Cryptography.SHA256]::HashData($data) | ForEach-Object { $_.ToString('x2') })
$size = [int](Get-Setting 'AUTOMAP_CHUNK_BYTES' '200000')
$chunks = [System.Collections.Generic.List[byte[]]]::new()
for ($i = 0; $i -lt $data.Length; $i += $size) {
  $chunks.Add($data[$i..([Math]::Min($i + $size, $data.Length) - 1)])
}

function Get-Word([string]$text) { try { return ($text | ConvertFrom-Json).error } catch { return '' } }

# The rules, in chunks. Answers with an exit code and what to say, rather than exiting, so
# the usage and the runs can still go after a refusal.
function Send-Rules {
  if ($DryRun) {
    Write-Log "dry run: $($data.Length) bytes in $($chunks.Count) chunk(s), sha256 $sum; nothing pushed"
    return @{ Code = 0; Say = '' }
  }
  $url = Get-Setting 'AUTOMAP_URL'
  $key = Get-Setting 'AUTOMAP_KEY'
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $run = [Guid]::NewGuid().ToString('N')
    $restart = $false
    for ($seq = 0; $seq -lt $chunks.Count; $seq++) {
      $h = @{
        Authorization      = "Bearer $key"
        'X-Automap-Run'    = $run
        'X-Automap-Seq'    = [string]$seq
        'X-Automap-Sender' = "$Name/$Version"
      }
      if ($seq -eq $chunks.Count - 1) { $h['X-Automap-Last'] = '1'; $h['X-Automap-Sha256'] = $sum }
      for ($tries = 1; $tries -le 3; $tries++) {
        $r = Invoke-Http 'POST' $url $h $chunks[$seq]
        if ($r.Status -eq 202 -or $Refused -contains $r.Status -or @(409, 422, 429) -contains $r.Status -or $tries -eq 3) { break }
        Start-Sleep -Seconds ([Math]::Pow(2, $tries))
      }
      if ($r.Status -eq 202) { continue }
      $w = Get-Word $r.Text
      if (($r.Status -eq 409 -or $r.Status -eq 422) -and $attempt -eq 1) {
        Write-Log "receiver answered $($r.Status) $w; starting the push again"
        $restart = $true
        break
      }
      if ($r.Status -eq 429) { return @{ Code = 5; Say = "receiver answered 429 ${w}: try again later" } }
      if ($Refused -contains $r.Status) { return @{ Code = 4; Say = "receiver refused the push: $($r.Status) $w" } }
      return @{ Code = 6; Say = "receiver answered $($r.Status) $w" }
    }
    if (-not $restart) {
      Write-Log "pushed $($data.Length) bytes in $($chunks.Count) chunk(s); the map is rebuilding"
      return @{ Code = 0; Say = '' }
    }
  }
  return @{ Code = 6; Say = 'the push did not go through twice' }
}

function Test-Off([string]$n) { @('off', '0', 'false', 'no') -contains ([string][Environment]::GetEnvironmentVariable($n)).ToLower() }
$internal = "$api/automation/internal-api/jira/$cloud/pro/rest/GLOBAL/"

# Compact, ASCII-only JSON of a document built here (no rule bodies in it).
function ConvertTo-AsciiJson($doc) {
  $j = $doc | ConvertTo-Json -Depth 20 -Compress
  return [regex]::Replace($j, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

# Usage or runs (beta), in chunks like the rules; the receiver keeps them whole on the last one (APPS-499).
function Send-Kind([string]$kind, [string]$payload) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($payload)
  $hash = -join ([Security.Cryptography.SHA256]::HashData($bytes) | ForEach-Object { $_.ToString('x2') })
  $size = [int](Get-Setting 'AUTOMAP_CHUNK_BYTES' '200000')
  $parts = [System.Collections.Generic.List[byte[]]]::new()
  for ($i = 0; $i -lt $bytes.Length; $i += $size) { $parts.Add($bytes[$i..([Math]::Min($i + $size, $bytes.Length) - 1)]) }
  $run = [Guid]::NewGuid().ToString('N')
  $r = @{ Status = 0; Text = '' }
  for ($seq = 0; $seq -lt $parts.Count; $seq++) {
    $h = @{
      Authorization      = "Bearer $(Get-Setting 'AUTOMAP_KEY')"
      'X-Automap-Run'    = $run
      'X-Automap-Seq'    = [string]$seq
      'X-Automap-Sender' = "$Name/$Version"
      'X-Automap-Kind'   = $kind
    }
    if ($seq -eq $parts.Count - 1) { $h['X-Automap-Last'] = '1'; $h['X-Automap-Sha256'] = $hash }
    for ($tries = 1; $tries -le 3; $tries++) {
      $r = Invoke-Http 'POST' (Get-Setting 'AUTOMAP_URL') $h $parts[$seq]
      if ($r.Status -ne 0 -and $r.Status -lt 500 -and $r.Status -ne 429) { break }
      if ($tries -lt 3) { Start-Sleep -Seconds ([Math]::Pow(2, $tries)) }
    }
    if ($r.Status -ne 202) { break }
  }
  return $r
}

# The internal API behind Jira's Usage and Audit log tabs (BETA, undocumented): throws on any
# answer but 200, which the callers turn into "skipped".
function Get-Internal([string]$path, $body = $null, [int]$tries = 1) {
  $h = @{ Authorization = $auth; Accept = 'application/json' }
  $status = 0
  for ($attempt = 1; $attempt -le $tries; $attempt++) {
    if ($null -ne $body) {
      $p = @{ Method = 'POST'; Uri = $internal + $path; Headers = $h; UserAgent = $UA; SkipHttpErrorCheck = $true
              Body = ($body | ConvertTo-Json -Compress); ContentType = 'application/json' }
    } else {
      $p = @{ Method = 'GET'; Uri = $internal + $path; Headers = $h; UserAgent = $UA; SkipHttpErrorCheck = $true }
    }
    try {
      $r = Invoke-WebRequest @p
      $status = [int]$r.StatusCode
      $text = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
    } catch { $status = 0; $text = '' }
    if ($status -eq 200) { return ($text | ConvertFrom-Json) }
    if ($status -ne 0 -and $status -ne 429 -and $status -lt 500) { break }
    if ($attempt -lt $tries) { Start-Sleep -Seconds (2 * $attempt) }
  }
  throw "$($path.Split('?')[0]) answered $status"
}

function Get-Or0($v) { if ($null -eq $v) { 0 } else { $v } }

# Automation usage (BETA) for one period; account ids are not copied.
function Get-UsageMonth([long]$start, [long]$end, [string]$month) {
  $credit = Get-Internal "creditUsage?startTime=$start&endTime=$end"
  $pair = { param($c) [ordered]@{ total = (Get-Or0 $c.total); jira = (Get-Or0 $c.currentProduct); other = (Get-Or0 $c.everywhereElse) } }
  $byRule = [ordered]@{}
  # sortBy also filters to rules with that metric above zero: read both and merge
  foreach ($sortBy in @('automationCredits', 'rovoCredits')) {
    $seenFlows = 0
    for ($page = 0; $page -lt 100; $page++) {
      $r = Get-Internal "highUsageFlows?limit=100&page=$page&sortBy=$sortBy&startTime=$start&endTime=$end"
      $flows = @($r.flows | Where-Object { $_ })
      foreach ($f in $flows) {
        if (-not $f.ruleUuid) { continue }
        $byRule[[string]$f.ruleUuid] = [ordered]@{
          uuid = [string]$f.ruleUuid; name = [string]$f.ruleName; state = $(if ($f.state) { [string]$f.state } else { 'ENABLED' })
          runs = (Get-Or0 $f.runs); steps = (Get-Or0 $f.automationCredits); rovo = (Get-Or0 $f.rovoCredits)
          deleted = [bool]$f.deleted; agentic = [bool]$f.containsAgentic
        }
      }
      $seenFlows += $flows.Count
      if ($flows.Count -eq 0 -or $seenFlows -ge (Get-Or0 $r.totalCount)) { break }
    }
  }
  $out = [ordered]@{
    period = [ordered]@{ start = $start; end = $end }
    steps  = (& $pair $credit.automation)
    rovo   = (& $pair $credit.rovo)
    flows  = [object[]]@($byRule.Values)
  }
  # the rest is the current billing model, and the least stable part: each piece optional
  try {
    $top = @(Get-Internal "highestUsages?limit=100&month=$month")
    $out.billable = [ordered]@{ month = $month; rules = [object[]]@($top | Where-Object { $_.ruleIdUuid } | ForEach-Object { [ordered]@{ uuid = [string]$_.ruleIdUuid; runs = (Get-Or0 $_.executionCount) } }) }
  } catch {}
  try {
    $ws = (Get-Internal 'pagecontext').tenantPageContext.usage.workspaceUsages
    if ($ws) {
      $out.limits = [object[]]@($ws.PSObject.Properties | ForEach-Object { [ordered]@{ product = $_.Name; used = (Get-Or0 $_.Value.executionsUsed); limit = (Get-Or0 $_.Value.executionLimit); edition = [string]$_.Value.edition } })
    }
  } catch {}
  try {
    $out.trend = [object[]]@((Get-Internal 'usageTrendData').data | Where-Object { $_ } | ForEach-Object { [ordered]@{ month = $_.month; runs = $(if ($_.workspaceCounts) { $_.workspaceCounts } else { @{} }) } })
  } catch {}
  try { $out.creditPack = [bool](Get-Internal 'hasCreditPack').hasCreditPack } catch {}
  return $out
}

function Send-Usage {
  if (Test-Off 'AUTOMAP_USAGE') { return }
  try {
    $now = [DateTimeOffset]::UtcNow
    $nowMs = $now.ToUnixTimeMilliseconds()
    $first = [DateTimeOffset]::new($now.Year, $now.Month, 1, 0, 0, 0, [TimeSpan]::Zero)
    $periods = [System.Collections.Generic.List[object]]::new()
    # in the first three days of a month the whole of the month before goes too
    if ($now.Day -le 3) {
      $prev = $first.AddMonths(-1)
      $periods.Add(@($prev.ToUnixTimeMilliseconds(), ($first.ToUnixTimeMilliseconds() - 1), $prev.ToString('yyyy-MM')))
    }
    $periods.Add(@($first.ToUnixTimeMilliseconds(), $nowMs, $first.ToString('yyyy-MM')))
    foreach ($pd in $periods) {
      $u = Get-UsageMonth $pd[0] $pd[1] $pd[2]
      $doc = [ordered]@{ usage = $u; sender = [ordered]@{ name = $Name; version = $Version } }
      $payload = ConvertTo-AsciiJson $doc
      $steps = $u.steps.total
      $n = $u.flows.Count
      if ($DryRun) { Write-Log "usage (beta) $($pd[2]): $steps steps, $n rules with usage; nothing pushed"; continue }
      $r = Send-Kind 'usage' $payload
      if ($r.Status -eq 202) { Write-Log "usage (beta) $($pd[2]): pushed $steps steps for $n rules" }
      else { Write-Log "usage (beta) $($pd[2]): not taken, receiver answered $($r.Status) $(Get-Word $r.Text)" }
    }
  } catch {
    Write-Log "usage (beta) skipped: $($_.Exception.Message)"
  }
}

# The audit log (BETA), folded into what the map needs. Undocumented, like Usage.
function Send-Runs {
  if (Test-Off 'AUTOMAP_RUNS') { return }
  try {
    $days = 7
    if ($env:AUTOMAP_RUNS_DAYS) { $days = [Math]::Max(1, [Math]::Min(30, [int]$env:AUTOMAP_RUNS_DAYS)) }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $start = $nowMs - [long]$days * 86400000
    $start -= $start % 86400000          # whole days, so a day pushed is a day complete
    $from = [DateTimeOffset]::FromUnixTimeMilliseconds($start).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'.000Z'")
    $records = [System.Collections.Generic.List[object]]::new()
    for ($offset = 0; $offset -lt 50000; $offset += 50) {   # 50 a page whatever is asked; `total` is always 0
      $page = @((Get-Internal 'auditlog' ([ordered]@{ fromTime = $from; offset = $offset; limit = 50 }) 3).items.items | Where-Object { $_ })
      foreach ($x in $page) { $records.Add($x) }
      if ($page.Count -lt 50) { break }
    }
    $rows = [ordered]@{}
    $failed = [ordered]@{}
    foreach ($r in $records) {
      $u = [string]$r.ruleIdUuid
      $t = if ($r.eventTimestamp) { [long]$r.eventTimestamp } elseif ($r.startTime) { [long]$r.startTime } else { 0 }
      if (-not $u -or -not $t -or $t -lt $start) { continue }
      $when = [DateTimeOffset]::FromUnixTimeMilliseconds($t).UtcDateTime
      $day = $when.ToString('yyyy-MM-dd')
      $k = "$u|$day"
      if (-not $rows.Contains($k)) {
        $rows[$k] = [ordered]@{ uuid = $u; day = $day; name = [string]$r.ruleName; success = 0; errors = 0; noop = 0; edits = 0; ms = 0; maxMs = 0 }
      }
      $row = $rows[$k]
      $cat = [string]$r.category
      if ($cat -eq 'CONFIG_CHANGE') { $row.edits++; continue }
      if ($cat -eq 'SUCCESS') { $row.success++ } elseif ($cat -eq 'NO_ACTIONS_PERFORMED') { $row.noop++ } else { $row.errors++ }
      # runs per UTC hour, only the hours that had any: a burst is hundreds of runs in one hour
      if (-not $row.Contains('hours')) { $row.hours = [ordered]@{} }
      $hour = [string]$when.Hour
      $row.hours[$hour] = (Get-Or0 $row.hours[$hour]) + 1
      $ms = [long](Get-Or0 $r.durationMs)
      $row.ms += $ms
      $row.maxMs = [Math]::Max($row.maxMs, $ms)
      if ($cat -ne 'SUCCESS' -and $cat -ne 'NO_ACTIONS_PERFORMED' -and $r.id) {
        if (-not $failed.Contains($u)) { $failed[$u] = [System.Collections.Generic.List[object]]::new() }
        $failed[$u].Add($r)
      }
    }
    $errors = [System.Collections.Generic.List[object]]::new()
    $budget = 40                         # one request per failed run read in full; two per rule at most
    foreach ($u in @($failed.Keys)) {
      foreach ($r in @($failed[$u] | Sort-Object { - [long](Get-Or0 $_.eventTimestamp) } | Select-Object -First 2)) {
        if ($budget -le 0) { break }
        $budget--
        try { $detail = Get-Internal "auditlog/item/$($r.id)" $null 3 } catch { continue }
        foreach ($cl in @($detail.content.componentLogs | Where-Object { $_ })) {
          $res = $cl.executionResult
          $keys = @($cl.changes | Where-Object { $_ -and $_.payload -and $_.payload.type -eq 'ERROR' } | ForEach-Object { [string]$_.payload.key })
          $code = if ($keys.Count -and $keys[0]) { $keys[0] } elseif ($res.auditEventErrorType) { [string]$res.auditEventErrorType } elseif ($res.errorType) { [string]$res.errorType } else { '' }
          if (-not $code -and $res.state -ne 'SOME_ERRORS') { continue }
          $comp = $cl.component
          $errors.Add([ordered]@{ uuid = $u; componentId = [string]$comp.id; componentType = [string]$comp.componentType
                                  type = [string]$comp.type; code = $(if ($code) { $code } else { 'SOME_ERRORS' }); at = [long](Get-Or0 $r.eventTimestamp) })
        }
      }
    }
    $runs = [ordered]@{ window = [ordered]@{ start = $start; end = $nowMs }; rows = [object[]]@($rows.Values); errors = [object[]]@($errors) }
    $doc = [ordered]@{ runs = $runs; sender = [ordered]@{ name = $Name; version = $Version } }
    $payload = ConvertTo-AsciiJson $doc
    $total = 0; $bad = 0
    foreach ($x in $runs.rows) { $total += $x.success + $x.errors + $x.noop; $bad += $x.errors }
    if ($DryRun) { Write-Log "runs (beta) last $days days: $total runs, $bad with errors; nothing pushed"; return }
    $r = Send-Kind 'runs' $payload
    if ($r.Status -eq 202) { Write-Log "runs (beta) last $days days: pushed $total runs, $bad with errors" }
    else { Write-Log "runs (beta): not taken, receiver answered $($r.Status) $(Get-Word $r.Text)" }
  } catch {
    Write-Log "runs (beta) skipped: $($_.Exception.Message)"
  }
}

$result = Send-Rules
# usage is a push of its own and spends no load, so it goes even when the rules were refused
# (an allowance used up, say); it never changes the exit code - but not when the receiver
# shut the door (403: switched off, or not on this plan)
if (-not ($result.Code -eq 4 -and $result.Say -match '403')) {
  Send-Usage
  Send-Runs
}
if ($result.Code -ne 0) { Stop-Sync $result.Code $result.Say }
exit 0
