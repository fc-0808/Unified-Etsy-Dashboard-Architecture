# ------------------------------------------------------------------------------
#  Unified Etsy Dashboard - Windows always-on installer
#
#  Sets up the dashboard (with embedded order-sync + auto-restock) to run 24/7:
#    1. Installs PM2 locally if needed
#    2. Starts the dashboard under PM2 and saves the process list
#    3. Registers login auto-start (Startup folder; Scheduled Task if admin)
#    4. Prevents the PC from sleeping on AC power (so overnight syncs run)
#    5. Creates Desktop + Start Menu shortcuts (double-click to open dashboard)
#    6. Installs the system tray icon into the Startup folder (orange E in tray)
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
Write-Host '  Etsy Dashboard - Always-On Setup  (v2)'
Write-Host '============================================================'
Write-Host "  Project: $ProjectRoot"
Write-Host ''

Set-Location $ProjectRoot

# -- 1. Ensure PM2 is installed locally -----------------------------------------
$pm2Cmd = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path $pm2Cmd)) {
  Write-Host '  [1/6] Installing PM2 (one-time)...'
  npm install pm2 --save-dev --no-audit --no-fund
} else {
  Write-Host '  [1/6] PM2 already installed.'
}

# -- 2. Start (or cleanly restart) under PM2 ------------------------------------
Write-Host '  [2/6] Starting dashboard under PM2...'

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
Write-Host '  [3/6] Registering login auto-start...'

$startupDir  = [Environment]::GetFolderPath('Startup')
$psExeEarly  = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$resurrectPs = Join-Path $ProjectRoot 'scripts\resurrect.ps1'

# A hidden .lnk to resurrect.ps1 restores the PM2 dashboard on every sign-in.
# (Using a .lnk — not a .cmd/.vbs — so it is not swept up by the legacy cleanup
#  in step 5, and shows no console flash.)
$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startupDir 'EtsyDashboard-resurrect.lnk'))
$lnk.TargetPath       = $psExeEarly
$lnk.Arguments        = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$resurrectPs`""
$lnk.WorkingDirectory = $ProjectRoot
$lnk.Description      = 'Restores the Etsy Dashboard (PM2) on login.'
$lnk.WindowStyle      = 7
$lnk.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null

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
Write-Host '  [4/6] Disabling sleep on AC power...'
try {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  Write-Host '        Sleep/hibernate on AC disabled.'
} catch {
  Write-Host '        Could not change power settings (non-fatal).'
}

# -- 5. Desktop + Start Menu shortcuts ----------------------------------------
Write-Host '  [5/6] Creating Desktop and Start Menu shortcuts...'

$desktopDir   = [Environment]::GetFolderPath('Desktop')
$startMenuDir = [Environment]::GetFolderPath('StartMenu') + '\Programs'
$startupDir2  = [Environment]::GetFolderPath('Startup')
$psLaunch     = Join-Path $ProjectRoot 'scripts\start-dashboard.ps1'
$psTray       = Join-Path $ProjectRoot 'scripts\tray.ps1'
$psExe        = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

# shell32.dll icon index 13 = Internet/Globe — clean, no external .ico needed.
$iconSpec = 'C:\Windows\System32\shell32.dll,13'

# VBScript is deprecated in Windows 11 24H2+.  Target powershell.exe directly.
# WindowStyle 7 (minimised) on the .lnk suppresses any brief console flash.
function New-PsShortcut2 {
  param([string]$DestLnk, [string]$Ps1, [string]$WorkDir, [string]$Desc, [string]$Icon)
  $ws  = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($DestLnk)
  $lnk.TargetPath       = $psExe
  $lnk.Arguments        = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$Ps1`""
  $lnk.WorkingDirectory = $WorkDir
  $lnk.Description      = $Desc
  $lnk.IconLocation     = $Icon
  $lnk.WindowStyle      = 7
  $lnk.Save()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null
}

# Remove any legacy .vbs entries left from older installs
Remove-Item (Join-Path $startupDir2 'EtsyDashboard-tray.vbs')     -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir2 'EtsyDashboard.vbs')           -ErrorAction SilentlyContinue
Remove-Item (Join-Path $startupDir2 'EtsyDashboard-resurrect.cmd') -ErrorAction SilentlyContinue

New-PsShortcut2 `
  -DestLnk (Join-Path $desktopDir   'Etsy Dashboard.lnk') `
  -Ps1     $psLaunch `
  -WorkDir $ProjectRoot `
  -Desc    'Open Unified Etsy Dashboard (starts server if needed)' `
  -Icon    $iconSpec

New-PsShortcut2 `
  -DestLnk (Join-Path $startMenuDir 'Etsy Dashboard.lnk') `
  -Ps1     $psLaunch `
  -WorkDir $ProjectRoot `
  -Desc    'Open Unified Etsy Dashboard (starts server if needed)' `
  -Icon    $iconSpec

Write-Host '        Desktop shortcut and Start Menu entry created.'

# -- 6. Install system tray icon into Startup folder --------------------------
Write-Host '  [6/6] Installing system tray icon (orange E in notification area)...'

New-PsShortcut2 `
  -DestLnk (Join-Path $startupDir2 'EtsyDashboard-tray.lnk') `
  -Ps1     $psTray `
  -WorkDir $ProjectRoot `
  -Desc    'Etsy Dashboard system tray icon' `
  -Icon    $iconSpec

# Also launch the tray icon right now (without waiting for next login).
Start-Process $psExe `
  -ArgumentList "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$psTray`"" `
  -WindowStyle Hidden

Write-Host '        Tray icon started and registered for auto-start on login.'

Write-Host ''
Write-Host '------------------------------------------------------------'
Write-Host '  DONE. The dashboard now runs fully automatically.'
Write-Host ''
Write-Host '  Open:          Double-click "Etsy Dashboard" on your Desktop'
Write-Host '                 -OR-  http://localhost:4000'
Write-Host '  Tray icon:     Orange "E" in the notification area (bottom-right)'
Write-Host '                 Double-click it to open the dashboard at any time.'
Write-Host ''
Write-Host '  Status:        npm run auto:status'
Write-Host '  Live logs:     npm run auto:logs'
Write-Host '  Stop:          npm run auto:stop'
Write-Host '  Remove:        npm run auto:uninstall'
Write-Host ''
Write-Host '  The server resurrects on every login and restarts itself on crash.'
Write-Host '  For PROXIED shops keep VPN + IPFoxy connected; the direct shop'
Write-Host '  always works. Keep the PC powered on for overnight syncing.'
Write-Host '------------------------------------------------------------'
Write-Host ''
