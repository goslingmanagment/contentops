<#
ContentOps-Compact (ops/README.md, "Mesto"). Runs as SYSTEM from the scheduled task registered
by register-tasks.ps1: every night at 04:30 Moscow time, half an hour after the VM trims its
disks (fstrim.timer at 04:00, ops/vm/setup-disks.sh), and 10 min after Windows starts.

derived.vhdx on E: is a growing VHDX: what the VM frees stays in the file until Optimize-VHD,
which needs the VM off (06.11.2026 by hand: 233.6 -> 146.9 GiB, the VM off for 4 min). While E:
has at least -MinFreeGB free (160, the E: warning of the app, SPACE_WARN_GB E:=160; decimal GB
as the app counts them), a run only logs "not needed". Below it:
  1. the watchdog task is disabled (it would start the VM in the middle); the marker
     compact-running.json says so;
  2. the guest shuts down (at most 6 min, else nothing is compacted);
  3. Optimize-VHD -Mode Full;
  4. finally the VM is started again if this run turned it off: Start-VM every 30 s for up to
     30 min, each failure logged with its reason and the host memory (06.11.2026, right after
     Optimize-VHD, Windows had no 22 GB to give the VM for 20 min); then the watchdog is
     enabled again and the marker removed. A VM still off is the watchdog's: it starts it on
     every check.
Without -Force nothing is done outside 00:00-06:00 (people use the VM by day) or while the
watchdog is disabled by hand (work on the VM); -Force compacts at once, whatever the free space.
A run cut short (Windows restarted, the process killed) leaves the marker: the next run, 10 min
after startup or the next night, enables the watchdog again.

Log: C:\vm\contentops\logs\compact.log (rotated at 1 MB), next to the watchdog's. Dot-sourced
(. .\ContentOps-Compact.ps1 -LogDir <temp dir>) the script only defines its functions: that is
how it is tried with stubs instead of Hyper-V. Windows PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string]$VmName = 'contentops',
  [string]$VhdPath = 'E:\vm\contentops\derived.vhdx',
  [int]$MinFreeGB = 160,
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

# Free space of the drive with the VHDX and the file itself, decimal GB as the app counts them.
function Get-Space {
  $root = [System.IO.Path]::GetPathRoot($VhdPath)
  $drive = New-Object System.IO.DriveInfo $root
  if (-not $drive.IsReady) { throw "drive $root is not ready" }
  return [pscustomobject]@{
    Drive = $root.TrimEnd('\')
    FreeGB = $drive.AvailableFreeSpace / 1e9
    FileGB = (Get-Item -LiteralPath $VhdPath).Length / 1e9
  }
}

function Format-Space($Space) {
  return ('{0} {1:N1} GB free, {2} {3:N1} GB' -f $Space.Drive, $Space.FreeGB, (Split-Path $VhdPath -Leaf), $Space.FileGB)
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
  if (-not $Force -and $before.FreeGB -ge $MinFreeGB) {
    Write-Log ('not needed: {0} (compacts below {1} GB)' -f (Format-Space $before), $MinFreeGB)
    return
  }
  $now = Get-Date
  if (-not $Force -and ($now.Hour -lt $NightFromHour -or $now.Hour -ge $NightToHour)) {
    Write-Log ('skipped: {0}, but the VM stops only {1:00}:00-{2:00}:00 (-Force: now)' -f (Format-Space $before), $NightFromHour, $NightToHour)
    return
  }
  $vmState = Get-VmState
  if ($vmState -ne 'Running' -and $vmState -ne 'Off') {
    Write-Log ('skipped: {0}, VM {1} is left as is' -f (Format-Space $before), $vmState)
    return
  }
  $task = Get-ScheduledTask -TaskName $WatchdogTask -ErrorAction SilentlyContinue
  $watchdogOn = ($null -ne $task) -and ("$($task.State)" -ne 'Disabled')
  if ($null -ne $task -and -not $watchdogOn -and -not $Force) {
    Write-Log ('skipped: {0}, the watchdog is disabled by hand (work on the VM?)' -f (Format-Space $before))
    return
  }

  Write-Log ('compacting: {0}, VM {1}' -f (Format-Space $before), $vmState)
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
    $t1 = Get-Date
    Optimize-VHD -Path $VhdPath -Mode Full
    $after = Get-Space
    Write-Log ('optimized in {0:N0} s: {1}, {2:N1} GB returned' -f ((Get-Date) - $t1).TotalSeconds, (Format-Space $after), ($before.FileGB - $after.FileGB))
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
