# Extract one frame of a Windows .cur (or .ico) file to a PNG, preserving alpha.
# .cur files don't load via System.Drawing, so the ICONDIR / DIB is parsed by hand.
# Usage: .\tools\cur-to-png.ps1 <cur-path> <png-out> [-Size 0]
#   -Size 0 (default) picks the largest frame; otherwise picks the frame whose
#   width matches -Size.
param(
    [Parameter(Mandatory=$true)][string]$CurPath,
    [Parameter(Mandatory=$true)][string]$PngOut,
    [int]$Size = 0
)

Add-Type -AssemblyName System.Drawing

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $CurPath))
$type = [BitConverter]::ToUInt16($bytes, 2)
if ($type -ne 1 -and $type -ne 2) { Write-Error "Not an .ico/.cur file (type=$type)"; exit 1 }
$count = [BitConverter]::ToUInt16($bytes, 4)

# Read all directory entries.
$entries = @()
for ($i = 0; $i -lt $count; $i++) {
    $o = 6 + $i * 16
    $w = $bytes[$o]; $h = $bytes[$o+1]
    if ($w -eq 0) { $w = 256 }
    if ($h -eq 0) { $h = 256 }
    $entries += [pscustomobject]@{
        W = $w; H = $h
        Offset = [BitConverter]::ToUInt32($bytes, $o+12)
    }
}

# Pick the requested frame.
if ($Size -gt 0) {
    $entry = $entries | Where-Object { $_.W -eq $Size } | Select-Object -First 1
    if (-not $entry) { Write-Error "No frame of width $Size (have: $($entries.W -join ', '))"; exit 1 }
} else {
    $entry = $entries | Sort-Object W -Descending | Select-Object -First 1
}

$off = $entry.Offset
$dibHeaderSize = [BitConverter]::ToUInt32($bytes, $off)
$dibW = [BitConverter]::ToInt32($bytes, $off+4)
$dibH = [BitConverter]::ToInt32($bytes, $off+8)
$bpp = [BitConverter]::ToUInt16($bytes, $off+14)
if ($bpp -ne 32) { Write-Error "Only 32-bit frames supported (got $bpp-bit)"; exit 1 }

# .cur DIB stores XOR (color) and AND (mask) stacked; real height is dibH / 2.
$realH = [Math]::Abs($dibH) / 2
$pixelStart = $off + $dibHeaderSize

$bmp = New-Object System.Drawing.Bitmap($dibW, $realH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $realH; $y++) {
    # DIB rows are bottom-up.
    $srcRow = $realH - 1 - $y
    for ($x = 0; $x -lt $dibW; $x++) {
        $p = $pixelStart + ($srcRow * $dibW + $x) * 4
        $b = $bytes[$p]; $g = $bytes[$p+1]; $r = $bytes[$p+2]; $a = $bytes[$p+3]
        $color = [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
        $bmp.SetPixel($x, $y, $color)
    }
}

$outPath = $PngOut
if (-not [System.IO.Path]::IsPathRooted($outPath)) {
    $outPath = Join-Path (Get-Location) $outPath
}
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Wrote ${dibW}x${realH} frame -> $outPath"
