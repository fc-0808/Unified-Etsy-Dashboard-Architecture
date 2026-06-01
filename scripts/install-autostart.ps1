# ------------------------------------------------------------------------------
#  Unified Etsy Dashboard - Windows always-on installer
#
#  Sets up the dashboard (with embedded order-sync + auto-restock) to run 24/7:
#    1. Installs PM2 locally if needed
#    2. Starts the dashboard under PM2 and saves the process list
#    3. Registers login auto-start (Startup folder; Scheduled Task if admin)
#    4. Prevents the PC from sleeping on AC power (so overnight syncs run)
#
#  Run from the project root:   npm run auto:install
#  Undo with:                   npm run auto:uninstall
#
#  No administrator rights required - everything is per-user.
# ------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskName    = 'EtsyDashboardAutostart'

Write-Host ''
Write-Host '============================================================'
Write-Host '  Etsy Dashboard - Always-On Setup'
Write-Host '============================================================'
Write-Host "  Project: $ProjectRoot"
Write-Host ''

Set-Location $ProjectRoot

# -- 1. Ensure PM2 is installed locally -----------------------------------------
$pm2Cmd = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path $pm2Cmd)) {
  Write-Host '  [1/4] Installing PM2 (one-time)...'
  npm install pm2 --save-dev --no-audit --no-fund
} else {
  Write-Host '  [1/4] PM2 already installed.'
}

# -- 2. Start (or cleanly restart) under PM2 ------------------------------------
Write-Host '  [2/4] Starting dashboard under PM2...'

# Remove any stale PM2 entry first so re-running this installer is idempotent.
& $pm2Cmd delete etsy-dashboard 2>$null | Out-Null

# Kill any leftover FOREGROUND server still holding port 4000 (e.g. a stray `npm start`).
$conns = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

& $pm2Cmd start (Join-Path $ProjectRoot 'ecosystem.config.js')
& $pm2Cmd save
Write-Host '        Dashboard is running under PM2.'

# -- 3. Register login auto-start (Startup folder, no admin needed) -------------
Write-Host '  [3/4] Registering login auto-start...'

$startupDir = [Environment]::GetFolderPath('Startup')
$cmdPath    = Join-Path $startupDir 'EtsyDashboard-resurrect.cmd'
$vbsPath    = Join-Path $startupDir 'EtsyDashboard.vbs'

$cmdBody = "@echo off`r`ncd /d `"$ProjectRoot`"`r`ncall `"$pm2Cmd`" resurrect`r`n"
Set-Content -Path $cmdPath -Value $cmdBody -Encoding ASCII

$vbsBody = "Set sh = CreateObject(`"WScript.Shell`")`r`nsh.Run `"`"`"$cmdPath`"`"`", 0, False`r`n"
Set-Content -Path $vbsPath -Value $vbsBody -Encoding ASCII

# Also try a Scheduled Task (adds restart-on-failure). Non-fatal if admin required.
$taskOk = $false
try {
  $resurrectCmd = "Set-Location '$ProjectRoot'; & '$pm2Cmd' resurrect"
  $encoded      = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($resurrectCmd))
  $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden -NonInteractive -EncodedCommand $encoded"
  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -ErrorAction Stop -Description 'Resurrects the Etsy Dashboard (PM2) on login.' | Out-Null
  $taskOk = $true
} catch {
  $taskOk = $false
}
if ($taskOk) {
  Write-Host '        Startup launcher + Scheduled Task registered.'
} else {
  Write-Host '        Startup launcher registered (Scheduled Task skipped - needs admin).'
}

# -- 4. Keep the PC awake on AC power so overnight syncs run --------------------
Write-Host '  [4/4] Disabling sleep on AC power...'
try {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  Write-Host '        Sleep/hibernate on AC disabled.'
} catch {
  Write-Host '        Could not change power settings (non-fatal).'
}

Write-Host ''
Write-Host '------------------------------------------------------------'
Write-Host '  DONE. The dashboard now runs automatically.'
Write-Host ''
Write-Host '  Open:        http://localhost:4000'
Write-Host '  Status:      npm run auto:status'
Write-Host '  Live logs:   npm run auto:logs'
Write-Host '  Stop:        npm run auto:stop'
Write-Host '  Remove:      npm run auto:uninstall'
Write-Host ''
Write-Host '  It resurrects on every login and restarts itself if it crashes.'
Write-Host '  For PROXIED shops keep VPN + IPFoxy connected; the direct shop'
Write-Host '  always works. Keep the PC powered on for overnight syncing.'
Write-Host '------------------------------------------------------------'
Write-Host ''
