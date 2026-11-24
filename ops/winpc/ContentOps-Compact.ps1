<#
ContentOps-Compact (ops/README.md, "Mesto"). Runs as SYSTEM from the scheduled task registered
by register-tasks.ps1: every night at 04:30 Moscow time, half an hour after the VM trims its
disks (fstrim.timer at 04:00, ops/vm/setup-disks.sh), and 10 min after Windows starts.

derived.vhdx on E: and data.vhdx on C: are growing VHDX files: what the VM frees stays in the
file until Optimize-VHD, which needs the VM off (06.11.2026 by hand: derived 233.6 -> 146.9 GiB,
the VM off for 4 min). One stop of the VM compacts both:
  - derived.vhdx (previews, frames, prefetch) when E: has less than -MinFreeGB free (160, the
    E: warning of the app, SPACE_WARN_GB E:=160; decimal GB as the app counts them);
  - data.vhdx (blobs, the database) when C: has less than -DataMinFreeGB free (200, the C:
    warning of the pilot) AND the VM removed more than -DataFreedGB (20) from it since the last
    compaction of data.vhdx: the release of the originals (SPEC 9.4) and the owner's purge-blobs.
    What the VM removed comes from GET /api/v1/admin/originals/vm-freed (removed_bytes, a total)
    with the host agent's token (-TokenFile, the one of ContentOps-Originals); the total at the
    last compaction is kept in compact-data.json next to the log. The route not answering, the
    token missing: data.vhdx is not compacted this night. Compacting data.vhdx every night would
    stop the only database for nothing.
  Whenever the VM is stopped, derived.vhdx is compacted too (a minute or two).
If neither is needed a run only logs "not needed". Otherwise:
  1. the watchdog task is disabled (it would start the VM in the middle); the marker
     compact-running.json says so;
  2. the guest shuts down (at most 6 min, else nothing is compacted);
  3. Optimize-VHD -Mode Full of each disk, one after the other (a failure of one is logged and
     the other is still tried);
  4. finally the VM is started again if this run turned it off: Start-VM every 30 s for up to
     30 min, each failure logged with its reason and the host memory (06.11.2026, right after
     Optimize-VHD, Windows had no 22 GB to give the VM for 20 min); then the watchdog is
     enabled again and the marker removed. A VM still off is the watchdog's: it starts it on
     every check.
Without -Force nothing is done outside 00:00-06:00 (people use the VM by day) or while the
watchdog is disabled by hand (work on the VM); -Force compacts both at once, whatever the free
space. A run cut short (Windows restarted, the process killed) leaves the marker: the next run,
10 min after startup or the next night, enables the watchdog again.

Log: C:\vm\contentops\logs\compact.log (rotated at 1 MB), next to the watchdog's. Dot-sourced
(. .\ContentOps-Compact.ps1 -LogDir <temp dir>) the script only defines its functions: that is
how it is tried with stubs instead of Hyper-V. Windows PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string]$VmName = 'contentops',
  [string]$VhdPath = 'E:\vm\contentops\derived.vhdx',
  [int]$MinFreeGB = 160,
  [string]$DataVhdPath = 'C:\vm\contentops\data.vhdx',
  [int]$DataMinFreeGB = 200,
  [int]$DataFreedGB = 20,
  [string]$ApiBase = 'http://contentops.tail1d911a.ts.net',
  [string]$TokenFile = 'C:\vm\contentops\secrets\originals-agent.token',
  [switch]$Force,
  [int]$ShutdownTimeoutSec = 360,
  [int]$StartRetrySec = 30,
  [int]$StartTimeoutMin = 30,
  [int]$NightFromHour = 0,
  [int]$NightToHour = 6,
  [string]$WatchdogTask = 'ContentOps-Watchdog',
  [string]$LogDir = 'C:\vm\contentops\logs'
)
$ErrorActionPreference = 'Stop'
$logFile = Join-Path $LogDir 'compact.log'
$markerFile = Join-Path $LogDir 'compact-running.json'
$dataStateFile = Join-Path $LogDir 'compact-data.json'
$script:exitCode = 0

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Never throws: the finally below must reach Start-VM and the watchdog whatever happens.
function Write-Log([string]$Message) {
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) {
      Move-Item -Force $logFile "$logFile.1"
    }
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $Message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
}

# Hyper-V errors span several lines; the log keeps one line per event.
function Format-OneLine([string]$Text, [int]$Max = 500) {
  $flat = ($Text -replace '\s+', ' ').Trim()
  if ($flat.Length -gt $Max) { $flat = $flat.Substring(0, $Max) + '...' }
  return $flat
}

function Get-HostMemory {
  try {
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    return ('host memory {0:N1} GB available, {1:N1} GB modified' -f ($m.AvailableBytes / 1GB), ($m.ModifiedPageListBytes / 1GB))
  } catch {
    return 'host memory unknown'
  }
}

function Get-VmState {
  try { return "$((Get-VM -Name $VmName).State)" } catch { return 'unknown' }
}

# Free space of the drive with a VHDX and the file itself, decimal GB as the app counts them.
function Get-Space([string]$Path = $VhdPath) {
  $root = [System.IO.Path]::GetPathRoot($Path)
  $drive = New-Object System.IO.DriveInfo $root
  if (-not $drive.IsReady) { throw "drive $root is not ready" }
  return [pscustomobject]@{
    Drive = $root.TrimEnd('\')
    FreeGB = $drive.AvailableFreeSpace / 1e9
    File = (Split-Path $Path -Leaf)
    FileGB = (Get-Item -LiteralPath $Path).Length / 1e9
  }
}

function Format-Space($Space) {
  return ('{0} {1:N1} GB free, {2} {3:N1} GB' -f $Space.Drive, $Space.FreeGB, $Space.File, $Space.FileGB)
}

# What the VM has removed from its data disk so far (a total): the route of ContentOps.
function Get-VmFreed {
  $token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
  if (-not $token) { throw "no token in $TokenFile" }
  $uri = '{0}/api/v1/admin/originals/vm-freed' -f $ApiBase.TrimEnd('/')
  $answer = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 60 -UseBasicParsing
  return [double]$answer.removed_bytes
}

# The total the VM had removed at the last compaction of data.vhdx; 0 before the first one.
function Read-DataState {
  if (-not (Test-Path -LiteralPath $dataStateFile)) { return [double]0 }
  try {
    return [double]((Get-Content -LiteralPath $dataStateFile -Raw | ConvertFrom-Json).removed_bytes)
  } catch {
    return [double]0
  }
}

function Write-DataState([double]$RemovedBytes) {
  $doc = [ordered]@{ removed_bytes = $RemovedBytes; compacted_at = (Get-Date).ToString('o') }
  ConvertTo-Json -InputObject $doc | Set-Content -LiteralPath $dataStateFile -Encoding UTF8
}

# Whether data.vhdx is compacted this run, and why (or why not). Never throws: a failure here
# must not keep derived.vhdx from its compaction.
function Get-DataPlan {
  try {
    $space = Get-Space $DataVhdPath
  } catch {
    return [pscustomobject]@{ Need = $false; RemovedBytes = $null; Note = "data: $(Format-OneLine $_.Exception.Message)" }
  }
  if (-not $Force -and $space.FreeGB -ge $DataMinFreeGB) {
    return [pscustomobject]@{ Need = $false; RemovedBytes = $null; Note = ('{0} (compacts below {1} GB)' -f (Format-Space $space), $DataMinFreeGB) }
  }
  $removed = $null
  $why = ''
  try { $removed = Get-VmFreed } catch { $why = Format-OneLine $_.Exception.Message }
  if ($null -eq $removed) {
    return [pscustomobject]@{ Need = [bool]$Force; RemovedBytes = $null; Note = ('{0}, freed in the VM unknown: {1}' -f (Format-Space $space), $why) }
  }
  $freedGB = ($removed - (Read-DataState)) / 1e9
  return [pscustomobject]@{
    Need = ([bool]$Force -or $freedGB -gt $DataFreedGB)
    RemovedBytes = $removed
    Note = ('{0}, {1:N1} GB freed in the VM since its last compaction (compacts above {2} GB)' -f (Format-Space $space), $freedGB, $DataFreedGB)
  }
}

# Optimize-VHD of one disk with the VM off; logs and returns $false on failure, never throws.
function Optimize-One([string]$Path) {
  try {
    $before = Get-Space $Path
    $t1 = Get-Date
    Optimize-VHD -Path $Path -Mode Full
    $after = Get-Space $Path
    Write-Log ('optimized {0} in {1:N0} s: {2}, {3:N1} GB returned' -f $after.File, ((Get-Date) - $t1).TotalSeconds, (Format-Space $after), ($before.FileGB - $after.FileGB))
    return $true
  } catch {
    Write-Log "error: $(Split-Path $Path -Leaf): $(Format-OneLine $_.Exception.Message)"
    return $false
  }
}

function Test-RunAlive($Marker) {
  try {
    $p = Get-Process -Id ([int]$Marker.pid)
    return ([math]::Abs(($p.StartTime - [datetime]$Marker.process_start).TotalSeconds) -lt 2)
  } catch {
    return $false
  }
}

# A marker left by a run that never reached its finally: the watchdog goes back on. $false when
# the run that wrote it is still under way.
function Resume-CutShortRun {
  if (-not (Test-Path -LiteralPath $markerFile)) { return $true }
  $m = $null
  try { $m = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json } catch { }
  if ($m -and (Test-RunAlive $m)) {
    Write-Log "skipped: another run is under way (pid $($m.pid), since $($m.started))"
    return $false
  }
  $which = if ($m) { "of $($m.started)" } else { 'with an unreadable marker' }
  if (($null -eq $m -or $m.watchdog_was_enabled) -and (Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue)) {
    Enable-ScheduledTask -TaskName $WatchdogTask | Out-Null
    Write-Log "the run $which did not finish (Windows restarted or the process was killed): watchdog enabled again"
  } else {
    Write-Log "the run $which did not finish; the watchdog was disabled before it and stays so"
  }
  Remove-Item -Force -LiteralPath $markerFile
  return $true
}

function Write-Marker([bool]$WatchdogWasEnabled) {
  $doc = [ordered]@{
    pid = $PID
    process_start = (Get-Process -Id $PID).StartTime.ToString('o')
    started = (Get-Date).ToString('o')
    watchdog_was_enabled = $WatchdogWasEnabled
  }
  ConvertTo-Json -InputObject $doc | Set-Content -LiteralPath $markerFile -Encoding UTF8
}

# A watchdog run that began before its task was disabled ends first (a restart takes up to
# 4 min): it must not find the VM off and start it in the middle.
function Wait-WatchdogIdle {
  $deadline = (Get-Date).AddMinutes(5)
  while (@(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
      Where-Object { $_.CommandLine -like '*ContentOps-Watchdog.ps1*' }).Count -gt 0) {
    if ((Get-Date) -ge $deadline) { throw 'a watchdog run is still busy after 5 min, not compacting' }
    Start-Sleep -Seconds 5
  }
}

# Guest shutdown. Not off in time: no compaction (a forced power-off of the only database is
# not worth it); the shutdown request may still finish later, then the watchdog starts the VM.
function Stop-ContentOpsVm {
  $t0 = Get-Date
  # Wait on the VM state only: the job reports NotStarted for a while after -AsJob.
  $job = Stop-VM -Name $VmName -Force -AsJob
  $deadline = $t0.AddSeconds($ShutdownTimeoutSec)
  while ((Get-VmState) -ne 'Off' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $state = Get-VmState
  if ($state -ne 'Off') { throw "guest not off after $ShutdownTimeoutSec s (VM $state), not compacting" }
  Write-Log ('guest off after {0:N0} s' -f ((Get-Date) - $t0).TotalSeconds)
}

# Start-VM every -StartRetrySec until the VM runs, for up to -StartTimeoutMin. Never throws.
function Start-ContentOpsVm {
  $deadline = (Get-Date).AddMinutes($StartTimeoutMin)
  $try = 0
  while ((Get-VmState) -ne 'Running') {
    $try++
    try {
      Start-VM -Name $VmName
      Write-Log "start: try $try, VM $(Get-VmState)"
    } catch {
      Write-Log ('start: try {0} failed: {1}; {2}' -f $try, (Format-OneLine $_.Exception.Message), (Get-HostMemory))
    }
    if ((Get-VmState) -eq 'Running') { break }
    if ((Get-Date) -ge $deadline) {
      Write-Log "start: VM still $(Get-VmState) after $StartTimeoutMin min of tries; the watchdog starts it on every check"
      return $false
    }
    Start-Sleep -Seconds $StartRetrySec
  }
  return $true
}

function Invoke-Compact {
  $script:exitCode = 0
  if (-not (Resume-CutShortRun)) { return }
  $before = Get-Space
  $needDerived = [bool]$Force -or $before.FreeGB -lt $MinFreeGB
  $data = Get-DataPlan
  $what = ('{0}; {1}' -f (Format-Space $before), $data.Note)
  if (-not $needDerived -and -not $data.Need) {
    Write-Log ('not needed: {0} (compacts below {1} GB); {2}' -f (Format-Space $before), $MinFreeGB, $data.Note)
    return
  }
  $now = Get-Date
  if (-not $Force -and ($now.Hour -lt $NightFromHour -or $now.Hour -ge $NightToHour)) {
    Write-Log ('skipped: {0}, but the VM stops only {1:00}:00-{2:00}:00 (-Force: now)' -f $what, $NightFromHour, $NightToHour)
    return
  }
  $vmState = Get-VmState
  if ($vmState -ne 'Running' -and $vmState -ne 'Off') {
    Write-Log ('skipped: {0}, VM {1} is left as is' -f $what, $vmState)
    return
  }
  $task = Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
  $watchdogOn = ($null -ne $task) -and ("$($task.State)" -ne 'Disabled')
  if ($null -ne $task -and -not $watchdogOn -and -not $Force) {
    Write-Log ('skipped: {0}, the watchdog is disabled by hand (work on the VM?)' -f $what)
    return
  }

  $disks = if ($data.Need) { 'derived.vhdx and data.vhdx' } else { 'derived.vhdx' }
  Write-Log ('compacting {0}: {1}, VM {2}' -f $disks, $what, $vmState)
  $t0 = Get-Date
  $stopped = $false
  $markerOk = $false
  try {
    # The marker first: a run cut short after the next line still leaves a trace.
    Write-Marker $watchdogOn
    $markerOk = $true
    if ($watchdogOn) {
      Disable-ScheduledTask -TaskName $WatchdogTask | Out-Null
      Write-Log 'watchdog disabled'
    }
    Wait-WatchdogIdle
    if ($vmState -eq 'Running') {
      $stopped = $true
      Stop-ContentOpsVm
    }
    # The VM is off anyway: derived.vhdx goes along whenever the stop is for data.vhdx.
    if (-not (Optimize-One $VhdPath)) { $script:exitCode = 1 }
    if ($data.Need) {
      if (Optimize-One $DataVhdPath) {
        # What the VM had removed before this stop is in the file no more.
        if ($null -ne $data.RemovedBytes) { Write-DataState $data.RemovedBytes }
      } else {
        $script:exitCode = 1
      }
    }
  } catch {
    Write-Log "error: $(Format-OneLine $_.Exception.Message)"
    $script:exitCode = 1
  } finally {
    if ($stopped -and -not (Start-ContentOpsVm)) { $script:exitCode = 1 }
    $watchdogBack = $true
    if ($watchdogOn) {
      try {
        Enable-ScheduledTask -TaskName $WatchdogTask | Out-Null
        Write-Log 'watchdog enabled'
      } catch {
        # The marker stays: the next run enables it.
        $watchdogBack = $false
        Write-Log "error: watchdog not enabled again: $(Format-OneLine $_.Exception.Message)"
        $script:exitCode = 1
      }
    }
    if ($markerOk -and $watchdogBack) { Remove-Item -Force -LiteralPath $markerFile -ErrorAction SilentlyContinue }
    Write-Log ('done in {0:N0} s: VM {1}' -f ((Get-Date) - $t0).TotalSeconds, (Get-VmState))
  }
}

# Dot-sourced: functions only (tests with stubs, see the header).
if ($MyInvocation.InvocationName -eq '.') { return }

try {
  Invoke-Compact
} catch {
  Write-Log "error: $(Format-OneLine $_.Exception.Message)"
  $script:exitCode = 1
}
exit $script:exitCode
