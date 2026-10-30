<#
Registers the Windows scheduled tasks of the pilot VM on winpc (SPEC 12.2), all SYSTEM; the
first two at startup and every 5 minutes in Windows PowerShell 5.1; scripts are copied to
C:\vm\contentops\ops\ and run from there, logs in C:\vm\contentops\logs\.

- ContentOps-Watchdog: /healthz, VM restart after 3 failures. Registered DISABLED unless
  -Enable is given: until the app answers /healthz it would restart the VM every hour. The
  deploy enables it (-Enable). -HealthUrl overrides the checked address (https once tailnet
  HTTPS certificates are on).
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
foreach ($name in 'ContentOps-Watchdog.ps1', 'ContentOps-Space.ps1', 'ydisk-copy-list.ps1') {
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

function Register-Every5Min([string]$TaskName, [string]$Script, [string]$Arguments, [string]$Description) {
  $action = New-ScheduledTaskAction `
    -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $opsDir $Script)`" $Arguments"
  $atStartup = New-ScheduledTaskTrigger -AtStartup
  $every5Min = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atStartup, $every5Min `
    -Principal $principal -Settings $settings -Force -Description $Description | Out-Null
}

Register-Every5Min 'ContentOps-Watchdog' 'ContentOps-Watchdog.ps1' "-HealthUrl `"$HealthUrl`"" `
  'ContentOps: /healthz every 5 min, VM restart after 3 failures, at most hourly (ops/winpc)'
if ($Enable) { Enable-ScheduledTask -TaskName 'ContentOps-Watchdog' | Out-Null }
else { Disable-ScheduledTask -TaskName 'ContentOps-Watchdog' | Out-Null }

Register-Every5Min 'ContentOps-Space' 'ContentOps-Space.ps1' '' `
  'ContentOps: free space of C: and E: for the VM, every 5 min (ops/winpc)'
Enable-ScheduledTask -TaskName 'ContentOps-Space' | Out-Null
Start-ScheduledTask -TaskName 'ContentOps-Space'

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

foreach ($name in 'ContentOps-Watchdog', 'ContentOps-Space', 'ContentOps-CopyList') {
  "{0}: {1}" -f $name, (Get-ScheduledTask -TaskName $name).State
}
"{0}: {1} -> {2}" -f $shareName, (Get-SmbShare -Name $shareName).Path, $shareUser

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
