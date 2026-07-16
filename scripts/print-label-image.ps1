<#
.SYNOPSIS
  Print a label bitmap 1:1 (no scaling) to a named Windows printer via GDI.

.DESCRIPTION
  Used by the dashboard's "Print label" feature. The image is expected to be
  pre-rendered to the printer's exact native dot grid (e.g. 640x640 for an
  80 mm label at 203 dpi).   It is drawn with NearestNeighbour interpolation at
  the exact physical media size so every barcode bar maps to a whole printer
  dot — the only way to keep a dense barcode crisp and scannable on a thermal
  head. Resampling/anti-aliasing (what Adobe "Fit" and browsers do) blurs it.

  The print job also pins the page size to the requested WidthMm x HeightMm so
  it never inherits the driver's default stock height. A mismatch there (e.g.
  60 mm labels loaded but the driver still set to 80 mm) prints the label
  top-aligned on an over-tall page, clipping the top and leaving the bottom
  blank.

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

  # Pre-flight readiness check. $doc.Print() only QUEUES the job and reports
  # success even when the printer is offline — the job then piles up in the
  # spooler and nothing physically prints. Refuse loudly instead of lying.
  # Emit to stderr directly (not Write-Error): with ErrorActionPreference='Stop'
  # a Write-Error terminates the script with exit code 1, which would erase the
  # distinct 4/5 codes the Node caller relies on to flag a hardware fault.
  $info = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$Printer'" -ErrorAction SilentlyContinue
  if ($info) {
    if ($info.WorkOffline) {
      [Console]::Error.WriteLine("Printer '$Printer' is OFFLINE. Power it on, reconnect USB, then uncheck 'Use Printer Offline'.")
      exit 4
    }
    $notReady = @{ 4 = 'out of paper/labels'; 7 = 'cover/door open'; 8 = 'paper jammed'; 9 = 'offline' }[[int]$info.DetectedErrorState]
    if ($notReady) {
      [Console]::Error.WriteLine("Printer '$Printer' is not ready: $notReady. Fix it, then print again.")
      exit 5
    }
  }

  $doc.PrinterSettings.Copies = [Math]::Max(1, $Copies)
  $doc.DocumentName = [System.IO.Path]::GetFileNameWithoutExtension($ImagePath)

  # Draw from the physical paper corner (ignore the driver's soft margins) so the
  # bitmap lands exactly on the media. Graphics PageUnit for a printer is
  # 1/100 inch (Display), so widths below are in hundredths of an inch.
  $doc.OriginAtMargins = $false

  $wHi = [int][Math]::Round(($WidthMm  / 25.4) * 100.0)
  $hHi = [int][Math]::Round(($HeightMm / 25.4) * 100.0)

  # CRITICAL: pin the page size to the physical media on every job.
  #
  # Thermal drivers keep a *default* stock size (here the Deli's "USER" custom
  # form is 80 mm tall). If we don't override it, the print engine emits the
  # bitmap onto that default-height page: the label content top-aligns on an
  # 80 mm page while the loaded stock is only 60 mm, so the feed length no
  # longer matches the label gap and the print comes out misregistered — the
  # top gets clipped and the bottom is blank. Setting PaperSize to the exact
  # media makes the page, the feed, and the bitmap all agree.
  #
  # Prefer an existing driver paper size that matches the requested mm (so we
  # inherit a RawKind the driver definitely honours); otherwise define a custom
  # size with RawKind 256 (DMPAPER_USER), the code the driver uses for its own
  # user-defined stock.
  $match = $null
  foreach ($p in $doc.PrinterSettings.PaperSizes) {
    if (([Math]::Abs($p.Width - $wHi) -le 3) -and ([Math]::Abs($p.Height - $hHi) -le 3)) { $match = $p; break }
  }
  if ($match) {
    $paper = $match
  } else {
    $paper = New-Object System.Drawing.Printing.PaperSize('UED-Label', $wHi, $hHi)
    $paper.RawKind = 256
  }
  $doc.DefaultPageSettings.PaperSize = $paper
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins   = New-Object System.Drawing.Printing.Margins 0, 0, 0, 0

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
