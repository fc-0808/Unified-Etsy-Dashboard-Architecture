<#
.SYNOPSIS
  Print a label bitmap 1:1 (no scaling) to a named Windows printer via GDI.

.DESCRIPTION
  Used by the dashboard's "Print label" feature. The image is expected to be
  pre-rendered to the printer's exact native dot grid (e.g. 640x640 for an
  80 mm label at 203 dpi). It is drawn with NearestNeighbour interpolation at
  the exact physical media size so every barcode bar maps to a whole printer
  dot — the only way to keep a dense barcode crisp and scannable on a thermal
  head. Resampling/anti-aliasing (what Adobe "Fit" and browsers do) blurs it.

.OUTPUTS
  Prints "PRINTED:<printer>" to stdout on success; writes an error and exits
  non-zero on failure.
#>
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$Printer,
  [double]$WidthMm  = 80,
  [double]$HeightMm = 80,
  [int]$Copies      = 1
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing | Out-Null

if (-not (Test-Path -LiteralPath $ImagePath)) {
  Write-Error "Image not found: $ImagePath"
  exit 3
}

$img = [System.Drawing.Image]::FromFile($ImagePath)
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $Printer
  if (-not $doc.PrinterSettings.IsValid) {
    Write-Error "Printer not found or invalid: '$Printer'"
    exit 2
  }
  $doc.PrinterSettings.Copies = [Math]::Max(1, $Copies)
  $doc.DocumentName = [System.IO.Path]::GetFileNameWithoutExtension($ImagePath)

  # Draw from the physical paper corner (ignore the driver's soft margins) so the
  # bitmap lands exactly on the media. Graphics PageUnit for a printer is
  # 1/100 inch (Display), so widths below are in hundredths of an inch.
  $doc.OriginAtMargins = $false

  $wHi = [int][Math]::Round(($WidthMm  / 25.4) * 100.0)
  $hHi = [int][Math]::Round(($HeightMm / 25.4) * 100.0)

  $onPrintPage = {
    param($s, $e)
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $rect = New-Object System.Drawing.Rectangle 0, 0, $wHi, $hHi
    $g.DrawImage($img, $rect)
    $e.HasMorePages = $false
  }

  $doc.add_PrintPage($onPrintPage)
  $doc.Print()
  Write-Output "PRINTED:$Printer"
}
finally {
  $img.Dispose()
}
