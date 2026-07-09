# ------------------------------------------------------------------------------
#  resurrect.ps1 — brings the dashboard back up on login.
#
#  Registered in the Windows Startup folder by install-autostart.ps1 so PM2's
#  saved process list is restored automatically after a reboot / sign-in. Runs
#  hidden (no console flash). Safe to run repeatedly — `pm2 resurrect` is a no-op
#  if the process is already alive.
# ------------------------------------------------------------------------------
$ErrorActionPreference = 'SilentlyContinue'
$root   = Split-Path -Parent $PSScriptRoot
$pm2Cmd = Join-Path $root 'node_modules\.bin\pm2.cmd'
Set-Location $root
if (Test-Path $pm2Cmd) {
  & $pm2Cmd resurrect
}
