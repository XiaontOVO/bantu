param(
  [int]$Port = 8787,
  # 默认开放局域网（0.0.0.0）；服务端邀请码门禁自动启用，本机 127.0.0.1 不受影响。
  # 如需仅本机使用，改回 127.0.0.1。
  [string]$HostAddress = '0.0.0.0',
  [switch]$NoBrowser,
  [switch]$NoInstall,
  [switch]$MemoryState,
  [switch]$Restart,
  [switch]$NewAccessCode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
. (Join-Path $root 'scripts\bantu-process.ps1')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js not found. Please install Node.js 22 or later: https://nodejs.org/'
}

if (-not (Test-Path (Join-Path $root 'node_modules\typescript')) -and -not $NoInstall) {
  Write-Host 'First run: installing npm dependencies (network required)...'
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Server was not started.' }
}

Write-Host 'Building Bantu...'
& npm.cmd run build:test | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Fix the reported errors before starting Bantu.' }
$buildFingerprint = Get-BantuBuildFingerprint -Root $root

$env:PORT = "$Port"
# 0.0.0.0 = 局域网可访；如需仅本机使用，改回 127.0.0.1。
$env:HOST = $HostAddress
if ($NewAccessCode) { $env:BANTU_RANDOM_ACCESS_CODE = 'true' }
# 小范围测试使用真实账号和真实发布内容，默认不注入社区演示帖子。
# 需要展示固定演示内容时，可在启动前显式设置 BANTU_SEED_DEMO=true。
$env:BANTU_SEED_DEMO = if ($env:BANTU_SEED_DEMO) { $env:BANTU_SEED_DEMO } else { 'false' }
if ($MemoryState) {
  $env:STATE_STORE = 'memory'
  Remove-Item Env:STATE_FILE -ErrorAction SilentlyContinue
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
  $env:STATE_STORE = 'sqlite'
  $env:STATE_FILE = Join-Path $root 'data\bantu-state.sqlite'
}

$pidFile = Join-Path $root 'data\bantu-server.pid'
$record = Read-BantuProcessRecord -Path $pidFile
if ($record) {
  $oldProcess = Get-BantuProcessById -ProcessId $record.ProcessId
  if ($oldProcess) {
    $identity = Get-BantuProcessIdentity -Process $oldProcess -Root $root
    $buildAction = Get-BantuBuildRecordAction -Record $record -Identity $identity -Root $root -BuildFingerprint $buildFingerprint
    $restartRequested = ($Restart -or $NewAccessCode) -and $buildAction -eq 'current'
    if ($buildAction -eq 'current' -and -not $restartRequested) {
      $fallbackPort = if ($record.Port) { $record.Port } else { $Port }
      $candidatePorts = Get-BantuListenerPorts -ProcessId $record.ProcessId -FallbackPort $fallbackPort
      $healthyPort = $null
      foreach ($candidatePort in $candidatePorts) {
        if (Test-BantuHealth -Port $candidatePort) { $healthyPort = [int]$candidatePort; break }
      }
      if ($healthyPort) {
        Write-BantuProcessRecord -Path $pidFile -ProcessId $record.ProcessId -Port $healthyPort -Root $root -BuildFingerprint $buildFingerprint
        Write-Host "Bantu is already running: PID $($record.ProcessId) (port $healthyPort)."
        Show-BantuLanAccess -Root $root -ProcessId $record.ProcessId -Port $healthyPort
        if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$healthyPort/" }
        exit 0
      }
      throw "Bantu process $($record.ProcessId) is present but its health check failed. Run scripts\stop-windows.ps1, then start it again."
    }

    if ($buildAction -eq 'stale' -or $restartRequested) {
      # Recheck ownership immediately before stopping in case the PID exited and
      # Windows reused it while the build fingerprint was being compared.
      $confirmedProcess = Get-BantuProcessById -ProcessId $record.ProcessId
      if (-not $confirmedProcess -or
        (Get-BantuBuildRecordAction -Record $record -Identity (Get-BantuProcessIdentity -Process $confirmedProcess -Root $root) -Root $root -BuildFingerprint $buildFingerprint) -ne $buildAction) {
        throw "Bantu PID $($record.ProcessId) changed while checking the old build. No process was stopped; inspect it in Task Manager, then run scripts\start-windows.ps1 again."
      }

      if ($restartRequested) {
        Write-Host "Restarting the managed Bantu server (PID $($record.ProcessId)) with the requested access settings. SQLite data will be kept."
      } else {
        Write-Host "The managed Bantu server (PID $($record.ProcessId)) was built from older files; restarting it. SQLite data will be kept."
      }
      Stop-Process -Id $record.ProcessId -Force
      for ($attempt = 0; $attempt -lt 30 -and (Get-BantuProcessById -ProcessId $record.ProcessId); $attempt++) {
        Start-Sleep -Milliseconds 100
      }
      if (Get-BantuProcessById -ProcessId $record.ProcessId) {
        throw "The old Bantu process $($record.ProcessId) did not stop. No new server was started; stop it in Task Manager and retry. SQLite data was not changed."
      }
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
      $fallbackPort = if ($record.Port) { $record.Port } else { $Port }
      $healthyPort = $null
      foreach ($candidatePort in (Get-BantuListenerPorts -ProcessId $record.ProcessId -FallbackPort $fallbackPort)) {
        if (Test-BantuHealth -Port $candidatePort) { $healthyPort = [int]$candidatePort; break }
      }
      if ($healthyPort) {
        throw "PID $($record.ProcessId) serves a healthy app on port $healthyPort, but its project root or command identity cannot be verified. It was left running. Inspect the process in Task Manager and stop it from the project folder that started it, then run scripts\start-windows.ps1 again. SQLite data was not changed."
      }
      Write-Host "PID $($record.ProcessId) cannot be verified as this project's server; leaving it untouched and clearing only the PID record."
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  } else {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
} elseif (Test-Path -LiteralPath $pidFile) {
  Write-Host 'The PID file is invalid; removing it without stopping any process.'
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$entrypoint = Join-Path $root 'dist\src\server\main.js'
$process = Start-Process -FilePath node `
  -ArgumentList ('"{0}"' -f $entrypoint) `
  -WorkingDirectory $root `
  -PassThru `
  -WindowStyle Hidden

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null
Write-BantuProcessRecord -Path $pidFile -ProcessId $process.Id -Port $Port -Root $root -BuildFingerprint $buildFingerprint

$healthUrl = "http://127.0.0.1:$Port/api/v1/health"
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 300
  $runningProcess = Get-BantuProcessById -ProcessId $process.Id
  if (-not $runningProcess -or (Get-BantuProcessIdentity -Process $runningProcess -Root $root) -ne 'current') { break }
  $ownedPorts = Get-BantuListenerPorts -ProcessId $process.Id -FallbackPort 0
  if ($Port -notin $ownedPorts) { continue }
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($health.data.status -eq 'ok' -and @('sqlite', 'in-memory') -contains [string]$health.data.service) {
      $ready = $true
      break
    }
  } catch {
    # Server is not ready yet; keep waiting.
  }
}

if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  throw "Bantu failed to start. Check whether port $Port is already in use."
}

$url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host "Bantu is running: $url"
Show-BantuLanAccess -Root $root -ProcessId $process.Id -Port $Port
Write-Host 'Stop: run scripts\stop-windows.ps1.'
Write-Host 'Install as a Windows app: open the URL in Edge/Chrome, then choose Apps -> Install this site as an app.'
if (-not $NoBrowser) { Start-Process $url }
