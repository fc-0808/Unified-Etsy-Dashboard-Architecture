# ------------------------------------------------------------------------------
#  Unified Etsy Dashboard - remove always-on setup
#
#  Stops the PM2-managed dashboard and removes login auto-start.
#  Run from the project root:   npm run auto:uninstall
# ------------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskName    = 'EtsyDashboardAutostart'

Write-Host ''
Write-Host '  Removing Etsy Dashboard always-on setup…'
Set-Location $ProjectRoot

# 1. Remove the scheduled task + all Startup-folder launchers
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "  - Scheduled Task '$TaskName' removed (if it existed)"

$startupDir = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startupDir 'EtsyDashboard.vbs')              -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir 'EtsyDashboard-resurrect.cmd')    -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir 'EtsyDashboard-tray.vbs')         -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir 'EtsyDashboard-tray.lnk')         -ErrorAction SilentlyContinue
Write-Host '  - Startup-folder launchers removed (resurrect + tray)'

# 2. Kill any running tray icon process (the powershell.exe running tray.ps1)
$trayPs1 = Join-Path $ProjectRoot 'scripts\tray.ps1'
Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object {
  try { ($_.MainModule.FileName -like '*powershell*') } catch { $false }
} | ForEach-Object {
  # Only kill the one running our tray script — check command line
  $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($cmdLine -like "*tray.ps1*") {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Host '  - Tray icon process stopped'
  }
}

# 3. Remove Desktop + Start Menu shortcuts
$desktopShortcut   = Join-Path ([Environment]::GetFolderPath('Desktop'))   'Etsy Dashboard.lnk'
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath('StartMenu'))  'Programs\Etsy Dashboard.lnk'

Remove-Item $desktopShortcut   -ErrorAction SilentlyContinue
Remove-Item $startMenuShortcut -ErrorAction SilentlyContinue
Write-Host '  - Desktop and Start Menu shortcuts removed'

# 4. Stop + delete the PM2 app and kill the PM2 daemon
$pm2Cmd = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
if (Test-Path $pm2Cmd) {
  & $pm2Cmd delete etsy-dashboard 2>$null
  & $pm2Cmd save --force 2>$null
  & $pm2Cmd kill 2>$null
  Write-Host '  - PM2 process stopped and daemon shut down'
}

Write-Host ''
Write-Host '  Done. The dashboard will no longer start automatically.'
Write-Host '  (Power/sleep settings were left unchanged — adjust in Windows Settings if desired.)'
Write-Host ''
