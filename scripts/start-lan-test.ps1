param([int]$Port = 8787, [switch]$NoInstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\start-windows.ps1'),
  '-Port', "$Port", '-HostAddress', '0.0.0.0', '-NewAccessCode', '-NoBrowser')
if ($NoInstall) { $arguments += '-NoInstall' }
& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) { throw 'The LAN test could not be opened. See the startup error above.' }
$access = Get-Content -LiteralPath (Join-Path $root 'data\lan-access.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $access.enabled -or $access.host -ne '0.0.0.0' -or $access.port -ne $Port -or -not $access.code) {
  throw 'The server did not record a current LAN invitation. No test address was confirmed.'
}
