$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $root 'start-bantu.cmd'
if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
$shell = New-Object -ComObject WScript.Shell

function New-BantuShortcut([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Force }
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = 'Bantu - Smart Travel Companion'
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
  $shortcut.Save()
}

$localShortcut = Join-Path $root 'Bantu.lnk'
New-BantuShortcut $localShortcut
Write-Host ('Created: ' + $localShortcut)

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($target in @((Join-Path $desktop 'Bantu.lnk'), (Join-Path $startMenu 'Bantu.lnk'))) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    New-BantuShortcut $target
    Write-Host ('Created: ' + $target)
  } catch {
    Write-Host ('Skipped (permission denied): ' + $target)
  }
}
