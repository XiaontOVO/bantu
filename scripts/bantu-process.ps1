function Read-BantuProcessRecord {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $content = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $content) { return $null }

  $legacyProcessId = 0
  if ([int]::TryParse($content, [ref]$legacyProcessId) -and $legacyProcessId -gt 0) {
    return [pscustomobject]@{
      Version = 0
      ProcessId = $legacyProcessId
      Port = $null
      Root = $null
    }
  }

  try {
    $record = $content | ConvertFrom-Json -ErrorAction Stop
    $processId = [int]$record.processId
    $port = [int]$record.port
    $recordRoot = [string]$record.root
    $buildFingerprint = [string]$record.buildFingerprint
    if ($processId -le 0 -or $port -lt 1 -or $port -gt 65535 -or -not $recordRoot) { return $null }
    if ($buildFingerprint -and $buildFingerprint -notmatch '^[a-f0-9]{64}$') { return $null }
    return [pscustomobject]@{
      Version = [int]$record.version
      ProcessId = $processId
      Port = $port
      Root = $recordRoot
      BuildFingerprint = $buildFingerprint
    }
  } catch {
    return $null
  }
}

function Write-BantuProcessRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BuildFingerprint
  )

  $record = [pscustomobject]@{
    version = 2
    processId = $ProcessId
    port = $Port
    root = [System.IO.Path]::GetFullPath($Root)
    buildFingerprint = $BuildFingerprint
  }
  Set-Content -LiteralPath $Path -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
}

function Get-BantuBuildFingerprint {
  param([Parameter(Mandatory = $true)][string]$Root)

  $sourceRoot = Join-Path $Root 'dist\src'
  $files = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.js' -File -Recurse -ErrorAction Stop |
    Sort-Object { $_.FullName.Substring($sourceRoot.Length).ToLowerInvariant() })
  if ($files.Count -eq 0) { throw "No compiled server files were found under $sourceRoot. Build the project before starting it." }

  $entries = foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($sourceRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $fileHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relativePath`:$fileHash"
  }
  $manifest = [System.String]::Join("`n", [string[]]$entries)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($manifest)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-BantuBuildRecordAction {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$Identity,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$BuildFingerprint
  )

  $rootMatches = $false
  if ($Record.Root) {
    try {
      $rootMatches = [System.IO.Path]::GetFullPath($Record.Root).Equals(
        [System.IO.Path]::GetFullPath($Root), [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      $rootMatches = $false
    }
  }

  # A matching PID number alone is never enough to stop a process. Require both
  # the managed record's project root and an absolute command-line identity.
  if ($Identity -ne 'current' -or -not $rootMatches) { return 'unverified' }
  if ($Record.BuildFingerprint -and $Record.BuildFingerprint -eq $BuildFingerprint) { return 'current' }
  return 'stale'
}

function Get-BantuProcessById {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-BantuProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$Root
  )

  if ($Process.Name -ine 'node.exe') { return 'other' }
  $commandLine = [string]$Process.CommandLine
  $entrypoint = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist\src\server\main.js'))
  if ($commandLine.IndexOf($entrypoint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return 'current'
  }
  if ($commandLine -match '(?i)(?:^|\s)["'']?dist[/\\]src[/\\]server[/\\]main\.js(?:["'']|\s|$)') {
    return 'legacy'
  }
  return 'other'
}

function Get-BantuListenerPorts {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$FallbackPort = 8787
  )

  $ports = @()
  $querySucceeded = $false
  try {
    $connections = @(Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction Stop)
    $querySucceeded = $true
    $ports += @($connections | ForEach-Object { [int]$_.LocalPort })
  } catch {
    # Older Windows builds may not expose Get-NetTCPConnection; the default port remains a fallback.
  }
  if (-not $querySucceeded -and $FallbackPort -ge 1 -and $FallbackPort -le 65535) { $ports += $FallbackPort }
  return @($ports | Where-Object { $_ -ge 1 -and $_ -le 65535 } | Sort-Object -Unique)
}

function Test-BantuHealth {
  param([Parameter(Mandatory = $true)][int]$Port)

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 2
    return ($health.data.status -eq 'ok' -and @('sqlite', 'in-memory') -contains [string]$health.data.service)
  } catch {
    return $false
  }
}

function Show-BantuLanAccess {
  param([string]$Root, [int]$ProcessId, [int]$Port)
  $path = Join-Path $Root 'data\lan-access.json'
  if (-not (Test-Path -LiteralPath $path)) { return }
  try { $access = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
  if ([int]$access.processId -ne $ProcessId -or [int]$access.port -ne $Port) { return }
  if (-not $access.enabled -or [string]$access.host -in @('127.0.0.1', 'localhost', '::1')) {
    Write-Host 'LAN test: closed; local access remains available.'
    return
  }
  $addresses = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and $_ -notmatch '^(127\.|169\.254\.)' } | Sort-Object -Unique)
  Write-Host ''
  Write-Host 'LAN listener is ready; access from another device has not been verified.'
  Write-Host 'Devices must use the same network. Campus/guest Wi-Fi may isolate devices.'
  foreach ($address in $addresses) { Write-Host "Test address: http://${address}:$Port/" }
  if (-not $addresses) { Write-Host 'No active LAN address was found; check the Wi-Fi or Ethernet connection.' }
  Write-Host "Invitation code: $($access.code)"
  Write-Host 'Opening a new LAN test invalidates the previous code and access cookies.'
  Write-Host 'Close LAN access: scripts\stop-lan-test.ps1 (keeps the local app running).'
  Write-Host 'If LAN access times out: use a personal hotspot, or scripts\start-invite-test.ps1 for an HTTPS invitation.'
}
