# ─────────────────────────────────────────────────────────────────────────────
#  Unified Etsy Dashboard — Windows System Tray Icon
#
#  Runs silently in the background.  The user sees a small orange "E" icon
#  in the taskbar notification area (system tray) at all times.
#
#  Features:
#   • Custom orange icon — instantly recognisable as "Etsy Dashboard"
#   • Icon turns grey when the server is not responding
#   • Context menu:  Open Dashboard | Restart Server | Open Logs |
#                    ─── | Status | ─── | Exit Tray
#   • Double-click the icon to open the dashboard
#   • Balloon tip on startup confirming the server is live
#   • Health-check timer fires every 30 s — icon/menu reflects live status
#
#  Launch:
#    powershell -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass
#               -File scripts\tray.ps1
#
#  This script uses only Windows-built-in .NET assemblies (System.Windows.Forms
#  + System.Drawing) — no extra npm packages are required.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectRoot  = Split-Path -Parent $PSScriptRoot
$DashboardUrl = 'http://localhost:4000'
$pm2Cmd       = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
$LogFile      = Join-Path $ProjectRoot 'data\logs\dashboard-out.log'
$AppName      = 'Etsy Dashboard'

# ── Icon factory (pure GDI+ — no external .ico file required) ────────────────
function New-EtsyIcon {
  param([System.Drawing.Color]$BgColor, [System.Drawing.Color]$FgColor)

  $bmp = New-Object System.Drawing.Bitmap(16, 16)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  # Rounded background
  $bgBrush = New-Object System.Drawing.SolidBrush($BgColor)
  $g.FillRectangle($bgBrush, 0, 0, 16, 16)

  # "E" letter
  $font = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold,
                                          [System.Drawing.GraphicsUnit]::Pixel)
  $fgBrush  = New-Object System.Drawing.SolidBrush($FgColor)
  $strFmt   = New-Object System.Drawing.StringFormat
  $strFmt.Alignment     = [System.Drawing.StringAlignment]::Center
  $strFmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('E', $font, $fgBrush, [System.Drawing.RectangleF]::new(0,0,16,16), $strFmt)

  $g.Dispose()
  $bgBrush.Dispose()
  $fgBrush.Dispose()
  $font.Dispose()

  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$iconRunning = New-EtsyIcon -BgColor ([System.Drawing.Color]::FromArgb(246,130,31)) `
                             -FgColor ([System.Drawing.Color]::White)

$iconStopped = New-EtsyIcon -BgColor ([System.Drawing.Color]::FromArgb(120,120,120)) `
                             -FgColor ([System.Drawing.Color]::White)

# ── Health check ─────────────────────────────────────────────────────────────
$script:IsRunning = $false

function Test-ServerReady {
  try {
    $r = Invoke-WebRequest -Uri $DashboardUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# ── PM2 helpers ───────────────────────────────────────────────────────────────
function Invoke-RestartServer {
  if (Test-Path $pm2Cmd) {
    & $pm2Cmd restart etsy-dashboard 2>$null | Out-Null
  }
}

# ── Build context menu ────────────────────────────────────────────────────────
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# Open Dashboard
$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$miOpen.Text = '⬛  Open Dashboard'
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Start-Process $DashboardUrl })
$contextMenu.Items.Add($miOpen) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Restart Server
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$miRestart.Text = 'Restart Server'
$miRestart.add_Click({
  $script:trayIcon.ShowBalloonTip(2000, $AppName, 'Restarting server…', [System.Windows.Forms.ToolTipIcon]::Info)
  Invoke-RestartServer
})
$contextMenu.Items.Add($miRestart) | Out-Null

# Open Logs
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$miLogs.Text = 'Open Logs'
$miLogs.add_Click({
  if (Test-Path $LogFile) { Start-Process notepad.exe -ArgumentList $LogFile }
  else { [System.Windows.Forms.MessageBox]::Show("Log file not found:`n$LogFile", $AppName) | Out-Null }
})
$contextMenu.Items.Add($miLogs) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Status (read-only label, updated by timer)
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$miStatus.Text    = 'Status: checking…'
$miStatus.Enabled = $false
$contextMenu.Items.Add($miStatus) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Exit Tray
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem
$miExit.Text = 'Exit Tray'
$miExit.add_Click({
  $script:trayIcon.Visible = $false
  $script:trayIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($miExit) | Out-Null

# ── Tray icon ─────────────────────────────────────────────────────────────────
$script:trayIcon                  = New-Object System.Windows.Forms.NotifyIcon
$script:trayIcon.Icon             = $iconStopped
$script:trayIcon.Text             = "$AppName — checking…"
$script:trayIcon.ContextMenuStrip = $contextMenu
$script:trayIcon.Visible          = $true

$script:trayIcon.add_DoubleClick({
  Start-Process $DashboardUrl
})

# ── Health-check timer (every 30 seconds) ─────────────────────────────────────
$timer          = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000

$checkHealth = {
  $wasRunning       = $script:IsRunning
  $script:IsRunning = Test-ServerReady

  if ($script:IsRunning) {
    $script:trayIcon.Icon  = $iconRunning
    $script:trayIcon.Text  = "$AppName — Running ✓  http://localhost:4000"
    $miStatus.Text         = 'Status: ● Running'

    # One-time balloon on transition from stopped → running
    if (-not $wasRunning) {
      $script:trayIcon.ShowBalloonTip(3000, $AppName, 'Server is running — click to open dashboard.', [System.Windows.Forms.ToolTipIcon]::Info)
    }
  } else {
    $script:trayIcon.Icon  = $iconStopped
    $script:trayIcon.Text  = "$AppName — Server offline"
    $miStatus.Text         = 'Status: ○ Offline'

    # Notify once on unexpected shutdown
    if ($wasRunning) {
      $script:trayIcon.ShowBalloonTip(4000, $AppName, 'Server went offline. PM2 will restart it shortly.', [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  }
}

$timer.add_Tick($checkHealth)

# ── Startup: run first check immediately, then start the periodic timer ───────
& $checkHealth
$timer.Start()

# Show an initial balloon tip so the user knows the tray is active
if ($script:IsRunning) {
  $script:trayIcon.ShowBalloonTip(3000, $AppName,
    'Dashboard is running — double-click this icon to open it.',
    [System.Windows.Forms.ToolTipIcon]::Info)
} else {
  $script:trayIcon.ShowBalloonTip(3000, $AppName,
    'Dashboard is starting up — it will be ready in a few seconds.',
    [System.Windows.Forms.ToolTipIcon]::Info)
}

# ── Run the Windows message loop (blocks until Exit is chosen) ────────────────
[System.Windows.Forms.Application]::Run()
