<#
ContentOps-Originals (SPEC 9.4, 12.2; ops/README.md "Originaly: dva mesta"). Frees the PC of
originals that ContentOps has decided may go: two clouds hold them, checked byte for byte, and
the master is ready or ContentOps decided there will be none. ContentOps alone decides; this
script asks the route GET /api/v1/admin/originals/release with the host agent's token and acts
only on the files it gives, each checked again here right before the act. Two holders, two
scheduled tasks (register-tasks.ps1):

-Holder ydisk  ContentOps-Originals-YDisk: the copy of Yandex Disk on C: (Lora's). From dmsrg,
  interactive, highest, every 20 min and at logon: the Yandex client is a desktop app.
  1. ContentOps-CopyList, wait for a new finished_at (the route takes only a list < 30 min).
  2. The route (model lora, holder ydisk_copy). Nothing given (or blocked) -> done.
  3. The client must not be running (one not started by us is never touched): then every entry
     of the copy list that still has PINNED loses it (else the client downloads the pinned
     stubs onto C: when it starts), and each given file whose bytes are still on disk with the
     same size and time gets UNPINNED instead of PINNED: attributes only (SetFileAttributesW on
     the \\?\ path; .NET refuses PINNED/UNPINNED), the file is never opened.
  4. If anything was marked: originals-host.json "running": true; the client is started (it
     is not running, step 3); wait <= 60 min until every marked file has
     RECALL_ON_DATA_ACCESS (its bytes left C:, the file stays in the cloud); the client is
     closed; every Yandex value of HKCU\...\Run is removed (the client puts itself back there);
     YandexDiskUpdateService goes Manual if it is automatic; "running": false; CopyList again,
     so the VM never reads a freed file by the old list.
  Never deletes, moves or renames anything under the copy; never touches .sync.
-Holder eari   ContentOps-Originals-Ari: Ari's archive E:\Ari (the mirror of her Dropbox root).
  From SYSTEM, every 20 min. Registered DISABLED even with -Enable, until the Mac runs the
  ari_mirror change that reads from Dropbox (ops/README.md).
  1. Lists E:\Ari, metadata only, into the host share: ari-copy-list.jsonl and
     ari-copy-list.meta.json, the shape of the copy list (removed_total: what this task has
     deleted so far).
  2. The route (model ari, holder e_ari).
  3. Each given file: inside a type root, not under _opis', the same size, the same time as
     listed and unchanged for 24 h, and the Dropbox content hash of its local bytes equal to
     the route's -> Remove-Item of that one file. Emptied folders go, except the type roots and
     _opis'. Then the list again.

Both: one run at a time (a lock file), log C:\vm\contentops\logs\originals.log (rotated at
1 MB). The token: C:\vm\contentops\secrets\originals-agent.token (register-tasks.ps1 makes the
folder for SYSTEM, Administrators and dmsrg only; never in the host share, never in git).
-ApiBase: the stack's address (tailnet now, the server after the move). The decisions are
functions without side effects (Get-YdiskDecision, Get-AriDecision, Get-DropboxContentHash,
Get-PinFix); dot-sourced (. .\ContentOps-Originals.ps1), the script only defines them.

PowerShell 7, ASCII only.
#>
#Requires -Version 7.2
param(
  [ValidateSet('ydisk', 'eari')][string]$Holder,
  [string]$ApiBase = 'http://contentops.tail1d911a.ts.net',
  [string]$TokenFile = 'C:\vm\contentops\secrets\originals-agent.token',
  [string]$HostDir = 'C:\vm\contentops\host',
  [string]$LogDir = 'C:\vm\contentops\logs',
  [string]$CopyRoot = 'C:\Users\dmsrg\Yandex.Disk',
  [string]$AriRoot = 'E:\Ari',
  [string]$ClientExe = 'C:\Program Files\Yandex\YandexDisk4\YandexDisk4.exe',
  [int]$DehydrateMinutes = 60,
  [int]$CopyListWaitMinutes = 20
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$SPARSE_FILE = [uint32]0x200
$OFFLINE = [uint32]0x1000
$DIRECTORY = [uint32]0x10
$RECALL_ON_OPEN = [uint32]0x40000
$PINNED = [uint32]0x80000
$UNPINNED = [uint32]0x100000
$RECALL_ON_DATA_ACCESS = [uint32]0x400000
$NOT_ON_DISK = $RECALL_ON_DATA_ACCESS -bor $RECALL_ON_OPEN -bor $OFFLINE -bor $SPARSE_FILE
$INVALID_ATTRIBUTES = [uint32]::MaxValue
$ARI_UNCHANGED_HOURS = 24
# "_opis'" in Cyrillic, built from code points: the script stays ASCII.
$INVENTORY = -join ([char[]](0x5F, 0x43E, 0x43F, 0x438, 0x441, 0x44C))
$DROPBOX_BLOCK = 4MB

# --- decisions, no side effects ------------------------------------------------------------

# A path the route gave, relative to the holder's root: '/' separators, no '..', not rooted.
function Test-SafeRelativePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if ($Path.StartsWith('/') -or $Path.StartsWith('\') -or $Path.Contains(':') -or $Path.Contains('\')) { return $false }
  foreach ($part in $Path.Split('/')) {
    if ($part -eq '' -or $part -eq '.' -or $part -eq '..') { return $false }
  }
  return $true
}

# A time as the lists write it. ConvertFrom-Json and Invoke-RestMethod turn such strings into
# [datetime] (UTC, local or unspecified by version): back to 'yyyy-MM-ddTHH:mm:ssZ'.
function ConvertTo-UtcText($Value) {
  if ($Value -is [DateTimeOffset]) { $Value = $Value.UtcDateTime }
  if ($Value -is [datetime]) {
    $utc = if ($Value.Kind -eq [DateTimeKind]::Unspecified) { [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc) } else { $Value.ToUniversalTime() }
    return $utc.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  return "$Value"
}

# The attributes of a file of the copy that the client should dehydrate: PINNED off, UNPINNED on.
function Get-UnpinnedAttributes([uint32]$Attributes) {
  return [uint32](($Attributes -band (-bnot $PINNED)) -bor $UNPINNED)
}

<#
A file of the copy the route gave, against what is on disk now.
  File  one item of the route: path, size, last_write_utc ('yyyy-MM-ddTHH:mm:ssZ'), attributes
  Live  $null (not found) or @{ Attributes = [uint32]; Size = [long]; LastWriteUtc = 'yyyy-MM-ddTHH:mm:ssZ' }
Returns @{ Action = 'unpin' | 'skip'; Reason; Attributes = the new attributes }.
#>
function Get-YdiskDecision($File, $Live) {
  $skip = { param($why) @{ Action = 'skip'; Reason = $why; Attributes = $null } }
  if (-not (Test-SafeRelativePath $File.path)) { return (& $skip 'unsafe path') }
  $top = $File.path.Split('/')[0]
  if ($top -ieq '.sync') { return (& $skip 'service folder') }
  if ($null -eq $Live) { return (& $skip 'not found') }
  $a = [uint32]$Live.Attributes
  if (($a -band $DIRECTORY) -ne 0) { return (& $skip 'a directory') }
  if (($a -band $NOT_ON_DISK) -ne 0) { return (& $skip 'bytes not on disk') }
  if ([long]$Live.Size -ne [long]$File.size) { return (& $skip 'size changed') }
  if ((ConvertTo-UtcText $Live.LastWriteUtc) -ne (ConvertTo-UtcText $File.last_write_utc)) { return (& $skip 'time changed') }
  return @{ Action = 'unpin'; Reason = ''; Attributes = (Get-UnpinnedAttributes $a) }
}

<#
Entries of the copy list that keep PINNED: before the client starts they lose it (unspecified:
what is on disk stays, stubs are not fetched). Lines is the JSON Lines of the list.
Returns the relative paths, '/' separators.
#>
function Get-PinFix([string[]]$Lines) {
  $out = [Collections.Generic.List[string]]::new()
  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $doc = [Text.Json.JsonDocument]::Parse($line, [Text.Json.JsonDocumentOptions]::new())
    try {
      $attrs = [uint32]$doc.RootElement.GetProperty('attributes').GetInt64()
      if (($attrs -band $PINNED) -ne 0) {
        $path = $doc.RootElement.GetProperty('path').GetString()
        if ((Test-SafeRelativePath $path) -and ($path.Split('/')[0] -ine '.sync')) { $out.Add($path) }
      }
    } finally { $doc.Dispose() }
  }
  return , $out.ToArray()
}

<#
A file of E:\Ari the route gave, against what is on disk now.
  File       one item of the route: path, size, last_write_utc, dropbox_hash
  Live       $null (not found) or @{ Attributes; Size; LastWriteUtc ('yyyy-MM-ddTHH:mm:ssZ') }
  Now        [datetime] UTC
  LocalHash  $null before hashing, else the Dropbox content hash of the local bytes (hex)
Returns @{ Action = 'hash' | 'delete' | 'skip'; Reason }.
#>
function Get-AriDecision($File, $Live, [datetime]$Now, [string]$LocalHash) {
  $skip = { param($why) @{ Action = 'skip'; Reason = $why } }
  if (-not (Test-SafeRelativePath $File.path)) { return (& $skip 'unsafe path') }
  $parts = $File.path.Split('/')
  if ($parts.Count -lt 2) { return (& $skip 'not inside a type root') }
  if ($parts[0] -ieq $INVENTORY) { return (& $skip 'inventory') }
  if (-not ($File.dropbox_hash -match '^[0-9a-f]{64}$')) { return (& $skip 'no Dropbox hash') }
  if ($null -eq $Live) { return (& $skip 'not found') }
  if (([uint32]$Live.Attributes -band $DIRECTORY) -ne 0) { return (& $skip 'a directory') }
  if ([long]$Live.Size -ne [long]$File.size) { return (& $skip 'size changed') }
  $liveTime = ConvertTo-UtcText $Live.LastWriteUtc
  if ($liveTime -ne (ConvertTo-UtcText $File.last_write_utc)) { return (& $skip 'time changed') }
  $written = [datetime]::ParseExact($liveTime, 'yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
  if (($Now - $written).TotalHours -lt $ARI_UNCHANGED_HOURS) { return (& $skip 'changed within 24 h') }
  if ([string]::IsNullOrEmpty($LocalHash)) { return @{ Action = 'hash'; Reason = '' } }
  if ($LocalHash -ne $File.dropbox_hash) { return (& $skip 'Dropbox hash differs') }
  return @{ Action = 'delete'; Reason = '' }
}

# Dropbox content hash: SHA-256 of the concatenated SHA-256 of every 4 MiB block (hex).
function Get-DropboxContentHash([IO.Stream]$Stream) {
  $blocks = [IO.MemoryStream]::new()
  $buffer = [byte[]]::new($DROPBOX_BLOCK)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    while ($true) {
      $filled = 0
      while ($filled -lt $buffer.Length) {
        $n = $Stream.Read($buffer, $filled, $buffer.Length - $filled)
        if ($n -le 0) { break }
        $filled += $n
      }
      if ($filled -eq 0) { break }
      $digest = $sha.ComputeHash($buffer, 0, $filled)
      $blocks.Write($digest, 0, $digest.Length)
      if ($filled -lt $buffer.Length) { break }
    }
    return [Convert]::ToHexString($sha.ComputeHash($blocks.ToArray())).ToLowerInvariant()
  } finally { $sha.Dispose(); $blocks.Dispose() }
}

function Format-Utc([datetime]$Time) {
  return $Time.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
}

# Dot-sourced: functions only (the decisions are tried on made-up files, see the header).
if ($MyInvocation.InvocationName -eq '.') { return }

# --- the run -------------------------------------------------------------------------------

if (-not $Holder) { throw '-Holder ydisk|eari' }
$logFile = Join-Path $LogDir 'originals.log'

# Never throws: a full disk must not stop the run before it cleans up.
function Write-Log([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item -Force $logFile "$logFile.1" }
    $line = '{0} {1}: {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $Holder, ($Message -replace '\s+', ' ')
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
}

Add-Type -Namespace ContentOps -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetFileAttributesW(string path);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileAttributesW(string path, uint attributes);
'@

function Get-LongPath([string]$Root, [string]$Relative) {
  return '\\?\' + (Join-Path $Root ($Relative -replace '/', '\'))
}

# What is on disk now, from the directory entry: the file is not opened (no recall).
function Get-Live([string]$LongPath) {
  $a = [ContentOps.Win32]::GetFileAttributesW($LongPath)
  if ($a -eq $INVALID_ATTRIBUTES) { return $null }
  $info = [IO.FileInfo]::new($LongPath)
  if (-not $info.Exists) { return @{ Attributes = $a; Size = -1; LastWriteUtc = '' } }
  return @{ Attributes = $a; Size = $info.Length; LastWriteUtc = (Format-Utc $info.LastWriteTimeUtc) }
}

function Write-Atomic([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText("$Path.tmp", $Text, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move("$Path.tmp", $Path, $true)
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-Release([string]$Model, [string]$RouteHolder) {
  $token = ([IO.File]::ReadAllText($TokenFile)).Trim()
  if (-not $token) { throw "no token in $TokenFile" }
  $uri = '{0}/api/v1/admin/originals/release?model={1}&holder={2}' -f $ApiBase.TrimEnd('/'),
    [uri]::EscapeDataString($Model), $RouteHolder
  return Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 120
}

function Get-ReleaseSummary($Answer) {
  $files = @($Answer.files)
  $bytes = 0L
  foreach ($f in $files) { $bytes += [long]$f.size }
  return '{0} files, {1:N1} GB given; left {2}; limit {3} files{4}' -f $files.Count, ($bytes / 1e9),
    $Answer.left.files, $Answer.limit.files, $(if ($Answer.limit.first_run) { ', first run' } else { '' })
}

# --- the copy of Yandex Disk -----------------------------------------------------------------

$copyMeta = Join-Path $HostDir 'ydisk-copy-list.meta.json'
$copyList = Join-Path $HostDir 'ydisk-copy-list.jsonl'
$hostReport = Join-Path $HostDir 'originals-host.json'

function Test-ClientRunning { return [bool](Get-Process -Name 'YandexDisk*' -ErrorAction SilentlyContinue) }

# Starts ContentOps-CopyList and waits for a newer list; $false when none came in time.
function Update-CopyList {
  $before = ''
  $meta = Read-JsonFile $copyMeta
  if ($meta) { $before = "$($meta.finished_at)" }
  Start-ScheduledTask -TaskName 'ContentOps-CopyList'
  $deadline = (Get-Date).AddMinutes($CopyListWaitMinutes)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $meta = Read-JsonFile $copyMeta
    if ($meta -and "$($meta.finished_at)" -ne $before -and (Get-ScheduledTask -TaskName 'ContentOps-CopyList').State -ne 'Running') {
      return $true
    }
  }
  return $false
}

function Save-HostReport([hashtable]$Report) {
  $Report.updated_at = Format-Utc (Get-Date)
  Write-Atomic $hostReport (ConvertTo-Json -InputObject $Report -Depth 3)
}

function Read-HostReport {
  $r = Read-JsonFile $hostReport
  $report = [ordered]@{ format = 'originals-host@1'; holder = 'ydisk_copy'; running = $false; released_total = 0L
    client_started_by_us = $false; started_at = $null; finished_at = $null; marked = 0; dehydrated = 0 }
  if ($r) {
    foreach ($k in @($report.Keys)) { if ($r.PSObject.Properties.Name -contains $k) { $report[$k] = $r.$k } }
  }
  $h = @{}
  foreach ($k in $report.Keys) { $h[$k] = $report[$k] }
  return $h
}

# After the client: no autostart (it puts itself back into Run), the update service manual.
function Reset-ClientAutostart {
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $props = Get-ItemProperty -Path $run -ErrorAction SilentlyContinue
  if ($props) {
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Name -like 'PS*') { continue }
      if ($p.Name -match 'Yandex' -or "$($p.Value)" -match 'YandexDisk') {
        Remove-ItemProperty -Path $run -Name $p.Name -ErrorAction SilentlyContinue
        Write-Log "autostart removed: $($p.Name)"
      }
    }
  }
  $svc = Get-Service -Name 'YandexDiskUpdateService' -ErrorAction SilentlyContinue
  if ($svc -and "$($svc.StartType)" -like 'Automatic*') {
    Set-Service -Name 'YandexDiskUpdateService' -StartupType Manual
    Write-Log 'YandexDiskUpdateService: Manual'
  }
}

function Stop-OurClient {
  Get-Process -Name 'YandexDisk*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

function Invoke-YdiskRelease {
  # A session a crash left "running": close what it started, clean up, report it over.
  $report = Read-HostReport
  if ($report.running) {
    Write-Log 'the last session did not finish: cleaning up'
    if ($report.client_started_by_us -and (Test-ClientRunning)) { Stop-OurClient }
    Reset-ClientAutostart
    $report.running = $false
    $report.client_started_by_us = $false
    $report.finished_at = Format-Utc (Get-Date)
    Save-HostReport $report
  }
  if (-not (Update-CopyList)) { Write-Log 'no new copy list in time'; return 1 }
  $answer = Get-Release 'lora' 'ydisk_copy'
  if ($answer.blocked) { Write-Log "nothing: $($answer.blocked)"; return 0 }
  $files = @($answer.files)
  if ($files.Count -eq 0) { Write-Log 'nothing: the route gives no files'; return 0 }
  Write-Log (Get-ReleaseSummary $answer)
  if (Test-ClientRunning) { Write-Log 'the Yandex client runs, not started by this task: nothing marked'; return 0 }

  # 1. No PINNED left anywhere in the copy before the client starts.
  $fixed = 0; $fixFailed = 0
  foreach ($rel in (Get-PinFix ([IO.File]::ReadAllLines($copyList)))) {
    $p = Get-LongPath $CopyRoot $rel
    $a = [ContentOps.Win32]::GetFileAttributesW($p)
    if ($a -eq $INVALID_ATTRIBUTES -or ($a -band $PINNED) -eq 0) { continue }
    if ([ContentOps.Win32]::SetFileAttributesW($p, [uint32]($a -band (-bnot $PINNED)))) { $fixed++ }
    else { $fixFailed++; Write-Log "PINNED not cleared (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())): $rel" }
  }
  if ($fixed -gt 0) { Write-Log "PINNED cleared on $fixed entries" }
  if ($fixFailed -gt 0) { Write-Log "PINNED left on $fixFailed entries: the client is not started"; return 1 }

  # 2. UNPINNED on what the route gave, checked again here.
  $marked = [Collections.Generic.List[string]]::new()
  $skipped = @{}
  foreach ($f in $files) {
    $p = Get-LongPath $CopyRoot $f.path
    $d = Get-YdiskDecision $f (Get-Live $p)
    if ($d.Action -ne 'unpin') { $skipped[$d.Reason] = 1 + [int]$skipped[$d.Reason]; continue }
    if ([ContentOps.Win32]::SetFileAttributesW($p, $d.Attributes)) { $marked.Add($p) }
    else { $skipped['set failed'] = 1 + [int]$skipped['set failed'] }
  }
  if ($skipped.Count -gt 0) { Write-Log ('skipped: ' + (($skipped.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ')) }
  if ($marked.Count -eq 0) { return 0 }

  # 3. The client takes the bytes off C:, then it is closed again.
  $freeBefore = (Get-PSDrive C).Free
  $report.running = $true
  $report.started_at = Format-Utc (Get-Date)
  $report.finished_at = $null
  $report.marked = $marked.Count
  $report.dehydrated = 0
  $report.client_started_by_us = $true
  Save-HostReport $report
  $left = $marked.Count
  try {
    Start-Process -FilePath $ClientExe
    Write-Log "marked $($marked.Count); the client started"
    $deadline = (Get-Date).AddMinutes($DehydrateMinutes)
    do {
      Start-Sleep -Seconds 30
      $left = 0
      foreach ($p in $marked) {
        $a = [ContentOps.Win32]::GetFileAttributesW($p)
        if ($a -ne $INVALID_ATTRIBUTES -and ($a -band $RECALL_ON_DATA_ACCESS) -eq 0) { $left++ }
      }
    } while ($left -gt 0 -and (Get-Date) -lt $deadline)
  } finally {
    Stop-OurClient
    Reset-ClientAutostart
    $done = $marked.Count - $left
    $report.running = $false
    $report.client_started_by_us = $false
    $report.finished_at = Format-Utc (Get-Date)
    $report.dehydrated = $done
    $report.released_total = [long]$report.released_total + $done
    Save-HostReport $report
    Write-Log ('dehydrated {0} of {1}; C: free {2:N1} -> {3:N1} GB' -f $done, $marked.Count, ($freeBefore / 1e9), ((Get-PSDrive C).Free / 1e9))
    # The VM must not read a freed file by the old list: a new one even when the session failed.
    try {
      if (-not (Update-CopyList)) { Write-Log 'no new copy list after the session' }
    } catch { Write-Log "copy list after the session: $($_.Exception.Message)" }
  }
  return 0
}

# --- E:\Ari ----------------------------------------------------------------------------------

$ariListName = 'ari-copy-list.jsonl'
$ariMetaName = 'ari-copy-list.meta.json'

# E:\Ari, metadata only, in the shape of the copy list; removed_total carried over.
function Write-AriList([long]$RemovedNow) {
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $rootFull = [IO.Path]::GetFullPath($AriRoot).TrimEnd('\')
  $started = Get-Date
  $prev = Read-JsonFile (Join-Path $HostDir $ariMetaName)
  $removedTotal = $RemovedNow
  if ($prev -and $prev.PSObject.Properties.Name -contains 'removed_total') { $removedTotal += [long]$prev.removed_total }
  $opts = [IO.EnumerationOptions]::new()
  $opts.AttributesToSkip = [IO.FileAttributes]0
  $opts.IgnoreInaccessible = $false
  $opts.RecurseSubdirectories = $true
  $target = Join-Path $HostDir $ariListName
  $fs = [IO.FileStream]::new("$target.tmp", [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 1MB)
  $w = [Text.Json.Utf8JsonWriter]::new([IO.Stream]$fs, [Text.Json.JsonWriterOptions]@{
      Encoder = [Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping })
  $s = @{ files = 0L; dirs = 0L; total_bytes = 0L; errors = 0L }
  try {
    foreach ($e in [IO.DirectoryInfo]::new("\\?\$rootFull").EnumerateFileSystemInfos('*', $opts)) {
      $full = $e.FullName.Substring(4)
      $rel = $full.Substring($rootFull.Length + 1).Replace('\', '/')
      $attrs = [uint32]$e.Attributes
      $isDir = ($attrs -band $DIRECTORY) -ne 0
      $w.WriteStartObject()
      $w.WriteString('path', $rel)
      $w.WriteBoolean('is_dir', $isDir)
      $size = if ($isDir) { 0L } else { [long]([IO.FileInfo]$e).Length }
      $w.WriteNumber('size', $size)
      $w.WriteString('last_write_utc', $e.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ', $inv))
      $w.WriteNumber('attributes', [long]$attrs)
      if ($isDir) { $w.WriteBoolean('listed', $true); $s.dirs++ }
      else { $w.WriteBoolean('bytes_present', ($attrs -band $NOT_ON_DISK) -eq 0); $s.files++; $s.total_bytes += $size }
      $w.WriteEndObject()
      $w.Flush()
      $fs.WriteByte(10)
      $w.Reset()
    }
  } catch {
    $s.errors++
    Write-Log "E:\Ari not listed in full: $($_.Exception.Message)"
  } finally {
    $w.Dispose()
    $fs.Dispose()
  }
  [IO.File]::Move("$target.tmp", $target, $true)
  $meta = [ordered]@{
    format = 'ari-copy-list@1'; list = $ariListName; copy_root = $rootFull
    started_at = Format-Utc $started; finished_at = Format-Utc (Get-Date)
    files = $s.files; dirs = $s.dirs; total_bytes = $s.total_bytes; errors = $s.errors
    dirs_not_listed = 0; client_running = $false; removed_total = $removedTotal
  }
  Write-Atomic (Join-Path $HostDir $ariMetaName) (ConvertTo-Json -InputObject $meta -Depth 3)
  return ($s.errors -eq 0)
}

# Emptied folders up to the type root: the type roots and the inventory stay.
function Remove-EmptyParents([string]$Relative) {
  $parts = $Relative.Split('/')
  for ($n = $parts.Count - 1; $n -ge 2; $n--) {
    $dir = Get-LongPath $AriRoot (($parts[0..($n - 1)]) -join '/')
    if (-not [IO.Directory]::Exists($dir)) { continue }
    if ([IO.Directory]::EnumerateFileSystemEntries($dir).GetEnumerator().MoveNext()) { return }
    [IO.Directory]::Delete($dir, $false)
  }
}

function Invoke-AriRelease {
  if (-not (Write-AriList 0)) { Write-Log 'the list has errors: nothing asked'; return 1 }
  $answer = Get-Release 'ari' 'e_ari'
  if ($answer.blocked) { Write-Log "nothing: $($answer.blocked)"; return 0 }
  $files = @($answer.files)
  if ($files.Count -eq 0) { Write-Log 'nothing: the route gives no files'; return 0 }
  Write-Log (Get-ReleaseSummary $answer)
  $removed = 0L; $bytes = 0L
  $skipped = @{}
  $now = (Get-Date).ToUniversalTime()
  foreach ($f in $files) {
    $p = Get-LongPath $AriRoot $f.path
    $d = Get-AriDecision $f (Get-Live $p) $now $null
    if ($d.Action -eq 'hash') {
      $stream = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try { $hash = Get-DropboxContentHash $stream } finally { $stream.Dispose() }
      # Checked again after the read: the file did not change meanwhile.
      $d = Get-AriDecision $f (Get-Live $p) $now $hash
    }
    if ($d.Action -ne 'delete') { $skipped[$d.Reason] = 1 + [int]$skipped[$d.Reason]; continue }
    Remove-Item -LiteralPath $p -Force
    $removed++; $bytes += [long]$f.size
    Remove-EmptyParents $f.path
  }
  if ($skipped.Count -gt 0) { Write-Log ('skipped: ' + (($skipped.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ')) }
  Write-Log ('removed {0} files, {1:N1} GB' -f $removed, ($bytes / 1e9))
  [void](Write-AriList $removed)
  return 0
}

# --- one run at a time ---------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
try {
  $lock = [IO.File]::Open((Join-Path $LogDir "originals-$Holder.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
} catch [IO.IOException] {
  exit 0
}
$code = 1
try {
  foreach ($p in @($HostDir, $LogDir)) {
    $full = [IO.Path]::GetFullPath($p).TrimEnd('\') + '\'
    foreach ($root in @($CopyRoot, $AriRoot)) {
      if ($full.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to write under a holder: $p"
      }
    }
  }
  $code = if ($Holder -eq 'ydisk') { Invoke-YdiskRelease } else { Invoke-AriRelease }
} catch {
  Write-Log "error: $($_.Exception.Message)"
  $code = 1
} finally {
  $lock.Close()
}
exit $code
