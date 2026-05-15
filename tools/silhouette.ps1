# Pixel-sample a black-on-white image into an ASCII silhouette.
# Crops to the largest connected dark region (the cursor itself), so screenshot
# borders, watermarks, or other small dark artifacts don't inflate the bbox.
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

# Read all pixels into a dark/light grid in one pass.
$dark = New-Object 'bool[,]' $srcH, $srcW
for ($y = 0; $y -lt $srcH; $y++) {
    for ($x = 0; $x -lt $srcW; $x++) {
        $px = $bmp.GetPixel($x, $y)
        $lum = ($px.R + $px.G + $px.B) / 3
        $dark[$y, $x] = ($lum -lt $Threshold)
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
Write-Output "# largest dark component: ${bbW}x${bbH} at ($bestMinX,$bestMinY), $bestSize px"
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
