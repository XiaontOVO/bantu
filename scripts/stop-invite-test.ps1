$ErrorActionPreference = 'Stop'
$shareDir = Join-Path $env:TEMP 'bantu-share'
$metadataPath = Join-Path $shareDir 'processes.json'
if (-not (Test-Path -LiteralPath $metadataPath)) {
  Write-Host 'No invite-test process record was found.'
  exit 0
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json

function Stop-OwnedProcess([int]$ProcessId, [string]$ExpectedCommandPattern, [string]$Label) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $processInfo) {
    Write-Host "$Label has already stopped."
    return $true
  }
  if ($processInfo.CommandLine -notmatch $ExpectedCommandPattern) {
    Write-Warning "$Label does not match the recorded process. PID $ProcessId was left running."
    return $false
  }
  Stop-Process -Id $ProcessId -Force
  Write-Host "$Label stopped."
  return $true
}

$gatewayPattern = [regex]::Escape([string]$metadata.gatewayScript) + '(?:"|\s|$)'
$tunnelPath = if ($metadata.tunnelExecutable) { [string]$metadata.tunnelExecutable } else { [string]$metadata.cloudflaredPath }
$tunnelPattern = [regex]::Escape($tunnelPath) + '.*127\.0\.0\.1:8788'
$tunnelStopped = Stop-OwnedProcess -ProcessId ([int]$metadata.tunnelPid) -ExpectedCommandPattern $tunnelPattern -Label 'Invitation tunnel'
$gatewayStopped = Stop-OwnedProcess -ProcessId ([int]$metadata.gatewayPid) -ExpectedCommandPattern $gatewayPattern -Label 'Invite gateway'
if ($tunnelStopped -and $gatewayStopped) {
  Remove-Item -LiteralPath $metadataPath -Force
} else {
  Write-Warning 'The process record was kept because a process was left running.'
}
