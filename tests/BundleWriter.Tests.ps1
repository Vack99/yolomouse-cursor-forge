# tests/BundleWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\BundleWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-SolidBitmap2 { param($Color)
    $b = New-Object System.Drawing.Bitmap 4,4,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear($Color); $g.Dispose(); return $b
}

Test-Case 'Save-Bundle writes Bundle.json with PascalCase keys and Types=animated' {
    $tmp = New-TempDir
    try {
        Save-Bundle -OutDir $tmp -Name 'PulseDot' -Description 'A breathing red dot'
        $json = Get-Content -Raw -Path (Join-Path $tmp 'Bundle.json') | ConvertFrom-Json
        Assert-Equal 'PulseDot' $json.Name
        Assert-Equal 'A breathing red dot' $json.Description
        Assert-Equal 'Forge' $json.Author
        Assert-Equal 'animated' $json.Types
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Test-Case 'Save-FramePngs writes one PNG per frame and copies Preview.png from frame 0' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap2 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap2 ([System.Drawing.Color]::Blue)
        Save-FramePngs -OutDir $tmp -Bitmaps @($b1,$b2)
        Assert-True (Test-Path (Join-Path $tmp 'frames\frame_00.png')) 'frame_00 png'
        Assert-True (Test-Path (Join-Path $tmp 'frames\frame_01.png')) 'frame_01 png'
        Assert-True (Test-Path (Join-Path $tmp 'Preview.png')) 'Preview.png'
        $b1.Dispose(); $b2.Dispose()
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Test-Case 'Save-PreviewStrip produces a wide PNG sized W*N + gutters' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap2 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap2 ([System.Drawing.Color]::Blue)
        $b3 = New-SolidBitmap2 ([System.Drawing.Color]::Green)
        $path = Join-Path $tmp 'preview_strip.png'
        Save-PreviewStrip -Path $path -Bitmaps @($b1,$b2,$b3) -Gutter 2
        $strip = [System.Drawing.Image]::FromFile($path)
        # 3 frames * 4 wide + 2 gutters * 2 = 12 + 4 = 16
        Assert-Equal 16 $strip.Width
        Assert-Equal 4 $strip.Height
        $strip.Dispose()
        $b1.Dispose(); $b2.Dispose(); $b3.Dispose()
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
