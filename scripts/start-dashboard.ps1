# ─────────────────────────────────────────────────────────────────────────────
#  Unified Etsy Dashboard — Smart Launcher  (PowerShell 5.1 compatible)
#
#  • If the server is already running  → opens browser immediately
#  • If the server is down             → starts PM2 with the system Node,
#                                        waits up to 30 s, then opens browser
#  • If startup fails                  → shows the real error (does not open
#                                        a dead localhost tab)
#
#  Called by the Desktop / Start-Menu shortcut.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'SilentlyContinue'

$ProjectRoot  = Split-Path -Parent $PSScriptRoot
$DashboardUrl = 'http://localhost:4000'
$HealthUrl    = 'http://localhost:4000/api/health'
. (Join-Path $PSScriptRoot 'dashboard-node.ps1')

# ── Health check ──────────────────────────────────────────────────────────────
function Test-ServerReady {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 `
           -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true')
  } catch {
    return $false
  }
}

function Show-StartFailure {
  $errLog = Join-Path $ProjectRoot 'data\logs\dashboard-err.log'
  $detail = 'The dashboard process did not start, so nothing is listening on localhost:4000.'
  if (Test-Path -LiteralPath $errLog) {
    $tail = Get-Content -LiteralPath $errLog -Tail 80 | Out-String
    if ($tail -match 'NODE_MODULE_VERSION') {
      $detail = "The dashboard crashed because it was started with the wrong Node.js version.`n`nNative modules (better-sqlite3) were built for the system Node install. Use the Etsy Dashboard shortcut, not an editor-bundled Node."
    } elseif ($tail -match 'Config error:\s*(.+)') {
      $detail = "Config error: $($Matches[1].Trim())"
    } elseif ($tail -match '\[fatal\]\s*(.+)') {
      $detail = $Matches[1].Trim()
    }
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($detail, 'Etsy Dashboard', 'OK', 'Error') | Out-Null
  } catch {
    Write-Host $detail
  }
}

# ── Start server via PM2 (or bare system node as last resort) ─────────────────
function Start-Server {
  $pm2Cmd = Join-Path $ProjectRoot 'node_modules\.bin\pm2.cmd'
  if (Test-Path -LiteralPath $pm2Cmd) {
    Invoke-DashboardPm2 delete etsy-dashboard | Out-Null
    Invoke-DashboardPm2 delete etsy-funnel-watchdog | Out-Null
    Invoke-DashboardPm2 start (Join-Path $ProjectRoot 'ecosystem.config.js') | Out-Null
    Invoke-DashboardPm2 save | Out-Null
    return
  }
  $nodeCmd = Get-DashboardNode
  if ($null -ne $nodeCmd) {
    Start-Process $nodeCmd `
      -ArgumentList (Join-Path $ProjectRoot 'src\server\index.js') `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden
  }
}

# ─────────────────────────────────────────────────────────────────────────────
Set-Location $ProjectRoot
Set-DashboardNodePath | Out-Null

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

Show-StartFailure
exit 1
