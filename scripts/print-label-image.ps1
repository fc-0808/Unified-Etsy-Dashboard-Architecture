<#
.SYNOPSIS
  Print a label bitmap 1:1 (no scaling) to a named Windows printer via GDI.

.DESCRIPTION
  Used by the dashboard's "Print label" feature. The image is expected to be
  pre-rendered to the printer's exact native dot grid (e.g. 639x639 for an
  80 mm square label at 203 dpi). It is drawn with NearestNeighbour
  interpolation at the exact physical media size so every barcode bar maps to a
  whole printer dot - the only way to keep a dense barcode crisp and scannable
  on a thermal head. Resampling/anti-aliasing (what Adobe "Fit" and browsers do)
  blurs it.

  The print job also pins the page size to the requested WidthMm x HeightMm so
  it never inherits an unrelated default stock height. A mismatch there prints
  the label top-aligned on an over-tall page, so the feed length no longer
  matches the label gap: the top is clipped and the bottom comes out blank.

.OUTPUTS
  Diagnostics as "KEY:value" lines, then "PRINTED:<printer>" on success.
  Writes an error and exits non-zero on failure. Exit codes: 2 = printer not
  found, 3 = image not found, 4 = printer offline, 5 = printer not ready.

.NOTES
  Keep this file pure ASCII. Windows PowerShell 5.1 decodes a BOM-less .ps1
  with the system ANSI codepage, so a non-ASCII character inside a string
  literal turns into mojibake that can contain a quote and break parsing -
  the script then fails at load time, on every print. verify-label-print.js
  asserts this.
#>
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$Printer,
  [double]$WidthMm  = 80,
  [double]$HeightMm = 80,
  [int]$Copies      = 1,
  # Print-head resolution in dpi. When the driver advertises a matching
  # resolution we pin the job to it, so the bitmap's dot grid and the device's
  # dot grid are guaranteed to agree. 0 leaves the driver default untouched.
  [int]$Dpi         = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing | Out-Null

# Page geometry is expressed in hundredths of an inch: that is the unit of
# PaperSize/PrintableArea and of a printer Graphics' default PageUnit (Display).
$HUNDREDTHS_PER_MM = 100.0 / 25.4
# Geometry match tolerance, also in hundredths of an inch (3 = 0.76 mm). Driver
# stock dimensions are rounded, so an exact equality test would never hit.
$TOL_HI = 3

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
  # success even when the printer is offline - the job then piles up in the
  # spooler and nothing physically prints. Refuse loudly instead of lying.
  # Emit to stderr directly (not Write-Error): with ErrorActionPreference='Stop'
  # a Write-Error terminates the script with exit code 1, which would erase the
  # distinct 4/5 codes the Node caller relies on to flag a hardware fault.
  # Escape the name for WQL - UNC printer names ("\\host\queue") contain
  # backslashes, which WQL treats as escape characters.
  $wql = $Printer.Replace('\', '\\').Replace("'", "\'")
  $info = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$wql'" -ErrorAction SilentlyContinue
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

  # Leave the origin at the driver's printable-area corner (GDI's native
  # origin) and ignore the soft margins entirely. OriginAtMargins = $true would
  # instead shift the origin by the user margins relative to the physical sheet,
  # which on a thermal printer only pushes the bitmap off the label.
  $doc.OriginAtMargins = $false

  $wHi = [int][Math]::Round($WidthMm  * $HUNDREDTHS_PER_MM)
  $hHi = [int][Math]::Round($HeightMm * $HUNDREDTHS_PER_MM)

  # CRITICAL: make the page the print engine emits agree with the media that is
  # physically loaded, on every job.
  #
  # Thermal drivers keep a *default* stock size. If we don't pin it, the bitmap
  # is emitted onto whatever that default is: the content top-aligns on an
  # over-tall page while the loaded stock is shorter, so the feed length no
  # longer matches the label gap and the print comes out misregistered - the top
  # gets clipped and the bottom is blank.
  #
  # Selection order, most to least trustworthy:
  #   1. The driver's own default stock, when its PRINTABLE area already matches
  #      the requested media. Label drivers routinely describe a stock as wider
  #      than the label itself (the Deli DL-720W's "USER" form is 82.6 mm wide
  #      with an 80.08 mm printable span) because the outer size includes the
  #      unprintable liner edges. Comparing outer sizes would reject the very
  #      form the operator calibrated and replace it with a synthetic DEVMODE
  #      that can shift the print sideways; comparing printable areas keeps it.
  #   2. Any driver stock whose outer size matches, so we inherit a RawKind the
  #      driver definitely honours.
  #   3. A custom size with RawKind 256 (DMPAPER_USER), the code drivers use for
  #      their own user-defined stock.
  $defaultPrintable = $doc.DefaultPageSettings.PrintableArea
  $paper = $null
  $paperSource = ''

  if (([Math]::Abs($defaultPrintable.Width  - $wHi) -le $TOL_HI) -and
      ([Math]::Abs($defaultPrintable.Height - $hHi) -le $TOL_HI)) {
    $paper = $doc.DefaultPageSettings.PaperSize
    $paperSource = 'driver default, printable area matches media'
  }
  if (-not $paper) {
    foreach ($p in $doc.PrinterSettings.PaperSizes) {
      if (([Math]::Abs($p.Width - $wHi) -le $TOL_HI) -and ([Math]::Abs($p.Height - $hHi) -le $TOL_HI)) {
        $paper = $p
        $paperSource = 'driver stock, outer size matches media'
        break
      }
    }
  }
  if (-not $paper) {
    $paper = New-Object System.Drawing.Printing.PaperSize('UED-Label', $wHi, $hHi)
    $paper.RawKind = 256
    $paperSource = 'custom DMPAPER_USER'
  }

  $doc.DefaultPageSettings.PaperSize = $paper
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins   = New-Object System.Drawing.Printing.Margins 0, 0, 0, 0

  # Pin the print-head resolution so the device dot grid matches the grid the
  # bitmap was rendered on. Without this a driver defaulting to "Draft" would
  # resample our 1-bit raster and undo the whole point of the pipeline.
  if ($Dpi -gt 0) {
    foreach ($r in $doc.PrinterSettings.PrinterResolutions) {
      if ($r.X -eq $Dpi -and $r.Y -eq $Dpi) { $doc.DefaultPageSettings.PrinterResolution = $r; break }
    }
  }

  # Re-read the printable area now that the page is pinned: the driver
  # recomputes it from the DEVMODE we just set. Anything the head cannot reach
  # is silently clipped by GDI, so surface it rather than shipping a label with
  # a shaved edge.
  $printable = $doc.DefaultPageSettings.PrintableArea
  $res       = $doc.DefaultPageSettings.PrinterResolution
  Write-Output ("PAPER:{0} {1}x{2}hi [{3}]" -f $paper.PaperName, $paper.Width, $paper.Height, $paperSource)
  Write-Output ("PRINTABLE:{0}x{1}hi at {2},{3}" -f [int]$printable.Width, [int]$printable.Height, [int]$printable.X, [int]$printable.Y)
  Write-Output ("RESOLUTION:{0}x{1}" -f $res.X, $res.Y)
  Write-Output ("MEDIA:{0}x{1}hi ({2}x{3}mm)" -f $wHi, $hHi, $WidthMm, $HeightMm)
  if (($printable.Width -lt ($wHi - $TOL_HI)) -or ($printable.Height -lt ($hHi - $TOL_HI))) {
    Write-Output ("WARN:printable area {0:N1}x{1:N1}mm is smaller than the {2}x{3}mm media - the label edges will be clipped by the printer's unprintable margin." -f `
        ($printable.Width / $HUNDREDTHS_PER_MM), ($printable.Height / $HUNDREDTHS_PER_MM), $WidthMm, $HeightMm)
  }

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
