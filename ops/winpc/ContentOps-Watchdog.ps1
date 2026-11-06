<#
ContentOps-Watchdog (SPEC 12.2). Runs as SYSTEM every 5 minutes from the scheduled task
registered by register-tasks.ps1.

- VM Off -> started on every check, every 5 minutes, until it runs: no failure counter and no
  hourly limit. A failed start goes to the log on one line with its reason and the host memory
  (06.11.2026, right after Optimize-VHD: "Not enough memory in the system to start the virtual
  machine contentops with ram size 22528 megabytes" for 20 min). Not while Windows itself is
  shutting down (System event 1074 after the boot, in the last 30 min): Hyper-V turns the VM
  off for the host then, and a start would race it.
- VM Running: checks http://contentops.tail1d911a.ts.net/healthz (tailscale serve in the VM,
  HTTP while tailnet HTTPS certificates are off; the app proxy listens on loopback only).
  200 = healthy, anything else = failure. With HTTPS on, pass -HealthUrl https://...
  (register-tasks.ps1). A failure is not counted while Tailscale on this PC is down:
  restarting the VM would not help and would kill long encodes. After 3 failures in a row:
  graceful guest shutdown (forced off after 3 min), then start. At most once an hour, and not
  within the hour after the watchdog started an Off VM: a fresh boot is not cut short.
- Other states (Paused, Saved, Starting, *Critical, e.g. host disk full) are only logged.
- While C: or E: has less than 50 GB free (or is missing), the VM is neither started nor
  restarted, and the reason goes to the log. A full disk pauses the VM (critical error;
  the pause lasts 24 h, the Hyper-V maximum, register-tasks.ps1), then Hyper-V turns it off;
  starting it again would loop the only database through hard power-offs. Free the space,
  then Resume-VM contentops.
- ContentOps-Compact.ps1 disables this task while it compacts derived.vhdx.
- Log: C:\vm\contentops\logs\watchdog.log (rotated at 1 MB); counter and last start:
  watchdog-state.json next to it.
- The decision of a check is Get-WatchdogDecision, without side effects. Dot-sourced
  (. .\ContentOps-Watchdog.ps1 -LogDir <temp dir>), the script only defines its functions:
  that is how the decision is tried on made-up states without touching the VM.

Windows PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string]$VmName = 'contentops',
  [string]$HealthUrl = 'http://contentops.tail1d911a.ts.net/healthz',
  [int]$FailuresBeforeRestart = 3,
  [int]$MinMinutesBetweenRestarts = 60,
  [int]$ShutdownTimeoutSec = 180,
  [string[]]$GuardDrives = @('C', 'E'),
  [int]$MinFreeGB = 50,
  [string]$LogDir = 'C:\vm\contentops\logs'
)
$ErrorActionPreference = 'Stop'
$logFile = Join-Path $LogDir 'watchdog.log'
$stateFile = Join-Path $LogDir 'watchdog-state.json'
$tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Never throws: a full C: must not stop the check before it decides.
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

function Get-State {
  if (Test-Path $stateFile) {
    try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{ failures = 0; lastRestart = $null }
}

function Save-State($State) {
  $State | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 20
    return @{ Ok = ($r.StatusCode -eq 200); Detail = "HTTP $($r.StatusCode)" }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return @{ Ok = $false; Detail = "HTTP $([int]$resp.StatusCode)" } }
    return @{ Ok = $false; Detail = $_.Exception.Message }
  }
}

function Test-HostTailnet {
  try {
    $s = & $tailscaleExe status --json 2>$null | Out-String | ConvertFrom-Json
    return ($s.BackendState -eq 'Running')
  } catch {
    return $false
  }
}

# Drives below the floor, as 'C: 42.1 GB free'; decimal GB, as the app counts them.
function Get-LowDrives {
  $low = @()
  foreach ($letter in $GuardDrives) {
    $drive = New-Object System.IO.DriveInfo $letter
    if (-not $drive.IsReady) { $low += "$($letter): missing"; continue }
    $free = $drive.AvailableFreeSpace / 1e9
    if ($free -lt $MinFreeGB) { $low += ('{0}: {1:N1} GB free' -f $letter, $free) }
  }
  return $low
}

# Time of a shutdown or restart Windows was asked for (System 1074) after the boot, in the
# last 30 min; '' when there is none.
function Get-HostShutdown {
  try {
    $since = (Get-Date).AddMinutes(-30)
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ($boot -gt $since) { $since = $boot }
    $e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074; StartTime = $since } -MaxEvents 1
    return $e.TimeCreated.ToString('HH:mm:ss')
  } catch {
    return ''
  }
}

function Get-HostMemory {
  try {
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    return ('host memory {0:N1} GB available, {1:N1} GB modified' -f ($m.AvailableBytes / 1GB), ($m.ModifiedPageListBytes / 1GB))
  } catch {
    return 'host memory unknown'
  }
}

function ConvertTo-Time($Value) {
  if (-not $Value) { return $null }
  try { return [datetime]$Value } catch { return $null }
}

<#
One check, decided without side effects.
  VmState     Get-VM state as text
  Health      $null when not checked (VM Off), else @{ Ok; Detail } from Test-Health
  TailnetUp   Tailscale on this PC runs (checked only for a failed check of a running VM)
  State       watchdog-state.json: failures in a row, lastRestart (last start or restart, ISO)
  LowDrives   Get-LowDrives; ShutdownAt: Get-HostShutdown
Returns @{ Action = 'none' | 'start' | 'restart'; Log = lines to write; State = state to save }.
#>
function Get-WatchdogDecision($VmState, $Health, [bool]$TailnetUp, $State, [string[]]$LowDrives,
  [string]$ShutdownAt, [datetime]$Now) {
  $next = [pscustomobject]@{ failures = [int]$State.failures; lastRestart = $State.lastRestart }
  $low = @($LowDrives | Where-Object { $_ })
  $log = @()
  $action = 'none'
  if ($VmState -eq 'Off') {
    # Off is not a health failure: started on every check, whatever the last start.
    $next.failures = 0
    if ($ShutdownAt) {
      $log += "start skipped: Windows is shutting down (event 1074 at $ShutdownAt); VM Off is left as is"
    } elseif ($low.Count -gt 0) {
      $log += "start skipped: $($low -join ', ') (below $MinFreeGB GB); VM Off is left as is"
    } else {
      $action = 'start'
      $next.lastRestart = $Now.ToString('o')
      $log += 'VM Off: starting'
    }
  } elseif ($Health.Ok) {
    if ($next.failures -gt 0) { $log += "healthy again ($($Health.Detail)) after $($next.failures) failure(s)" }
    $next.failures = 0
  } elseif ($VmState -eq 'Running' -and -not $TailnetUp) {
    $log += "check failed ($($Health.Detail)), but Tailscale on this PC is not running: not counted"
  } else {
    $next.failures = $next.failures + 1
    $log += "check failed $($next.failures)/$($FailuresBeforeRestart): $($Health.Detail); VM $VmState"
    $last = ConvertTo-Time $next.lastRestart
    if ($next.failures -lt $FailuresBeforeRestart) {
      # not yet
    } elseif ($VmState -ne 'Running') {
      $log += "restart skipped: VM state $VmState is left as is"
    } elseif ($low.Count -gt 0) {
      $log += "restart skipped: $($low -join ', ') (below $MinFreeGB GB); VM Running is left as is"
    } elseif ($last -and ($Now - $last).TotalMinutes -lt $MinMinutesBetweenRestarts) {
      $log += "restart skipped: last start $([int]($Now - $last).TotalMinutes) min ago (at most one in $MinMinutesBetweenRestarts min)"
    } else {
      $action = 'restart'
      $next.failures = 0
      $next.lastRestart = $Now.ToString('o')
    }
  }
  return @{ Action = $action; Log = $log; State = $next }
}

# One Start-VM; $false when the VM does not run after it (the next check tries again).
function Start-ContentOpsVm {
  try {
    Start-VM -Name $VmName
    Write-Log "start: VM $((Get-VM -Name $VmName).State)"
    return $true
  } catch {
    $reason = Format-OneLine $_.Exception.Message
    $now = 'unknown'
    try { $now = "$((Get-VM -Name $VmName).State)" } catch { }
    if ($now -eq 'Running' -or $now -eq 'Starting') {
      # Hyper-V's own start with Windows (30 s after boot) got there first.
      Write-Log "start: VM $now already ($reason)"
      return $true
    }
    Write-Log "start failed: $reason; VM $now; $(Get-HostMemory)"
    return $false
  }
}

function Restart-ContentOpsVm {
  Write-Log 'restart: shutting the guest down'
  # Wait on the VM state only: the job reports NotStarted for a while after -AsJob.
  $job = Stop-VM -Name $VmName -Force -AsJob
  $deadline = (Get-Date).AddSeconds($ShutdownTimeoutSec)
  while ((Get-VM -Name $VmName).State -ne 'Off' -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
  }
  if ((Get-VM -Name $VmName).State -ne 'Off') {
    Write-Log "restart: guest not off after $($ShutdownTimeoutSec)s (job $($job.State)), turning the VM off"
    Stop-VM -Name $VmName -TurnOff -Force
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return (Start-ContentOpsVm)
}

# Dot-sourced: functions only (the decision is tried on made-up states, see the header).
if ($MyInvocation.InvocationName -eq '.') { return }

try {
  $state = Get-State
  $vmState = "$((Get-VM -Name $VmName).State)"
  $health = $null
  $tailnetUp = $true
  $shutdownAt = ''
  if ($vmState -eq 'Off') {
    $shutdownAt = Get-HostShutdown
  } else {
    $health = Test-Health
    if (-not $health.Ok -and $vmState -eq 'Running') { $tailnetUp = Test-HostTailnet }
  }
  $decision = Get-WatchdogDecision -VmState $vmState -Health $health -TailnetUp $tailnetUp `
    -State $state -LowDrives @(Get-LowDrives) -ShutdownAt $shutdownAt -Now (Get-Date)
  foreach ($line in $decision.Log) { Write-Log $line }
  Save-State $decision.State
  $ok = $true
  if ($decision.Action -eq 'start') { $ok = Start-ContentOpsVm }
  elseif ($decision.Action -eq 'restart') { $ok = Restart-ContentOpsVm }
  if (-not $ok) { exit 1 }
} catch {
  Write-Log "error: $(Format-OneLine $_.Exception.Message)"
  exit 1
}
exit 0
