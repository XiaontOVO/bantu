$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
. (Join-Path $root 'scripts\bantu-process.ps1')
Write-Host '=== Bantu diagnostics ==='
if (Get-Command node -ErrorAction SilentlyContinue) {
  Write-Host ('Node: ' + (node --version))
} else {
  Write-Host 'Node: NOT FOUND. Install Node.js 22+ from https://nodejs.org/'
}
if (Test-Path (Join-Path $root 'node_modules\typescript')) {
  Write-Host 'Dependencies: OK'
} else {
  Write-Host 'Dependencies: missing (run npm install)'
}
$pidFile = Join-Path $root 'data\bantu-server.pid'
$port = 8787
if (Test-Path $pidFile) {
  $record = Read-BantuProcessRecord -Path $pidFile
  if (-not $record) {
    Write-Host 'PID file: invalid'
    Write-Host 'Bantu process: PID file is invalid'
  } else {
    Write-Host ('PID file: ' + $record.ProcessId)
    if ($record.Port) { $port = $record.Port }
    $process = Get-BantuProcessById -ProcessId $record.ProcessId
    if (-not $process) {
      Write-Host 'Bantu process: pid file exists but process is gone'
    } else {
      $identity = Get-BantuProcessIdentity -Process $process -Root $root
      $rootMatches = -not $record.Root -or
        [System.IO.Path]::GetFullPath($record.Root).Equals([System.IO.Path]::GetFullPath($root), [System.StringComparison]::OrdinalIgnoreCase)
      if ($identity -ne 'other' -and $rootMatches) {
        Write-Host 'Bantu process: identity matches this project'
      } else {
        Write-Host 'Bantu process: PID belongs to a different process; it was not touched'
      }
    }
  }
} else {
  Write-Host 'Bantu process: not running (no pid file)'
}
$client = New-Object System.Net.Sockets.TcpClient
try {
  $client.Connect('127.0.0.1', $port)
  Write-Host ('Port {0}: LISTENING' -f $port)
} catch {
  Write-Host ('Port {0}: not listening' -f $port)
} finally {
  $client.Close()
}
try {
  $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/v1/health' -f $port) -UseBasicParsing -TimeoutSec 3
  Write-Host ('Health: ' + ($health | ConvertTo-Json -Compress))
  Write-Host 'Next: open http://127.0.0.1:8787/'
} catch {
  Write-Host 'Health: connection refused. Start with 启动伴途.cmd or scripts\start-windows.ps1'
}
Write-Host '========================='
