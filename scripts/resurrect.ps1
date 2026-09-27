# ------------------------------------------------------------------------------
#  resurrect.ps1 — brings the dashboard back up on login.
#
#  Registered in the Windows Startup folder by install-autostart.ps1 so PM2's
#  saved process list is restored automatically after a reboot / sign-in. Runs
#  hidden (no console flash). Safe to run repeatedly — `pm2 resurrect` is a no-op
#  if the process is already alive.
#
#  Always invokes PM2 through the system Node binary so a leftover Cursor-agent
#  PATH cannot start Node 24 against Node 22 native modules.
# ------------------------------------------------------------------------------
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dashboard-node.ps1')
Set-Location $root

$pm2Cmd = Join-Path $root 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path -LiteralPath $pm2Cmd)) { exit 0 }

Invoke-DashboardPm2 resurrect | Out-Null

$health = 'http://localhost:4000/api/health'
$ready = $false
try {
  $r = Invoke-WebRequest -Uri $health -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
  $ready = ($r.StatusCode -eq 200)
} catch {
  $ready = $false
}
if (-not $ready) {
  Invoke-DashboardPm2 start (Join-Path $root 'ecosystem.config.js') | Out-Null
  Invoke-DashboardPm2 save | Out-Null
}
