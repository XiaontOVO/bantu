param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $taskRoot
. (Join-Path $taskRoot 'scripts\bantu-process.ps1')
$record = Read-BantuProcessRecord -Path (Join-Path $taskRoot 'data\bantu-server.pid')
if ($record) {
  $managedProcess = Get-BantuProcessById -ProcessId $record.ProcessId
  if ($managedProcess) {
    $fingerprint = Get-BantuBuildFingerprint -Root $taskRoot
    $identity = Get-BantuProcessIdentity -Process $managedProcess -Root $taskRoot
    if ((Get-BantuBuildRecordAction -Record $record -Identity $identity -Root $taskRoot -BuildFingerprint $fingerprint) -eq 'unverified') {
      throw 'The server does not belong to this project. No process or data was changed.'
    }
    $verifiedAgain = Get-BantuProcessById -ProcessId $record.ProcessId
    if (-not $verifiedAgain -or (Get-BantuProcessIdentity -Process $verifiedAgain -Root $taskRoot) -ne 'current') {
      throw 'The project PID changed. No process or data was changed.'
    }
    Stop-Process -Id $record.ProcessId -Force
    for ($attempt = 0; $attempt -lt 30 -and (Get-BantuProcessById -ProcessId $record.ProcessId); $attempt++) { Start-Sleep -Milliseconds 100 }
    if (Get-BantuProcessById -ProcessId $record.ProcessId) { throw 'The managed server did not stop; data was not changed.' }
  }
}
try {
  node scripts/cleanup-feedback-test-data.mjs --apply
  if ($LASTEXITCODE -ne 0) { throw 'Targeted cleanup failed. Check the local log; backup or rollback preserves existing data.' }
} finally {
  & (Join-Path $taskRoot 'scripts\start-windows.ps1') -HostAddress 127.0.0.1 -Port 8787 -NoInstall -NoBrowser
}
