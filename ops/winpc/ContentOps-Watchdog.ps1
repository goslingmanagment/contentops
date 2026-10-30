<#
ContentOps-Watchdog (SPEC 12.2). Runs as SYSTEM every 5 minutes from the scheduled task
registered by register-tasks.ps1.

- Checks http://contentops.tail1d911a.ts.net/healthz (tailscale serve in the VM, HTTP while
  tailnet HTTPS certificates are off; the app proxy listens on loopback only). 200 = healthy,
  anything else = failure. With HTTPS on, pass -HealthUrl https://... (register-tasks.ps1).
- A failure is not counted while the VM is Running but Tailscale on this PC is down:
  restarting the VM would not help and would kill long encodes.
- After 3 failures in a row: VM Running -> graceful guest shutdown (forced off after
  3 min), then start; VM Off -> start. Other states (Paused, Saved, *Critical, e.g. host
  disk full) are only logged. At most one restart per hour.
- Log: C:\vm\contentops\logs\watchdog.log (rotated at 1 MB); counter and last restart:
  watchdog-state.json next to it.

Windows PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string]$VmName = 'contentops',
  [string]$HealthUrl = 'http://contentops.tail1d911a.ts.net/healthz',
  [int]$FailuresBeforeRestart = 3,
  [int]$MinMinutesBetweenRestarts = 60,
  [int]$ShutdownTimeoutSec = 180,
  [string]$LogDir = 'C:\vm\contentops\logs'
)
$ErrorActionPreference = 'Stop'
$logFile = Join-Path $LogDir 'watchdog.log'
$stateFile = Join-Path $LogDir 'watchdog-state.json'
$tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$Message) {
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) {
    Move-Item -Force $logFile "$logFile.1"
  }
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $Message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
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

function Restart-ContentOpsVm($Vm) {
  if ($Vm.State -eq 'Running') {
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
  }
  Start-VM -Name $VmName
  Write-Log "restart: VM $((Get-VM -Name $VmName).State)"
}

try {
  $state = Get-State
  $vm = Get-VM -Name $VmName
  $health = Test-Health

  if ($health.Ok) {
    if ($state.failures -gt 0) { Write-Log "healthy again ($($health.Detail)) after $($state.failures) failure(s)" }
    $state.failures = 0
    Save-State $state
    return
  }

  if ($vm.State -eq 'Running' -and -not (Test-HostTailnet)) {
    Write-Log "check failed ($($health.Detail)), but Tailscale on this PC is not running: not counted"
    return
  }

  $state.failures = [int]$state.failures + 1
  Write-Log "check failed $($state.failures)/$($FailuresBeforeRestart): $($health.Detail); VM $($vm.State)"
  if ($state.failures -lt $FailuresBeforeRestart) { Save-State $state; return }

  if ($vm.State -ne 'Running' -and $vm.State -ne 'Off') {
    Write-Log "restart skipped: VM state $($vm.State) is left as is"
    Save-State $state
    return
  }
  if ($state.lastRestart) {
    $since = (Get-Date) - [datetime]$state.lastRestart
    if ($since.TotalMinutes -lt $MinMinutesBetweenRestarts) {
      Write-Log "restart skipped: last restart $([int]$since.TotalMinutes) min ago"
      Save-State $state
      return
    }
  }

  $state.failures = 0
  $state.lastRestart = (Get-Date).ToString('o')
  Save-State $state
  Restart-ContentOpsVm $vm
} catch {
  Write-Log "error: $($_.Exception.Message)"
  exit 1
}
