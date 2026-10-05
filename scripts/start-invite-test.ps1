param([ValidateSet('Cloudflare', 'Serveo', 'LocalhostRun', 'Pinggy')][string]$Transport = 'Cloudflare')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
. (Join-Path $root 'scripts\bantu-process.ps1')

# 业务端口只由本机网关访问，避免另一个网络入口沿用上一轮邀请码。
$localReady = $false
try {
  $appHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/v1/health' -TimeoutSec 3
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction Stop)
  $appRecord = Read-BantuProcessRecord -Path (Join-Path $root 'data\bantu-server.pid')
  $appProcess = if ($appRecord) { Get-BantuProcessById -ProcessId $appRecord.ProcessId } else { $null }
  $owned = $appRecord -and $appProcess -and $appRecord.Root -and
    [System.IO.Path]::GetFullPath($appRecord.Root).Equals([System.IO.Path]::GetFullPath($root), [System.StringComparison]::OrdinalIgnoreCase) -and
    (Get-BantuProcessIdentity -Process $appProcess -Root $root) -eq 'current'
  $localReady = $owned -and $appHealth.data.status -eq 'ok' -and $listeners.Count -gt 0 -and
    @($listeners | Where-Object { $_.OwningProcess -ne $appRecord.ProcessId }).Count -eq 0 -and
    @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -eq 0
} catch { }
if (-not $localReady) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-windows.ps1') -HostAddress '127.0.0.1' -Restart -NoBrowser
  if ($LASTEXITCODE -ne 0) { throw 'The local Bantu server could not be prepared. No public endpoint was opened.' }
}
$appHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/v1/health' -TimeoutSec 3
if ($appHealth.data.status -ne 'ok') { throw 'The local Bantu server is not healthy.' }

$shareDir = Join-Path $env:TEMP 'bantu-share'
New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
$metadataPath = Join-Path $shareDir 'processes.json'
if (Test-Path -LiteralPath $metadataPath) {
  $previous = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$previous.gatewayScript -ne (Join-Path $root 'scripts\invite-gateway.mjs')) {
    throw 'An invitation process belongs to another project. It was not stopped.'
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\stop-invite-test.ps1')
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $metadataPath)) { throw 'The previous invitation could not be safely closed.' }
}
$gatewayPort = 8788
$existingGateway = Get-NetTCPConnection -State Listen -LocalPort $gatewayPort -ErrorAction SilentlyContinue
if ($existingGateway) {
  throw "Port $gatewayPort is already in use. Stop the previous invite gateway first."
}

$cloudflared = Join-Path $shareDir 'cloudflared.exe'
if ($Transport -eq 'Cloudflare' -and -not (Test-Path -LiteralPath $cloudflared)) {
  Write-Host 'Downloading the Cloudflare quick-tunnel program...'
  Invoke-WebRequest `
    -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
    -OutFile $cloudflared
}

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
$bytes = New-Object byte[] 1
do {
  $code = ''
  while ($code.Length -lt 8) {
    $rng.GetBytes($bytes)
    # 拒绝超过整倍数范围的字节，保持每个字符等概率。
    if ($bytes[0] -lt ([Math]::Floor(256 / $alphabet.Length) * $alphabet.Length)) {
      $code += $alphabet[$bytes[0] % $alphabet.Length]
    }
  }
} while ($previous -and $code -eq $previous.code)
$rng.Dispose()
$bytes = $null

$gatewayLog = Join-Path $shareDir 'gateway.log'
$gatewayError = Join-Path $shareDir 'gateway-error.log'
$tunnelLog = Join-Path $shareDir 'tunnel.log'
$tunnelError = Join-Path $shareDir 'tunnel-error.log'
# 启动前清空上一轮日志。重定向子进程尚未写入时，不能从旧日志提取过期域名。
foreach ($logPath in @($gatewayLog, $gatewayError, $tunnelLog, $tunnelError)) {
  Set-Content -LiteralPath $logPath -Value '' -Encoding UTF8
}
$gatewayProcess = $null
$tunnelProcess = $null

try {
  $env:BANTU_INVITE_CODE = $code
  $env:BANTU_APP_HOST = '127.0.0.1'
  $env:BANTU_APP_PORT = '8787'
  $env:BANTU_GATE_HOST = '127.0.0.1'
  $env:BANTU_GATE_PORT = "$gatewayPort"
  $gatewayProcess = Start-Process `
    -FilePath (Get-Command node).Source `
    -ArgumentList ('"' + (Join-Path $root 'scripts\invite-gateway.mjs') + '"') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $gatewayLog `
    -RedirectStandardError $gatewayError
  [Environment]::SetEnvironmentVariable('BANTU_INVITE_CODE', $null, 'Process')

  $gatewayReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Get-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue) {
      try {
        $page = Invoke-WebRequest -Uri "http://127.0.0.1:$gatewayPort/" -TimeoutSec 2 -UseBasicParsing
        if ($page.Content -match '<form method="post" action="/__invite">') { $gatewayReady = $true; break }
      } catch { }
    }
  }
  if (-not $gatewayReady) { throw 'The invite gateway did not start.' }

  if ($Transport -eq 'Cloudflare') {
    $tunnelExecutable = $cloudflared
    $tunnelArguments = @('tunnel', '--url', "http://127.0.0.1:$gatewayPort", '--protocol', 'http2', '--no-autoupdate')
    $urlPattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
  } else {
    $tunnelExecutable = (Get-Command ssh.exe -ErrorAction Stop).Source
    $remoteHost = switch ($Transport) { 'Serveo' { 'serveo.net' }; 'LocalhostRun' { 'localhost.run' }; 'Pinggy' { 'free.pinggy.io' } }
    $remotePort = if ($Transport -eq 'LocalhostRun') { '22' } else { '443' }
    $forwardPort = if ($Transport -eq 'Pinggy') { '0' } else { '80' }
    $remoteUser = if ($Transport -eq 'LocalhostRun') { 'nokey' } else { 'bantu' }
    $knownHosts = Join-Path $shareDir 'known-hosts'
    $identityFile = Join-Path $shareDir 'tunnel-identity'
    if (-not (Test-Path -LiteralPath $identityFile)) {
      & ssh-keygen.exe -q -t ed25519 -N '""' -f $identityFile
      if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated tunnel identity.' }
    }
    $tunnelArguments = @('-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none',
      '-o', 'IdentitiesOnly=yes', '-i', ('"' + $identityFile + '"'),
      '-o', 'PreferredAuthentications=publickey,none', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', ('UserKnownHostsFile="' + $knownHosts + '"'), '-o', 'ConnectTimeout=8', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-p', $remotePort,
      '-R', "${forwardPort}:127.0.0.1:$gatewayPort", "${remoteUser}@${remoteHost}")
    $urlPattern = switch ($Transport) {
      'Serveo' { 'https://[a-z0-9-]+\.(?:serveo\.net|serveousercontent\.com)' }
      'LocalhostRun' { 'https://[a-z0-9-]+\.(?:lhr\.life|localhost\.run|lhr\.rocks)' }
      'Pinggy' { 'https://[a-z0-9.-]+\.pinggy\.(?:link|io|online)' }
    }
  }
  Write-Host "Connecting invitation transport: $Transport"
  $tunnelProcess = Start-Process `
    -FilePath $tunnelExecutable `
    -ArgumentList $tunnelArguments `
    -WorkingDirectory $shareDir `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $tunnelLog `
    -RedirectStandardError $tunnelError

  $url = $null
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue)) { break }
    foreach ($logPath in @($tunnelLog, $tunnelError)) {
      if (-not (Test-Path -LiteralPath $logPath)) { continue }
      $content = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
      $logText = if ($null -eq $content) { '' } else { [string]$content }
      $match = [regex]::Match($logText, $urlPattern)
      if ($match.Success) { $url = $match.Value; break }
    }
    if ($url) { break }
  }
  if (-not $url) {
    $details = if (Test-Path -LiteralPath $tunnelError) { Get-Content -LiteralPath $tunnelError -Tail 12 | Out-String } else { 'No tunnel logs were created.' }
    throw "$Transport did not return an HTTPS URL. $details"
  }

  # 获得随机域名不代表隧道已经连接。实际读取公网门禁后才显示可用入口。
  Write-Host 'Checking the HTTPS invitation page...'
  $reachable = $false
  $lastFailure = 'No response'
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        # 用独立 Node 进程读取 UTF-8 响应，避免 PowerShell 旧 HTTPS 栈和原生输出管道差异。
        & node (Join-Path $root 'scripts\verify-invite-url.mjs') $url
        $requestSucceeded = $LASTEXITCODE -eq 0
        $pageText = if ($requestSucceeded) { '<form method="post" action="/__invite">' } else { '' }
        $lastFailure = "Invitation verification failed (exit $LASTEXITCODE)"
      } else {
        $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 6
        $pageText = $page.Content
        $requestSucceeded = $page.StatusCode -eq 200
        $lastFailure = "Unexpected response: HTTP $($page.StatusCode)"
      }
      if ($requestSucceeded -and $pageText -match '<form method="post" action="/__invite">') {
        $reachable = $true; break
      }
      if ($attempt -eq 0 -and $requestSucceeded) { Write-Host 'The public page responded, but the invitation form is not present yet.' }
    } catch { $lastFailure = $_.Exception.Message }
    Start-Sleep -Seconds 3
  }
  if (-not $reachable) { throw "An HTTPS URL was allocated, but its invitation page could not be reached ($lastFailure). The tunnel was closed; try a personal hotspot or a server deployment." }

  [PSCustomObject]@{
    gatewayPid = $gatewayProcess.Id
    tunnelPid = $tunnelProcess.Id
    cloudflaredPath = $cloudflared
    gatewayScript = Join-Path $root 'scripts\invite-gateway.mjs'
    url = $url
    code = $code
    issuedAt = [DateTime]::UtcNow.ToString('o')
    transport = $Transport
    tunnelExecutable = $tunnelExecutable
    gatewayPort = $gatewayPort
  } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

  Write-Output "Test URL: $url"
  Write-Output "Access code: $code"
  Write-Output "Stop command: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $root 'scripts\stop-invite-test.ps1')`""
} catch {
  if ($tunnelProcess -and (Get-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $tunnelProcess.Id -Force
  }
  if ($gatewayProcess -and (Get-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $gatewayProcess.Id -Force
  }
  throw
} finally {
  $code = $null
  $bytes = $null
}
