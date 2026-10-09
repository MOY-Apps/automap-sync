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
    AUTOMAP_URL, AUTOMAP_KEY; optional AUTOMAP_CHUNK_BYTES (200000), ATLASSIAN_API_BASE

    pwsh ./automap-sync.ps1 [-DryRun]

  Exit codes: 0 pushed (or dry run), 2 configuration, 3 Atlassian API, 4 refused by
  the receiver, 5 try later, 6 failed.

  Rule bodies are carried as the API's own JSON text (System.Text.Json), never through
  ConvertFrom-Json: that turns date-looking strings into DateTime and would change them.

  Copyright MOY Apps. Licensed for use with Automation Map for Jira only; see LICENSE.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$Name = 'powershell'
$Version = '1.0.0'
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
  $inner = $null
  if ($doc.RootElement.ValueKind -eq 'Object' -and $doc.RootElement.TryGetProperty('rule', [ref]$inner)) {
    $raw = $inner.GetRawText()
  } else {
    $raw = $doc.RootElement.GetRawText()
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

if ($DryRun) {
  Write-Log "dry run: $($data.Length) bytes in $($chunks.Count) chunk(s), sha256 $sum; nothing pushed"
  exit 0
}
$url = Get-Setting 'AUTOMAP_URL'
$key = Get-Setting 'AUTOMAP_KEY'

function Get-Word([string]$text) { try { return ($text | ConvertFrom-Json).error } catch { return '' } }

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
    if ($r.Status -eq 429) { Stop-Sync 5 "receiver answered 429 ${w}: try again later" }
    if ($Refused -contains $r.Status) { Stop-Sync 4 "receiver refused the push: $($r.Status) $w" }
    Stop-Sync 6 "receiver answered $($r.Status) $w"
  }
  if (-not $restart) {
    Write-Log "pushed $($data.Length) bytes in $($chunks.Count) chunk(s); the map is rebuilding"
    exit 0
  }
}
Stop-Sync 6 'the push did not go through twice'
