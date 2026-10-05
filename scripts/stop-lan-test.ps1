param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-windows.ps1') -Port $Port -HostAddress '127.0.0.1' -Restart -NoBrowser -NoInstall
if ($LASTEXITCODE -ne 0) { throw 'LAN access could not be closed. See the startup error above.' }
