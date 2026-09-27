# Shared helper: resolve the system Node.js binary and a PATH that cannot
# pick up Cursor/VS Code's bundled Node 24 (which breaks better-sqlite3).
$ErrorActionPreference = 'SilentlyContinue'

function Get-DashboardNode {
  if ($env:DASHBOARD_NODE -and (Test-Path -LiteralPath $env:DASHBOARD_NODE)) {
    if ($env:DASHBOARD_NODE -notmatch '(?i)[\\/](cursor|vscode)[\\/]') {
      return $env:DASHBOARD_NODE
    }
  }
  $systemNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $systemNode) { return $systemNode }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $cmd -and $cmd.Source -notmatch '(?i)[\\/](cursor|vscode)[\\/]') {
    return $cmd.Source
  }
  return $null
}

function Set-DashboardNodePath {
  $nodeExe = Get-DashboardNode
  if (-not $nodeExe) { return $null }
  $nodeDir = Split-Path -Parent $nodeExe
  $clean = @(
    $nodeDir
    "$env:SystemRoot\System32"
    $env:SystemRoot
    "$env:SystemRoot\System32\Wbem"
    "$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    "$env:SystemRoot\System32\OpenSSH"
    'C:\Program Files\Git\cmd'
  ) | Where-Object { $_ -and (Test-Path $_) }
  $env:Path = ($clean -join ';')
  $env:NODE = $nodeExe
  return $nodeExe
}

function Invoke-DashboardPm2 {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Pm2Args)
  $root = Split-Path -Parent $PSScriptRoot
  $pm2Cmd = Join-Path $root 'node_modules\.bin\pm2.cmd'
  Set-DashboardNodePath | Out-Null
  if (-not (Test-Path -LiteralPath $pm2Cmd)) { return }
  & $pm2Cmd @Pm2Args
}
