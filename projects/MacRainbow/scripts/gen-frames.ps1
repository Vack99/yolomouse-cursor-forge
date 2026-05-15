# MacRainbow frame generator.
#
# Builds the rainbow pointer by RECOLOURING the real Windows pointer rather
# than reconstructing its shape. pointer-base.png is the 128px frame of
# Windows' aero_arrow.cur (white fill, black outline, anti-aliased edges).
#
# For every frame the base image is recoloured pixel-for-pixel:
#   - fully transparent pixels stay transparent
#   - dark pixels (the outline) stay black
#   - light pixels (the fill) become a diagonal rainbow stripe colour
# The source ALPHA is preserved exactly, so the real cursor's anti-aliased
# edges carry straight through — no jaggies, no hand-painted outline.
#
# Output: frames/frame_NN.png at the final canvas size. forge build packs
# PNG frames directly (no .grid.txt for this cursor).
#
# Usage: .\projects\MacRainbow\scripts\gen-frames.ps1

param(
    [int]$Frames = 12,
    [int]$Canvas = 96,        # final cursor canvas (square)
    [int]$StripeWidth = 6,    # rainbow stripe width in final pixels
    [int]$DarkThreshold = 128 # luminance <= this is outline, above is fill
)

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$basePath   = Join-Path $projectRoot 'pointer-base.png'
$palettePath = Join-Path $projectRoot 'palette.txt'
$framesDir  = Join-Path $projectRoot 'frames'

if (-not (Test-Path $basePath))    { Write-Error "Missing $basePath"; exit 1 }
if (-not (Test-Path $palettePath)) { Write-Error "Missing $palettePath"; exit 1 }

# --- Rainbow palette (R,O,Y,G,B,P) from palette.txt ---
$order = 'R','O','Y','G','B','P'
$hex = @{}
foreach ($line in Get-Content $palettePath) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $p = $t -split '\s+', 2
    if ($p.Count -eq 2 -and $p[0].Length -eq 1) { $hex[$p[0]] = $p[1].Trim() }
}
# List[int[]] so each colour stays a 3-element array (a bare foreach would
# unroll the arrays into one flat list of ints).
$rainbow = New-Object 'System.Collections.Generic.List[int[]]'
foreach ($k in $order) {
    if (-not $hex.ContainsKey($k)) { Write-Error "palette.txt missing '$k'"; exit 1 }
    $h = $hex[$k]
    $rainbow.Add([int[]]@(
        [Convert]::ToInt32($h.Substring(0,2),16),
        [Convert]::ToInt32($h.Substring(2,2),16),
        [Convert]::ToInt32($h.Substring(4,2),16)
    ))
}
$period = $order.Count * $StripeWidth
# Shift per frame so the pattern advances exactly one period over $Frames frames
# (seamless loop). period must be divisible by frame count.
if ($period % $Frames -ne 0) {
    Write-Error "period ($period) must be divisible by frame count ($Frames) for a seamless loop"
    exit 1
}
$shift = $period / $Frames

# --- Load base, crop to opaque content, scale to fill the canvas height ---
$src = [System.Drawing.Bitmap]::FromFile($basePath)
$minX=$src.Width;$minY=$src.Height;$maxX=-1;$maxY=-1
for ($y=0;$y -lt $src.Height;$y++){
  for ($x=0;$x -lt $src.Width;$x++){
    if ($src.GetPixel($x,$y).A -gt 8){
      if($x -lt $minX){$minX=$x}; if($y -lt $minY){$minY=$y}
      if($x -gt $maxX){$maxX=$x}; if($y -gt $maxY){$maxY=$y}
    }
  }
}
$cropW = $maxX-$minX+1; $cropH = $maxY-$minY+1
# Scale so the pointer height fills the canvas; width follows aspect.
$scale = $Canvas / $cropH
$dstW = [int][Math]::Round($cropW * $scale)
$dstH = $Canvas

$base = New-Object System.Drawing.Bitmap($Canvas, $Canvas, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($base)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src,
    (New-Object System.Drawing.Rectangle(0, 0, $dstW, $dstH)),
    $minX, $minY, $cropW, $cropH, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()

# --- Read the recoloured-ready base into a byte buffer (BGRA) ---
$rect = New-Object System.Drawing.Rectangle(0, 0, $Canvas, $Canvas)
$bd = $base.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $bd.Stride
$buf = New-Object byte[] ($stride * $Canvas)
[System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
$base.UnlockBits($bd)
$base.Dispose()

# --- Emit frames ---
if (-not (Test-Path $framesDir)) { New-Item -ItemType Directory -Path $framesDir | Out-Null }
Get-ChildItem $framesDir -Filter 'frame_*' | Remove-Item -Force

for ($f = 0; $f -lt $Frames; $f++) {
    $out = New-Object byte[] $buf.Length
    for ($y = 0; $y -lt $Canvas; $y++) {
        $rowBase = $y * $stride
        for ($x = 0; $x -lt $Canvas; $x++) {
            $i = $rowBase + $x * 4
            $a = $buf[$i+3]
            if ($a -eq 0) { continue }   # leave transparent
            $b = $buf[$i]; $gr = $buf[$i+1]; $r = $buf[$i+2]
            $lum = ($r + $gr + $b) / 3
            if ($lum -le $DarkThreshold) {
                # outline -> black, keep alpha
                $out[$i] = 0; $out[$i+1] = 0; $out[$i+2] = 0; $out[$i+3] = $a
            } else {
                # fill -> rainbow stripe colour, keep alpha
                $idx = ((($x + $y) - $f * $shift) % $period + $period) % $period
                $c = $rainbow[[int][Math]::Floor($idx / $StripeWidth)]
                $out[$i] = $c[2]; $out[$i+1] = $c[1]; $out[$i+2] = $c[0]; $out[$i+3] = $a
            }
        }
    }
    $bmp = New-Object System.Drawing.Bitmap($Canvas, $Canvas, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $wb = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    [System.Runtime.InteropServices.Marshal]::Copy($out, 0, $wb.Scan0, $out.Length)
    $bmp.UnlockBits($wb)
    $name = "frame_{0:D2}.png" -f $f
    $bmp.Save((Join-Path $framesDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Write-Output "Generated $Frames PNG frames (${Canvas}x${Canvas}) in $framesDir"
