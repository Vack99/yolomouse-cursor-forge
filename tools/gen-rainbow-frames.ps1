# Generate rainbow-stripe animation frames from a silhouette mask.
# - Reads mask.txt (a project file with `.` for transparent and `#` for filled).
# - Marks every filled cell with at least one transparent 4-neighbor as W (outline).
# - Marks strictly-interior filled cells with a rainbow palette letter using
#   the formula: palette[(((x + y) - frame) mod period) / stripeWidth]
# - Writes frame_NN.grid.txt files into projects/<Name>/frames/.
#
# Usage: .\tools\gen-rainbow-frames.ps1 -ProjectName MacRainbow

param(
    [Parameter(Mandatory=$true)][string]$ProjectName,
    [int]$Frames = 12,
    [int]$Delay = 6,
    [string[]]$Palette = @('R','O','Y','G','B','P'),
    [int]$StripeWidth = 2
)

$projectRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "projects\$ProjectName"
$maskPath = Join-Path $projectRoot 'mask.txt'
$framesDir = Join-Path $projectRoot 'frames'

if (-not (Test-Path $maskPath)) {
    Write-Error "Mask file not found: $maskPath"
    exit 1
}

# Parse mask: extract headers and grid rows.
$maskLines = Get-Content $maskPath
$size = $null; $hotspot = $null
$grid = @()
foreach ($line in $maskLines) {
    if ($line -match '^\s*#\s*size\s+(\d+)x(\d+)') {
        $size = @{ W = [int]$Matches[1]; H = [int]$Matches[2] }
    } elseif ($line -match '^\s*#\s*hotspot\s+(\d+)\s*,\s*(\d+)') {
        $hotspot = "$($Matches[1]),$($Matches[2])"
    } elseif ($line -match '^\s*#') {
        # comment, skip
    } elseif ($line.Length -gt 0) {
        $grid += $line
    }
}

if (-not $size) { Write-Error "Mask missing '# size WxH' header"; exit 1 }
$W = $size.W; $H = $size.H
if ($grid.Count -ne $H) { Write-Error "Mask has $($grid.Count) rows, expected $H"; exit 1 }

# Build a 2D fill array.
$filled = New-Object 'bool[,]' $H, $W
for ($y = 0; $y -lt $H; $y++) {
    $row = $grid[$y]
    if ($row.Length -ne $W) { Write-Error "Row $y has length $($row.Length), expected $W"; exit 1 }
    for ($x = 0; $x -lt $W; $x++) {
        $filled[$y, $x] = ($row[$x] -ne '.')
    }
}

# Classify each filled cell as OUTLINE (touches transparent 4-neighbor) or INTERIOR.
$isOutline = New-Object 'bool[,]' $H, $W
for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
        if (-not $filled[$y, $x]) { continue }
        $border = $false
        foreach ($d in @(@(0,-1), @(0,1), @(-1,0), @(1,0))) {
            $ny = $y + $d[0]; $nx = $x + $d[1]
            if ($ny -lt 0 -or $ny -ge $H -or $nx -lt 0 -or $nx -ge $W) {
                $border = $true; break
            }
            if (-not $filled[$ny, $nx]) { $border = $true; break }
        }
        $isOutline[$y, $x] = $border
    }
}

# Emit frames.
if (-not (Test-Path $framesDir)) { New-Item -ItemType Directory -Path $framesDir | Out-Null }
# Wipe old frames so frame count changes don't leave stragglers.
Get-ChildItem $framesDir -Filter 'frame_*.grid.txt' | Remove-Item -Force

$period = $Palette.Count * $StripeWidth
for ($f = 0; $f -lt $Frames; $f++) {
    $lines = @()
    $lines += "# size ${W}x${H}"
    if ($hotspot) { $lines += "# hotspot $hotspot" }
    $lines += "# delay $Delay"
    for ($y = 0; $y -lt $H; $y++) {
        $rowChars = New-Object char[] $W
        for ($x = 0; $x -lt $W; $x++) {
            if (-not $filled[$y, $x]) {
                $rowChars[$x] = '.'
            } elseif ($isOutline[$y, $x]) {
                $rowChars[$x] = 'W'
            } else {
                $idx = ((($x + $y) - $f) % $period + $period) % $period
                $palIdx = [Math]::Floor($idx / $StripeWidth)
                $rowChars[$x] = $Palette[$palIdx][0]
            }
        }
        $lines += -join $rowChars
    }
    $name = "frame_{0:D2}.grid.txt" -f $f
    $path = Join-Path $framesDir $name
    Set-Content -Path $path -Value $lines -Encoding utf8
}

Write-Output "Generated $Frames frames in $framesDir"
