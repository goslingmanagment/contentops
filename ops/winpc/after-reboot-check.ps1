<#
After a reboot of winpc (PLAN 6, SPEC 12.2): the Windows half of the check; the VM half is
ops/vm/after-reboot-check.sh. Read-only: nothing is started, stopped or changed. From the Mac:

  ssh winpc 'pwsh -NoProfile -Command -' < ops/winpc/after-reboot-check.ps1

Checks: last boot and why (System log 1074 / 6008 / 41), inside the night window; Windows
Update installs and a pending reboot; the VM Running with its heartbeat; the scheduled tasks
ContentOps-Watchdog and ContentOps-Space and their last results; Tailscale on the PC; the
Yandex.Disk client NOT running and NOT set to start by itself (Run keys, the update service
Manual); free space of C: and E:; /healthz through the tailnet as a person reaches it.
Exit 1 when something FAILs. PowerShell 7 or Windows PowerShell 5.1, ASCII only.
#>
# No param block: the script also runs from stdin (pwsh -Command -). The night window of
# Windows Update: install at 04:00, reboot 15 min later (ops/README.md).
$VmName = 'contentops'
$HealthUrl = 'http://contentops.tail1d911a.ts.net/healthz'
$NightFromHour = 0
$NightToHour = 6
$ErrorActionPreference = 'Continue'
$script:fails = 0

function Row([string]$Status, [string]$Area, [string]$Name, [string]$Detail) {
  if ($Status -eq 'FAIL') { $script:fails++ }
  '{0,-4}  {1,-9}  {2,-26}  {3}' -f $Status, $Area, $Name, $Detail
}

function Stamp($When) {
  if ($null -eq $When) { return 'never' }
  return ([datetime]$When).ToString('dd.MM HH:mm')
}

function Events([string]$Log, [int[]]$Ids, [datetime]$Since, [int]$Max = 5) {
  try {
    return @(Get-WinEvent -FilterHashtable @{ LogName = $Log; Id = $Ids; StartTime = $Since } `
        -MaxEvents $Max -ErrorAction Stop)
  } catch { return @() }
}

function OneLine([string]$Text, [int]$Max = 160) {
  $flat = ($Text -replace '\s+', ' ').Trim()
  if ($flat.Length -gt $Max) { return $flat.Substring(0, $Max) + '...' }
  return $flat
}

# --- Boot -----------------------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$boot = $os.LastBootUpTime
$up = (Get-Date) - $boot
Row 'ok' 'host' 'booted' ('{0} (up {1}d {2}h {3}m)' -f (Stamp $boot), $up.Days, $up.Hours, $up.Minutes)
if ($boot.Hour -ge $NightFromHour -and $boot.Hour -lt $NightToHour) {
  Row 'ok' 'host' 'night window' ('boot at {0:HH:mm}, inside {1:00}:00-{2:00}:00' -f $boot, $NightFromHour, $NightToHour)
} else {
  Row 'warn' 'host' 'night window' ('boot at {0:HH:mm}, outside {1:00}:00-{2:00}:00 (by hand, power or an update outside the window?)' -f $boot, $NightFromHour, $NightToHour)
}
# 1074: who asked for the restart and why; 6008 / 41: the previous shutdown was not clean.
$reasons = Events 'System' @(1074, 6008, 41) $boot.AddHours(-12) 10 |
  Where-Object { $_.TimeCreated -le $boot.AddMinutes(5) } | Sort-Object TimeCreated -Descending
$last = $reasons | Select-Object -First 1
if ($null -eq $last) {
  Row 'warn' 'host' 'boot reason' 'no 1074/6008/41 event in the 12 h before the boot'
} elseif ($last.Id -eq 1074) {
  $p = $last.Properties
  $who = if ($p.Count -ge 7) { '{0}; {1}; {2}' -f $p[0].Value, $p[2].Value, $p[4].Value } else { OneLine $last.Message }
  Row 'ok' 'host' 'boot reason' ('{0} 1074: {1}' -f (Stamp $last.TimeCreated), (OneLine $who))
} else {
  Row 'FAIL' 'host' 'boot reason' ('{0} event {1}: not a clean shutdown - {2}' -f (Stamp $last.TimeCreated), $last.Id, (OneLine $last.Message 120))
}

# --- Windows Update -------------------------------------------------------------------
$wu = 'Microsoft-Windows-WindowsUpdateClient/Operational'
$installed = Events $wu @(19) (Get-Date).AddDays(-14) 3
$failedWu = Events $wu @(20) (Get-Date).AddDays(-14) 3
if ($installed.Count -gt 0) {
  foreach ($e in $installed) {
    $title = if ($e.Properties.Count -gt 0) { $e.Properties[0].Value } else { OneLine $e.Message 100 }
    Row 'ok' 'update' 'installed' ('{0} {1}' -f (Stamp $e.TimeCreated), (OneLine $title 120))
  }
} else {
  Row 'ok' 'update' 'installed' 'nothing in the last 14 days'
}
foreach ($e in $failedWu) {
  $title = if ($e.Properties.Count -gt 1) { $e.Properties[1].Value } else { OneLine $e.Message 100 }
  Row 'warn' 'update' 'failed' ('{0} {1}' -f (Stamp $e.TimeCreated), (OneLine $title 120))
}
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
  Row 'warn' 'update' 'reboot pending' 'Windows Update waits for a reboot (the next night window)'
} else {
  Row 'ok' 'update' 'reboot pending' 'no'
}

# --- The VM ---------------------------------------------------------------------------
$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($null -eq $vm) {
  Row 'FAIL' 'vm' $VmName 'not found (Hyper-V rights?)'
} else {
  if ("$($vm.State)" -eq 'Running') {
    Row 'ok' 'vm' 'state' ('Running, up {0:%d}d {0:hh}h {0:mm}m' -f $vm.Uptime)
  } else {
    Row 'FAIL' 'vm' 'state' ('{0} ({1})' -f $vm.State, $vm.Status)
  }
  $hb = Get-VMIntegrationService -VMName $VmName -Name 'Heartbeat' -ErrorAction SilentlyContinue
  if ($hb -and "$($hb.PrimaryStatusDescription)" -eq 'OK') { Row 'ok' 'vm' 'guest heartbeat' 'OK' } else { Row 'warn' 'vm' 'guest heartbeat' ("{0}" -f $hb.PrimaryStatusDescription) }
  # A full C: or E: pauses the VM; the pause must not turn it off after 30 min (SPEC 12.2).
  if ("$($vm.AutomaticCriticalErrorAction)" -eq 'Pause' -and $vm.AutomaticCriticalErrorActionTimeout -ge 1440) {
    Row 'ok' 'vm' 'critical-error pause' ('{0} min' -f $vm.AutomaticCriticalErrorActionTimeout)
  } else {
    Row 'FAIL' 'vm' 'critical-error pause' ('{0}, {1} min (register-tasks.ps1)' -f $vm.AutomaticCriticalErrorAction, $vm.AutomaticCriticalErrorActionTimeout)
  }
  $vmStart = Events 'Microsoft-Windows-Hyper-V-Worker-Admin' @(18500) $boot 1
  if ($vmStart.Count -gt 0) { Row 'ok' 'vm' 'started after boot' (Stamp $vmStart[0].TimeCreated) }
}

# --- Scheduled tasks ------------------------------------------------------------------
foreach ($name in 'ContentOps-Watchdog', 'ContentOps-Space') {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task) { Row 'FAIL' 'tasks' $name 'not registered (register-tasks.ps1)'; continue }
  $info = Get-ScheduledTaskInfo -TaskName $name
  $detail = '{0}; last run {1}, result 0x{2:X}; next {3}' -f $task.State, (Stamp $info.LastRunTime), $info.LastTaskResult, (Stamp $info.NextRunTime)
  # 0x41301: running right now.
  if ("$($task.State)" -eq 'Disabled') {
    Row 'FAIL' 'tasks' $name $detail
  } elseif ($info.LastTaskResult -ne 0 -and $info.LastTaskResult -ne 0x41301) {
    Row 'FAIL' 'tasks' $name $detail
  } elseif ($info.LastRunTime -lt $boot) {
    Row 'FAIL' 'tasks' $name ('not run since the boot - ' + $detail)
  } else {
    Row 'ok' 'tasks' $name $detail
  }
}
$wlog = 'C:\vm\contentops\logs\watchdog.log'
if (Test-Path $wlog) {
  foreach ($line in (Get-Content $wlog -Tail 3)) { Row 'ok' 'tasks' 'watchdog.log' (OneLine $line 140) }
}

# --- Tailscale on the PC (the watchdog counts failures only while it runs) ---------------
$ts = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
if ($ts -and "$($ts.Status)" -eq 'Running') { Row 'ok' 'access' 'Tailscale service' 'Running' } else { Row 'FAIL' 'access' 'Tailscale service' ("{0}" -f $ts.Status) }
try {
  $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 15
  if ($r.StatusCode -eq 200 -and $r.Content -match '"ok":true') { Row 'ok' 'access' 'healthz (tailnet)' $HealthUrl } else { Row 'FAIL' 'access' 'healthz (tailnet)' ('HTTP {0} {1}' -f $r.StatusCode, $r.Content) }
} catch {
  Row 'FAIL' 'access' 'healthz (tailnet)' (OneLine $_.Exception.Message)
}

# --- Yandex.Disk client: installed, but never running by itself (SPEC 12.2) -------------
$client = @(Get-Process -Name 'YandexDisk*' -ErrorAction SilentlyContinue)
if ($client.Count -eq 0) { Row 'ok' 'yandex' 'client process' 'not running' } else { Row 'FAIL' 'yandex' 'client process' ('RUNNING: {0} (started {1})' -f ($client.Name -join ', '), (Stamp $client[0].StartTime)) }
$runKeys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')
$autostart = @()
foreach ($key in $runKeys) {
  $values = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($null -eq $values) { continue }
  foreach ($p in $values.PSObject.Properties) {
    if ($p.Name -notlike 'PS*' -and ("$($p.Name) $($p.Value)" -match 'Yandex')) { $autostart += "$key\$($p.Name)" }
  }
}
if ($autostart.Count -eq 0) { Row 'ok' 'yandex' 'autostart (Run keys)' 'none' } else { Row 'FAIL' 'yandex' 'autostart (Run keys)' ('BACK: ' + ($autostart -join '; ') + ' - an update of the client restored it') }
$svc = Get-Service -Name 'YandexDiskUpdateService' -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  Row 'warn' 'yandex' 'YandexDiskUpdateService' 'not found'
} elseif ("$($svc.StartType)" -eq 'Manual') {
  Row 'ok' 'yandex' 'YandexDiskUpdateService' ('Manual, {0}' -f $svc.Status)
} else {
  Row 'FAIL' 'yandex' 'YandexDiskUpdateService' ('start type {0}, {1} (must be Manual)' -f $svc.StartType, $svc.Status)
}

# --- Space as Windows sees it ---------------------------------------------------------
foreach ($letter in 'C', 'E') {
  $d = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue
  if ($null -eq $d) { Row 'FAIL' 'space' "${letter}:" 'missing (E: gone - the VM cannot start, ops/README.md)'; continue }
  $free = [math]::Round($d.Free / 1GB)
  $status = if ($letter -eq 'C' -and $free -lt 100) { 'FAIL' } elseif ($letter -eq 'C' -and $free -lt 200) { 'warn' } else { 'ok' }
  Row $status 'space' "${letter}:" ('{0} GB free of {1} GB' -f $free, [math]::Round(($d.Free + $d.Used) / 1GB))
}

if ($script:fails -gt 0) { "FAILED: $($script:fails)"; exit 1 }
'PASSED'
exit 0
