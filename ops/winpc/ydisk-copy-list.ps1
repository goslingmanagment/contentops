<#
ContentOps-CopyList (SPEC 6.3, 12.2). Runs as SYSTEM on demand from the scheduled task
registered by register-tasks.ps1 (no trigger): the operator refreshes the list before every
import batch with `Start-ScheduledTask ContentOps-CopyList`.

The VM reads the old corpus from the local Yandex copy over cifs, where the Cloud Files
attributes are not visible, and reading a placeholder there would make the client download it.
This script lists the copy from Windows, METADATA ONLY: directories are enumerated, files are
never opened, nothing under the copy is created, changed or read. Directories that are not
populated (RECALL_ON_OPEN / OFFLINE) are not entered either: enumerating them would call the
client. The list goes to the host share C:\vm\contentops\host (read-only for
PC\contentops-ro; /mnt/host in the VM, /host in the containers):

  ydisk-copy-list.jsonl      one JSON object per line, UTF-8 without BOM:
    {"path":"1. PPV/a/b.mov","is_dir":false,"size":123,"last_write_utc":"2024-05-01T10:00:00Z",
     "attributes":1056,"bytes_present":true}
    path       relative to the copy root, "/" separators, names exactly as on disk (the client
               already wrote ":" and a trailing space as "-")
    attributes raw Win32 attributes from the directory enumeration
    files:     bytes_present = none of RECALL_ON_DATA_ACCESS 0x400000 (not fully on disk,
               partial included), RECALL_ON_OPEN 0x40000, OFFLINE 0x1000, SPARSE_FILE 0x200
               (a dehydrated placeholder is sparse; a hydrated one is not). PINNED 0x80000 and
               UNPINNED 0x100000 are kept in attributes only: they say what the client will do
               next session, not what is on disk now.
    dirs:      listed = the directory was enumerated (false: not populated, error, too deep)
  ydisk-copy-list.meta.json  time, counts, totals, per top-level folder, per attribute set.

Names that are not valid UTF-16 cannot match an API path and are skipped (counted). Both files
are written next to the target and renamed over it, so a reader never sees half of a list.
Errors go to C:\vm\contentops\logs\copy-list.log (rotated at 1 MB). The list holds real file
names: it never leaves the host share (no git, no reports; aggregates only).

PowerShell 7 (.NET EnumerationOptions, long paths through \\?\), ASCII only.
#>
#Requires -Version 7.2
param(
  [string]$CopyRoot = 'C:\Users\dmsrg\Yandex.Disk',
  [string]$OutDir = 'C:\vm\contentops\host',
  [string]$LogDir = 'C:\vm\contentops\logs',
  [int]$MaxDepth = 64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
Add-Type -AssemblyName System.Text.Json

$logFile = Join-Path $LogDir 'copy-list.log'
function Write-Log([string]$Message) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) {
    Move-Item -Force $logFile "$logFile.1"
  }
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $Message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

$SPARSE_FILE = 0x200
$OFFLINE = 0x1000
$RECALL_ON_OPEN = 0x40000
$RECALL_ON_DATA_ACCESS = 0x400000
$NOT_ON_DISK = $RECALL_ON_DATA_ACCESS -bor $RECALL_ON_OPEN -bor $OFFLINE -bor $SPARSE_FILE
$DIR_NOT_POPULATED = $RECALL_ON_OPEN -bor $OFFLINE
$DIRECTORY = 0x10

$listName = 'ydisk-copy-list.jsonl'
$metaName = 'ydisk-copy-list.meta.json'
$started = Get-Date
$fs = $null
$w = $null
try {
  $rootFull = [IO.Path]::GetFullPath($CopyRoot).TrimEnd('\')
  $outFull = [IO.Path]::GetFullPath($OutDir).TrimEnd('\')
  foreach ($p in $outFull, [IO.Path]::GetFullPath($LogDir).TrimEnd('\')) {
    if ("$p\".StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "refusing to write under the copy: $p"
    }
  }
  if (-not [IO.Directory]::Exists($rootFull)) { throw "copy root not found: $rootFull" }
  $root = [IO.DirectoryInfo]::new("\\?\$rootFull")

  $opts = [IO.EnumerationOptions]::new()
  $opts.AttributesToSkip = [IO.FileAttributes]0
  $opts.IgnoreInaccessible = $false
  $opts.RecurseSubdirectories = $false
  $opts.MatchType = [IO.MatchType]::Simple
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $inv = [Globalization.CultureInfo]::InvariantCulture

  $target = Join-Path $outFull $listName
  $tmp = "$target.tmp"
  $fs = [IO.FileStream]::new($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 1MB)
  $writerOpts = [Text.Json.JsonWriterOptions]@{
    Encoder = [Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
  }
  $w = [Text.Json.Utf8JsonWriter]::new([IO.Stream]$fs, $writerOpts)

  $s = [ordered]@{
    files = [long]0; dirs = [long]0; total_bytes = [long]0
    present_files = [long]0; present_bytes = [long]0
    placeholder_files = [long]0; placeholder_bytes = [long]0
    dirs_not_listed = [long]0; errors = [long]0; skipped_names = [long]0
  }
  $roots = @{}
  $attrSets = @{}

  function Write-Entry([string]$Rel, [bool]$IsDir, [long]$Size, [datetime]$LastWrite, [int]$Attrs, [bool]$Flag) {
    $w.WriteStartObject()
    $w.WriteString('path', $Rel)
    $w.WriteBoolean('is_dir', $IsDir)
    $w.WriteNumber('size', $Size)
    $w.WriteString('last_write_utc', $LastWrite.ToString('yyyy-MM-ddTHH:mm:ssZ', $inv))
    $w.WriteNumber('attributes', [long]$Attrs)
    if ($IsDir) { $w.WriteBoolean('listed', $Flag) } else { $w.WriteBoolean('bytes_present', $Flag) }
    $w.WriteEndObject()
    $w.Flush()
    $fs.WriteByte(10)
    $w.Reset()
  }

  # Per top-level folder; a directory counts in its own top-level folder, root files together.
  function Get-RootStats([string]$Rel, [bool]$IsDir = $false) {
    if ($IsDir) { $Rel = "$Rel/" }
    $slash = $Rel.IndexOf('/')
    $key = if ($slash -lt 0) { '(root files)' } else { $Rel.Substring(0, $slash) }
    if (-not $roots.ContainsKey($key)) {
      $roots[$key] = [ordered]@{ files = [long]0; bytes = [long]0; present_files = [long]0; present_bytes = [long]0; dirs = [long]0 }
    }
    $roots[$key]
  }

  # Depth-first with an explicit stack: own recursion, so every directory is checked before it
  # is entered. A directory line is written after its enumeration (listed is known by then).
  $stack = [Collections.Generic.Stack[object]]::new()
  $stack.Push(@($root, '', 0, 0, [datetime]::MinValue))
  while ($stack.Count -gt 0) {
    $dir, $rel, $depth, $dirAttrs, $dirWrite = $stack.Pop()
    $listed = $true
    if ($depth -gt $MaxDepth) {
      $listed = $false
      Write-Log "too deep, not listed: $rel"
    } else {
      # Enumerate first, write after: an error writing the list must not pass for a directory
      # that could not be listed. Entries read before an enumeration error are still true.
      $children = [Collections.Generic.List[IO.FileSystemInfo]]::new()
      try {
        foreach ($e in $dir.EnumerateFileSystemInfos('*', $opts)) { $children.Add($e) }
      } catch {
        $listed = $false
        $s.errors++
        Write-Log "not listed: $rel : $($_.Exception.Message)"
      }
      foreach ($e in $children) {
        $name = $e.Name
        try { [void]$strictUtf8.GetByteCount($name) } catch { $s.skipped_names++; continue }
        $childRel = if ($rel -eq '') { $name } else { "$rel/$name" }
        $attrs = [int]$e.Attributes
        if (($attrs -band $DIRECTORY) -ne 0) {
          if (($attrs -band $DIR_NOT_POPULATED) -ne 0) {
            $s.dirs++; $s.dirs_not_listed++
            $r = Get-RootStats $childRel $true
            $r.dirs++
            Write-Entry $childRel $true 0 $e.LastWriteTimeUtc $attrs $false
          } else {
            $stack.Push(@($e, $childRel, ($depth + 1), $attrs, $e.LastWriteTimeUtc))
          }
          continue
        }
        $size = [long]$e.Length
        $present = ($attrs -band $NOT_ON_DISK) -eq 0
        Write-Entry $childRel $false $size $e.LastWriteTimeUtc $attrs $present
        $s.files++; $s.total_bytes += $size
        $r = Get-RootStats $childRel
        $r.files++; $r.bytes += $size
        if ($present) {
          $s.present_files++; $s.present_bytes += $size; $r.present_files++; $r.present_bytes += $size
        } else {
          $s.placeholder_files++; $s.placeholder_bytes += $size
        }
        $key = '0x{0:X6}' -f $attrs
        if (-not $attrSets.ContainsKey($key)) { $attrSets[$key] = [ordered]@{ files = [long]0; bytes = [long]0 } }
        $attrSets[$key].files++; $attrSets[$key].bytes += $size
      }
    }
    if ($rel -ne '') {
      if (-not $listed) { $s.dirs_not_listed++ }
      $s.dirs++
      $r = Get-RootStats $rel $true
      $r.dirs++
      Write-Entry $rel $true 0 $dirWrite $dirAttrs $listed
    } elseif (-not $listed) {
      throw 'the copy root could not be listed'
    }
  }
  $w.Dispose(); $w = $null
  $fs.Dispose(); $fs = $null
  [IO.File]::Move($tmp, $target, $true)

  $finished = Get-Date
  $sortedRoots = [ordered]@{}
  foreach ($k in ($roots.Keys | Sort-Object)) { $sortedRoots[$k] = $roots[$k] }
  $sortedAttrs = [ordered]@{}
  foreach ($k in ($attrSets.Keys | Sort-Object)) { $sortedAttrs[$k] = $attrSets[$k] }
  $meta = [ordered]@{
    format = 'ydisk-copy-list@1'
    list = $listName
    copy_root = $rootFull
    started_at = $started.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', $inv)
    finished_at = $finished.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', $inv)
    duration_s = [math]::Round(($finished - $started).TotalSeconds, 1)
    client_running = [bool](Get-Process -Name 'YandexDisk*' -ErrorAction SilentlyContinue)
    bytes_present_rule = 'files without RECALL_ON_DATA_ACCESS 0x400000, RECALL_ON_OPEN 0x40000, OFFLINE 0x1000, SPARSE_FILE 0x200'
  }
  foreach ($k in $s.Keys) { $meta[$k] = $s[$k] }
  $meta.roots = $sortedRoots
  $meta.file_attributes = $sortedAttrs
  $metaTarget = Join-Path $outFull $metaName
  [IO.File]::WriteAllText("$metaTarget.tmp", (ConvertTo-Json -InputObject $meta -Depth 5))
  [IO.File]::Move("$metaTarget.tmp", $metaTarget, $true)
  Write-Log ('ok: {0} files, {1} dirs, {2} present, {3} placeholders, {4} errors, {5:N1} s' -f `
      $s.files, $s.dirs, $s.present_files, $s.placeholder_files, $s.errors, $meta.duration_s)
} catch {
  if ($null -ne $w) { $w.Dispose() }
  if ($null -ne $fs) { $fs.Dispose() }
  Write-Log "error: $($_.Exception.Message)"
  exit 1
}
