# ─────────────────────────────────────────────────────────────────────────────
#  Unified Etsy Dashboard — Smart Launcher  (PowerShell 5.1 compatible)
#
#  • If the server is already running  → opens browser immediately
#  • If the server is down             → starts PM2, waits up to 30 s,
#                                        then opens browser
#
#  Called by the Desktop / Start-Menu shortcut.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'SilentlyContinue'

$ProjectRoot  = Split-Path -Parent $PSScriptRoot
$DashboardUrl = 'http://localhost:4000'
$pm2Cmd       = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'

# ── Health check ──────────────────────────────────────────────────────────────
function Test-ServerReady {
  try {
    $r = Invoke-WebRequest -Uri $DashboardUrl -TimeoutSec 3 `
           -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

# ── Start server via PM2 (or bare node as last resort) ────────────────────────
function Start-Server {
  if (Test-Path $pm2Cmd) {
    & $pm2Cmd resurrect 2>$null | Out-Null
    Start-Sleep -Seconds 2
    if (-not (Test-ServerReady)) {
      & $pm2Cmd start (Join-Path $ProjectRoot 'ecosystem.config.js') 2>$null | Out-Null
      & $pm2Cmd save  2>$null | Out-Null
    }
  } else {
    # PM2 not installed — fall back to plain node
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $nodeCmd) {
      Start-Process $nodeCmd.Source `
        -ArgumentList (Join-Path $ProjectRoot 'src\server\index.js') `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
Set-Location $ProjectRoot

# Fast path: already running
if (Test-ServerReady) {
  Start-Process $DashboardUrl
  exit 0
}

# Start it and wait up to 30 seconds
Start-Server

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1000
  if (Test-ServerReady) {
    Start-Process $DashboardUrl
    exit 0
  }
}

# Timed out — open anyway; browser will show a retry message if still loading
Start-Process $DashboardUrl
