$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($target in @((Join-Path $root 'Bantu.lnk'), (Join-Path $desktop 'Bantu.lnk'), (Join-Path $startMenu 'Bantu.lnk'))) {
  if (Test-Path $target) {
    Remove-Item $target -Force
    Write-Host ('Removed: ' + $target)
  }
}
Write-Host 'Shortcut removal complete.'
