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
Write-Host '  Removing Etsy Dashboard always-on setup...'
Set-Location $ProjectRoot

# 1. Remove the scheduled task (if created) + Startup-folder launchers
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "  - Scheduled Task '$TaskName' removed (if it existed)"

$startupDir = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startupDir 'EtsyDashboard.vbs') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir 'EtsyDashboard-resurrect.cmd') -ErrorAction SilentlyContinue
Write-Host '  - Startup-folder launcher removed'

# 2. Stop + delete the PM2 app and kill the PM2 daemon
$pm2Cmd = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
if (Test-Path $pm2Cmd) {
  & $pm2Cmd delete etsy-dashboard 2>$null
  & $pm2Cmd save --force 2>$null
  & $pm2Cmd kill 2>$null
  Write-Host '  - PM2 process stopped and daemon shut down'
}

Write-Host ''
Write-Host '  Done. The dashboard will no longer start automatically.'
Write-Host '  (Power/sleep settings were left unchanged - adjust in Windows if desired.)'
Write-Host ''
