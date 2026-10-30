<#
ContentOps-Space (SPEC 12.2). Runs as SYSTEM every 5 minutes from the scheduled task
registered by register-tasks.ps1.

The VM disks are growing VHDX files: free space inside the VM says nothing about the host.
This script writes the free and total bytes of C: and E: as Windows sees them to
C:\vm\contentops\host\space.json. The folder is the share contentops-host, read-only for
PC\contentops-ro only; the VM mounts it at /mnt/host (ops/vm/setup-host-share.sh) and the web
container reads /host/space.json. A report older than 15 minutes is shown as "net dannykh".

  {"measured_at":"2026-10-30T12:00:00Z","disks":[{"name":"C:","free_bytes":...,"total_bytes":...}]}

The file is written next to the target and renamed over it, so a reader never sees half of
it; UTF-8 without BOM. Errors go to C:\vm\contentops\logs\space.log (rotated at 1 MB).
Windows PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string[]]$Drives = @('C', 'E'),
  [string]$OutDir = 'C:\vm\contentops\host',
  [string]$LogDir = 'C:\vm\contentops\logs'
)
$ErrorActionPreference = 'Stop'
$logFile = Join-Path $LogDir 'space.log'

function Write-Log([string]$Message) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) {
    Move-Item -Force $logFile "$logFile.1"
  }
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $Message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

try {
  $disks = @()
  foreach ($letter in $Drives) {
    $drive = New-Object System.IO.DriveInfo $letter
    if (-not $drive.IsReady) { throw "drive $($letter): is not ready" }
    $disks += [ordered]@{
      name = "$($letter):"
      free_bytes = [int64]$drive.AvailableFreeSpace
      total_bytes = [int64]$drive.TotalSize
    }
  }
  $doc = [ordered]@{
    measured_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    disks = $disks
  }
  $json = ConvertTo-Json -InputObject $doc -Depth 4 -Compress
  $target = Join-Path $OutDir 'space.json'
  $tmp = "$target.tmp"
  [System.IO.File]::WriteAllText($tmp, $json)
  Move-Item -Force -Path $tmp -Destination $target
} catch {
  Write-Log "error: $($_.Exception.Message)"
  exit 1
}
