<#
Registers the Windows scheduled task ContentOps-Watchdog on winpc (SPEC 12.2): SYSTEM, at
startup and every 5 minutes, Windows PowerShell 5.1. Copies ContentOps-Watchdog.ps1 to
C:\vm\contentops\ops\ and runs it from there; log in C:\vm\contentops\logs\.

The task is registered DISABLED unless -Enable is given: until the app answers /healthz the
watchdog would restart the VM every hour. The deploy enables it (-Enable). Re-running replaces
the task. Run elevated on winpc, e.g. from the Mac:
  scp ops/winpc/*.ps1 winpc:C:/vm/contentops/ops/
  ssh winpc 'pwsh -NoProfile -File C:\vm\contentops\ops\register-tasks.ps1'

Ends with a read-only report of the host settings SPEC 12.2 relies on.
ASCII only.
#>
param([switch]$Enable)
$ErrorActionPreference = 'Stop'
$taskName = 'ContentOps-Watchdog'
$vmName = 'contentops'
$opsDir = 'C:\vm\contentops\ops'
$logDir = 'C:\vm\contentops\logs'

New-Item -ItemType Directory -Force -Path $opsDir, $logDir | Out-Null
$src = Join-Path $PSScriptRoot 'ContentOps-Watchdog.ps1'
$dst = Join-Path $opsDir 'ContentOps-Watchdog.ps1'
if ((Resolve-Path $src).Path -ne $dst) { Copy-Item -Force $src $dst }

$action = New-ScheduledTaskAction `
  -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dst`""
$atStartup = New-ScheduledTaskTrigger -AtStartup
$every5Min = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $atStartup, $every5Min `
  -Principal $principal -Settings $settings -Force `
  -Description 'ContentOps: /healthz every 5 min, VM restart after 3 failures, at most hourly (ops/winpc)' |
  Out-Null
if ($Enable) { Enable-ScheduledTask -TaskName $taskName | Out-Null }
else { Disable-ScheduledTask -TaskName $taskName | Out-Null }
"{0}: {1}" -f $taskName, (Get-ScheduledTask -TaskName $taskName).State

# Host settings SPEC 12.2 relies on (report only, nothing is changed here).
$vm = Get-VM -Name $vmName
$power = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$checks = @(
  @('VM starts with Windows', $vm.AutomaticStartAction, 'Start'),
  @('VM on host shutdown', $vm.AutomaticStopAction, 'ShutDown'),
  @('VM automatic checkpoints', $vm.AutomaticCheckpointsEnabled, $false),
  @('VM dynamic memory', $vm.DynamicMemoryEnabled, $false),
  @('Fast Startup (HiberbootEnabled)', $power.HiberbootEnabled, 0)
)
foreach ($c in $checks) {
  $mark = if ("$($c[1])" -eq "$($c[2])") { 'ok ' } else { 'FIX' }
  "{0} {1}: {2} (expected {3})" -f $mark, $c[0], $c[1], $c[2]
}
"    VM memory: {0} GB static, snapshots: {1}" -f ($vm.MemoryStartup / 1GB), @(Get-VMSnapshot -VMName $vmName).Count
