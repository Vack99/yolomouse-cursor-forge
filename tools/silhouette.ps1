# Pixel-sample an image into an ASCII silhouette.
# Crops to the largest connected filled region (the cursor itself), so screenshot
# borders, watermarks, or other small artifacts don't inflate the bbox.
#
# Two fill modes:
#   dark  (default) - a pixel is filled if its luminance is below -Threshold.
#                     Use for black-on-white screenshots.
#   alpha           - a pixel is filled if its alpha is above -Threshold.
#                     Use for cursor/icon PNGs with a transparent background.
#
# Usage: .\tools\silhouette.ps1 <image> [-Cols 32] [-Mode dark|alpha] [-Threshold N]
param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [int]$Cols = 32,
    [ValidateSet('dark','alpha')][string]$Mode = 'dark',
    [int]$Threshold = -1
)

Add-Type -AssemblyName System.Drawing

# Mode-appropriate default threshold if the caller didn't set one.
if ($Threshold -lt 0) {
    $Threshold = if ($Mode -eq 'alpha') { 16 } else { 128 }
}

$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $ImagePath))
$srcW = $bmp.Width
$srcH = $bmp.Height

# Read all pixels into a filled/empty grid in one pass.
$dark = New-Object 'bool[,]' $srcH, $srcW
for ($y = 0; $y -lt $srcH; $y++) {
    for ($x = 0; $x -lt $srcW; $x++) {
        $px = $bmp.GetPixel($x, $y)
        if ($Mode -eq 'alpha') {
            $dark[$y, $x] = ($px.A -gt $Threshold)
        } else {
            $lum = ($px.R + $px.G + $px.B) / 3
            $dark[$y, $x] = ($lum -lt $Threshold)
        }
    }
}
$bmp.Dispose()

# Flood-fill connected components of dark pixels (4-neighbor adjacency).
# Track the largest one by pixel count and use its bbox as the crop.
$visited = New-Object 'bool[,]' $srcH, $srcW
$bestSize = 0
$bestMinX = 0; $bestMinY = 0; $bestMaxX = -1; $bestMaxY = -1
$queue = New-Object 'System.Collections.Generic.Queue[int[]]'

for ($sy = 0; $sy -lt $srcH; $sy++) {
    for ($sx = 0; $sx -lt $srcW; $sx++) {
        if (-not $dark[$sy, $sx]) { continue }
        if ($visited[$sy, $sx]) { continue }
        $queue.Clear()
        $queue.Enqueue(@($sy, $sx))
        $visited[$sy, $sx] = $true
        $size = 0
        $minX = $srcW; $minY = $srcH; $maxX = -1; $maxY = -1
        while ($queue.Count -gt 0) {
            $cell = $queue.Dequeue()
            $cy = $cell[0]; $cx = $cell[1]
            $size++
            if ($cx -lt $minX) { $minX = $cx }
            if ($cy -lt $minY) { $minY = $cy }
            if ($cx -gt $maxX) { $maxX = $cx }
            if ($cy -gt $maxY) { $maxY = $cy }
            foreach ($d in @(@(-1,0), @(1,0), @(0,-1), @(0,1))) {
                $ny = $cy + $d[0]; $nx = $cx + $d[1]
                if ($ny -lt 0 -or $ny -ge $srcH -or $nx -lt 0 -or $nx -ge $srcW) { continue }
                if ($visited[$ny, $nx]) { continue }
                if (-not $dark[$ny, $nx]) { continue }
                $visited[$ny, $nx] = $true
                $queue.Enqueue(@($ny, $nx))
            }
        }
        if ($size -gt $bestSize) {
            $bestSize = $size
            $bestMinX = $minX; $bestMinY = $minY
            $bestMaxX = $maxX; $bestMaxY = $maxY
        }
    }
}

if ($bestSize -eq 0) {
    Write-Output "(no dark pixels found above threshold $Threshold)"
    return
}

$bbW = $bestMaxX - $bestMinX + 1
$bbH = $bestMaxY - $bestMinY + 1
Write-Output "# source: $ImagePath"
Write-Output "# source size: ${srcW}x${srcH}"
Write-Output "# largest filled component ($Mode mode): ${bbW}x${bbH} at ($bestMinX,$bestMinY), $bestSize px"
Write-Output "# downsampled to $Cols cols (rows scaled to preserve aspect)"

# Scale rows so output preserves bbox aspect ratio (square pixels).
$pxPerCell = $bbW / $Cols
$rows = [Math]::Ceiling($bbH / $pxPerCell)

Write-Output "# silhouette: ${Cols}x${rows} cells"
Write-Output ""

for ($r = 0; $r -lt $rows; $r++) {
    $line = ""
    for ($c = 0; $c -lt $Cols; $c++) {
        # Sample center of this cell back in source coordinates.
        $sx = [int]($bestMinX + ($c + 0.5) * $pxPerCell)
        $sy = [int]($bestMinY + ($r + 0.5) * $pxPerCell)
        if ($sx -ge $srcW) { $sx = $srcW - 1 }
        if ($sy -ge $srcH) { $sy = $srcH - 1 }
        $line += $(if ($dark[$sy, $sx]) { "#" } else { "." })
    }
    Write-Output $line
}
