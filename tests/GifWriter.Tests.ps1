# tests/GifWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\GifWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-SolidBitmap { param([int]$Size, $Color)
    $b = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear($Color); $g.Dispose()
    return $b
}

Test-Case 'Save-GifFile produces a file starting with GIF89a' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap 8 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap 8 ([System.Drawing.Color]::Blue)
        $path = Join-Path $tmp 'out.gif'
        Save-GifFile -Path $path -Bitmaps @($b1,$b2) -PerFrameDelaysJiffies @(6,6)
        Assert-True (Test-Path $path) 'gif exists'
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $sig = -join ($bytes[0..5] | ForEach-Object { [char]$_ })
        Assert-Equal 'GIF89a' $sig
        $b1.Dispose(); $b2.Dispose()
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
