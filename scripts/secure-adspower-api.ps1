param(
    [ValidateRange(1, 65535)]
    [int]$Port = 50325,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = 'UnifiedEtsyDashboard-Block-AdsPower-LocalAPI'
$displayName = 'Unified Etsy Dashboard - Block remote AdsPower Local API'

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this command from an Administrator PowerShell window.'
}

if (-not $Remove -and -not $PSBoundParameters.ContainsKey('Port')) {
    $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
    if (Test-Path $envPath) {
        $line = Get-Content $envPath | Where-Object {
            $_ -match '^\s*ADSPOWER_LOCAL_API_URL\s*='
        } | Select-Object -Last 1
        if ($line) {
            $rawUrl = ($line -replace '^\s*ADSPOWER_LOCAL_API_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
            try {
                $uri = [Uri]$rawUrl
                if (
                    $uri.Scheme -ne 'http' -or
                    $uri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
                    $uri.Port -lt 1 -or
                    $uri.Port -gt 65535
                ) {
                    throw 'not a loopback HTTP endpoint'
                }
                $Port = $uri.Port
            } catch {
                throw "Invalid ADSPOWER_LOCAL_API_URL in .env: $($_.Exception.Message)"
            }
        }
    }
}

$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue

if ($Remove) {
    if ($existing) {
        Remove-NetFirewallRule -Name $ruleName
        Write-Host "Removed firewall rule: $displayName"
    } else {
        Write-Host "Firewall rule is already absent: $displayName"
    }
    exit 0
}

if ($existing) {
    $portFilter = $existing | Get-NetFirewallPortFilter
    if (
        $portFilter.Protocol -ne 6 -or
        [string]$portFilter.LocalPort -ne [string]$Port
    ) {
        Remove-NetFirewallRule -Name $ruleName
        $existing = $null
    }
}

if (-not $existing) {
    New-NetFirewallRule `
        -Name $ruleName `
        -DisplayName $displayName `
        -Description 'Blocks non-loopback access to the AdsPower Local API. Windows loopback traffic remains available.' `
        -Direction Inbound `
        -Action Block `
        -Protocol TCP `
        -LocalPort $Port `
        -Profile Any `
        -RemoteAddress Any | Out-Null
} else {
    Set-NetFirewallRule `
        -Name $ruleName `
        -Enabled True `
        -Direction Inbound `
        -Action Block `
        -Profile Any | Out-Null
}

Write-Host "Secured AdsPower Local API TCP port $Port against remote inbound access."
Write-Host 'Loopback verification: npm run browser:verify'
Write-Host 'Remove only if deliberately required: npm run browser:unsecure-api'
