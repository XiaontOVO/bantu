$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = [System.IO.Path]::GetFullPath($root)
. (Join-Path $root 'scripts\bantu-process.ps1')
$pidFile = Join-Path $root 'data\bantu-server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'Bantu is not running.'
  exit 0
}

$record = Read-BantuProcessRecord -Path $pidFile
if (-not $record) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Invalid PID file; cleaned it without stopping any process.'
  exit 0
}

$process = Get-BantuProcessById -ProcessId $record.ProcessId
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Process is gone; cleaned the pid file.'
  exit 0
}

$identity = Get-BantuProcessIdentity -Process $process -Root $root
$recordRootMatches = -not $record.Root -or
  [System.IO.Path]::GetFullPath($record.Root).Equals($root, [System.StringComparison]::OrdinalIgnoreCase)
if ($identity -eq 'other' -or -not $recordRootMatches) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "PID $($record.ProcessId) belongs to another process; left it running and cleaned the stale PID file."
  exit 0
}

if ($identity -eq 'legacy') {
  $fallbackPort = if ($record.Port) { $record.Port } else { 8787 }
  $healthyPort = $null
  foreach ($candidatePort in (Get-BantuListenerPorts -ProcessId $record.ProcessId -FallbackPort $fallbackPort)) {
    if (Test-BantuHealth -Port $candidatePort) { $healthyPort = [int]$candidatePort; break }
  }
  if (-not $healthyPort) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "PID $($record.ProcessId) uses an older launch form and could not be confirmed through health checks; left it running."
    exit 0
  }
}

Stop-Process -Id $record.ProcessId -Force
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Bantu stopped (PID $($record.ProcessId)). Data remains in data\bantu-state.sqlite."
