<#
Registers the Windows scheduled tasks of the pilot VM on winpc (SPEC 12.2), all SYSTEM; the
first two at startup and every 5 minutes in Windows PowerShell 5.1; scripts are copied to
C:\vm\contentops\ops\ and run from there, logs in C:\vm\contentops\logs\.

- ContentOps-Watchdog: starts the VM when it is off; /healthz, VM restart after 3 failures.
  Registered DISABLED unless -Enable is given: until the app answers /healthz it would restart
  the VM every hour. The deploy enables it (-Enable). -HealthUrl overrides the checked address
  (https once tailnet HTTPS certificates are on).
- ContentOps-Compact: daily at 04:30 Moscow time and 10 min after startup, Windows PowerShell
  5.1, at most 3 h; compacts derived.vhdx when E: is below 160 GB free (ContentOps-Compact.ps1).
  No catch-up of a missed night: it would stop the VM by day. Registered DISABLED unless
  -Enable is given, like the watchdog.
- ContentOps-Space: free space of C: and E: as Windows sees it, to
  C:\vm\contentops\host\space.json. Always enabled. The folder is shared as contentops-host,
  read-only for PC\contentops-ro only (the account of the ydisk-ro share); the VM mounts it
  at /mnt/host (ops/vm/setup-host-share.sh). Nothing is ever shared from the Yandex copy here.
- ContentOps-CopyList: on demand only (no trigger), PowerShell 7. Lists the Yandex copy,
  metadata only, to C:\vm\contentops\host\ydisk-copy-list.jsonl (ydisk-copy-list.ps1); the
  operator refreshes it before each import batch: Start-ScheduledTask ContentOps-CopyList.

Re-running replaces the tasks and keeps the share. Run elevated on winpc, e.g. from the Mac:
  scp ops/winpc/*.ps1 winpc:C:/vm/contentops/ops/
  ssh winpc 'pwsh -NoProfile -File C:\vm\contentops\ops\register-tasks.ps1 -Enable'

Sets the critical-error pause of the VM: a full C: or E: pauses it for 24 h, the Hyper-V
maximum (1441 min and more is refused with 0x80041008), instead of the default 30 min, after
which the VM is turned off; the watchdog keeps it off below 50 GB free. Applies to a running
VM; if Hyper-V refuses, the script prints a FIX line.

Ends with a read-only report of the host settings SPEC 12.2 relies on.
ASCII only.
#>
param(
  [switch]$Enable,
  [string]$HealthUrl = 'http://contentops.tail1d911a.ts.net/healthz'
)
$ErrorActionPreference = 'Stop'
$vmName = 'contentops'
$opsDir = 'C:\vm\contentops\ops'
$logDir = 'C:\vm\contentops\logs'
$hostDir = 'C:\vm\contentops\host'
$shareName = 'contentops-host'
$shareUser = "$env:COMPUTERNAME\contentops-ro"

New-Item -ItemType Directory -Force -Path $opsDir, $logDir, $hostDir | Out-Null
foreach ($name in 'ContentOps-Watchdog.ps1', 'ContentOps-Space.ps1', 'ContentOps-Compact.ps1', 'ydisk-copy-list.ps1') {
  $src = Join-Path $PSScriptRoot $name
  $dst = Join-Path $opsDir $name
  if ((Resolve-Path $src).Path -ne $dst) { Copy-Item -Force $src $dst }
}

# The VM reads space.json over the internal network: read-only, one account, like ydisk-ro.
& icacls $hostDir /grant "$($shareUser):(OI)(CI)RX" | Out-Null
if (-not (Get-SmbShare -Name $shareName -ErrorAction SilentlyContinue)) {
  New-SmbShare -Name $shareName -Path $hostDir -ReadAccess $shareUser `
    -FolderEnumerationMode AccessBased -CachingMode None | Out-Null
}

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

function New-Ps51Action([string]$Script, [string]$Arguments) {
  return New-ScheduledTaskAction `
    -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $opsDir $Script)`" $Arguments"
}

function Register-Every5Min([string]$TaskName, [string]$Script, [string]$Arguments, [string]$Description) {
  $action = New-Ps51Action $Script $Arguments
  $atStartup = New-ScheduledTaskTrigger -AtStartup
  $every5Min = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atStartup, $every5Min `
    -Principal $principal -Settings $settings -Force -Description $Description | Out-Null
}

Register-Every5Min 'ContentOps-Watchdog' 'ContentOps-Watchdog.ps1' "-HealthUrl `"$HealthUrl`"" `
  'ContentOps: every 5 min starts the VM when off, restarts it after 3 failed /healthz, at most hourly (ops/winpc)'
if ($Enable) { Enable-ScheduledTask -TaskName 'ContentOps-Watchdog' | Out-Null }
else { Disable-ScheduledTask -TaskName 'ContentOps-Watchdog' | Out-Null }

Register-Every5Min 'ContentOps-Space' 'ContentOps-Space.ps1' '' `
  'ContentOps: free space of C: and E: for the VM, every 5 min (ops/winpc)'
Enable-ScheduledTask -TaskName 'ContentOps-Space' | Out-Null
Start-ScheduledTask -TaskName 'ContentOps-Space'

# Compaction of derived.vhdx: 04:30 Moscow time, after fstrim in the VM at 04:00 (Europe/Moscow);
# 10 min after startup a run cut short by a restart gets the watchdog back on.
$moscow = [TimeZoneInfo]::FindSystemTimeZoneById('Russian Standard Time')
$compactAt = [TimeZoneInfo]::ConvertTime([datetime]::SpecifyKind([datetime]::Today.AddHours(4.5), 'Unspecified'),
  $moscow, [TimeZoneInfo]::Local)
$nightly = New-ScheduledTaskTrigger -Daily -At $compactAt
$afterStartup = New-ScheduledTaskTrigger -AtStartup
$afterStartup.Delay = 'PT10M'
$compactSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName 'ContentOps-Compact' -Action (New-Ps51Action 'ContentOps-Compact.ps1' '') `
  -Trigger $nightly, $afterStartup -Principal $principal -Settings $compactSettings -Force `
  -Description 'ContentOps: 04:30 MSK, compacts derived.vhdx when E: is below 160 GB free (ops/winpc)' | Out-Null
if ($Enable) { Enable-ScheduledTask -TaskName 'ContentOps-Compact' | Out-Null }
else { Disable-ScheduledTask -TaskName 'ContentOps-Compact' | Out-Null }

# The copy list runs when the operator starts it (before an import batch), never by itself.
$pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path $pwsh)) { throw "PowerShell 7 is needed for ContentOps-CopyList: $pwsh" }
$copyListAction = New-ScheduledTaskAction -Execute $pwsh `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $opsDir 'ydisk-copy-list.ps1')`""
$onDemand = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'ContentOps-CopyList' -Action $copyListAction -Principal $principal `
  -Settings $onDemand -Force `
  -Description 'ContentOps: metadata-only list of the Yandex copy for the import, on demand (ops/winpc)' | Out-Null
Enable-ScheduledTask -TaskName 'ContentOps-CopyList' | Out-Null

foreach ($name in 'ContentOps-Watchdog', 'ContentOps-Space', 'ContentOps-Compact', 'ContentOps-CopyList') {
  "{0}: {1}, next run {2}" -f $name, (Get-ScheduledTask -TaskName $name).State, (Get-ScheduledTaskInfo -TaskName $name).NextRunTime
}
"{0}: {1} -> {2}" -f $shareName, (Get-SmbShare -Name $shareName).Path, $shareUser

# Full host disk: pause, not off after 30 min (SPEC 12.2); minutes.
$criticalPauseMin = 24 * 60
$vm = Get-VM -Name $vmName
if ("$($vm.AutomaticCriticalErrorAction)" -ne 'Pause' -or $vm.AutomaticCriticalErrorActionTimeout -ne $criticalPauseMin) {
  try {
    Set-VM -Name $vmName -AutomaticCriticalErrorAction Pause -AutomaticCriticalErrorActionTimeout $criticalPauseMin
  } catch {
    "FIX critical-error pause not set with the VM $($vm.State): $($_.Exception.Message)"
  }
}

# Host settings SPEC 12.2 relies on (report only, nothing else is changed here).
$vm = Get-VM -Name $vmName
$power = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$checks = @(
  @('VM starts with Windows', $vm.AutomaticStartAction, 'Start'),
  @('VM on host shutdown', $vm.AutomaticStopAction, 'ShutDown'),
  @('VM automatic checkpoints', $vm.AutomaticCheckpointsEnabled, $false),
  @('VM dynamic memory', $vm.DynamicMemoryEnabled, $false),
  @('VM on critical error (full disk)', $vm.AutomaticCriticalErrorAction, 'Pause'),
  @('VM critical pause, min', $vm.AutomaticCriticalErrorActionTimeout, $criticalPauseMin),
  @('Fast Startup (HiberbootEnabled)', $power.HiberbootEnabled, 0)
)
foreach ($c in $checks) {
  $mark = if ("$($c[1])" -eq "$($c[2])") { 'ok ' } else { 'FIX' }
  "{0} {1}: {2} (expected {3})" -f $mark, $c[0], $c[1], $c[2]
}
"    VM memory: {0} GB static, snapshots: {1}" -f ($vm.MemoryStartup / 1GB), @(Get-VMSnapshot -VMName $vmName).Count
