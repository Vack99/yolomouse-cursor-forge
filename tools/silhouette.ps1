# Pixel-sample a black-on-white image into an ASCII silhouette.
# Usage: .\tools\silhouette.ps1 <image> [-Cols 32] [-Threshold 128]
param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [int]$Cols = 32,
    [int]$Threshold = 128
)

Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $ImagePath))
$srcW = $bmp.Width
$srcH = $bmp.Height

# Find the bounding box of dark pixels in the source.
$minX = $srcW; $minY = $srcH; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $srcH; $y++) {
    for ($x = 0; $x -lt $srcW; $x++) {
        $px = $bmp.GetPixel($x, $y)
        $lum = ($px.R + $px.G + $px.B) / 3
        if ($lum -lt $Threshold) {
            if ($x -lt $minX) { $minX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}

if ($maxX -lt 0) {
    Write-Output "(no dark pixels found above threshold $Threshold)"
    return
}

$bbW = $maxX - $minX + 1
$bbH = $maxY - $minY + 1
Write-Output "# source: $ImagePath"
Write-Output "# source size: ${srcW}x${srcH}, dark bbox: ${bbW}x${bbH} at ($minX,$minY)"
Write-Output "# downsampled to $Cols cols (rows scaled by aspect ratio)"

# Scale rows so output preserves bbox aspect ratio (square pixels).
$pxPerCell = $bbW / $Cols
$rows = [Math]::Ceiling($bbH / $pxPerCell)

Write-Output "# silhouette: ${Cols}x${rows} cells"
Write-Output ""

for ($r = 0; $r -lt $rows; $r++) {
    $line = ""
    for ($c = 0; $c -lt $Cols; $c++) {
        # Sample center of this cell back in source coordinates.
        $sx = [int]($minX + ($c + 0.5) * $pxPerCell)
        $sy = [int]($minY + ($r + 0.5) * $pxPerCell)
        if ($sx -ge $srcW) { $sx = $srcW - 1 }
        if ($sy -ge $srcH) { $sy = $srcH - 1 }
        $px = $bmp.GetPixel($sx, $sy)
        $lum = ($px.R + $px.G + $px.B) / 3
        $line += $(if ($lum -lt $Threshold) { "#" } else { "." })
    }
    Write-Output $line
}

$bmp.Dispose()
