. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\CurWriter.ps1"
. "$PSScriptRoot\..\lib\AniWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-BlankBitmap { param([int]$Size = 2)
    $b = New-Object System.Drawing.Bitmap $Size,$Size,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y=0; $y -lt $Size; $y++) { for ($x=0; $x -lt $Size; $x++) {
        $b.SetPixel($x,$y,[System.Drawing.Color]::FromArgb(255,128,128,128))
    }}
    return $b
}

# Task 4.1 tests

Test-Case 'Get-AniBytes starts with RIFF .... ACON' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    Assert-BytesEqualAt ([byte[]][char[]]'RIFF') $bytes 0
    Assert-BytesEqualAt ([byte[]][char[]]'ACON') $bytes 8
    $b1.Dispose(); $b2.Dispose()
}

Test-Case 'Get-AniBytes anih chunk: tag, size=36, cbSize=36, nFrames=N, flags=1' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 7 -PerFrameDelays @(7,7)
    # anih tag at offset 12
    Assert-BytesEqualAt ([byte[]][char[]]'anih') $bytes 12
    # Chunk size DWORD at 16 = 36
    Assert-BytesEqualAt ([byte[]](36,0,0,0)) $bytes 16
    # cbSize at 20 = 36
    Assert-BytesEqualAt ([byte[]](36,0,0,0)) $bytes 20
    # nFrames at 24 = 2
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 24
    # nSteps at 28 = 2
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 28
    # iWidth=2 at 32, iHeight=2 at 36, iBitCount=32 at 40, nPlanes=1 at 44, jifRate=7 at 48, flags=1 at 52
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 32 'iWidth'
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 36 'iHeight'
    Assert-BytesEqualAt ([byte[]](32,0,0,0)) $bytes 40 'iBitCount=32'
    Assert-BytesEqualAt ([byte[]](1,0,0,0)) $bytes 44 'nPlanes=1'
    Assert-BytesEqualAt ([byte[]](7,0,0,0)) $bytes 48 'jifRate=7'
    Assert-BytesEqualAt ([byte[]](1,0,0,0)) $bytes 52 'flags=0x01'
    $b1.Dispose(); $b2.Dispose()
}

# Task 4.2 test

Test-Case 'Get-AniBytes rate chunk follows anih with N DWORDs' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap; $b3 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2,$b3) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(4,8,12)
    # anih ends at offset 12 + 8 + 36 = 56. rate starts there.
    Assert-BytesEqualAt ([byte[]][char[]]'rate') $bytes 56
    Assert-BytesEqualAt ([byte[]](12,0,0,0)) $bytes 60 'rate inner size = 4*3'
    Assert-BytesEqualAt ([byte[]](4,0,0,0))  $bytes 64 'frame 0 delay'
    Assert-BytesEqualAt ([byte[]](8,0,0,0))  $bytes 68 'frame 1 delay'
    Assert-BytesEqualAt ([byte[]](12,0,0,0)) $bytes 72 'frame 2 delay'
    $b1.Dispose(); $b2.Dispose(); $b3.Dispose()
}

# Task 4.3 tests

Test-Case 'Get-AniBytes LIST chunk follows rate' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    # After anih: 56. After rate (4*2 inner + 8 header) = 56 + 8 + 8 = 72. LIST starts at 72.
    Assert-BytesEqualAt ([byte[]][char[]]'LIST') $bytes 72
    # framInner = 4 (fram) + 2 * (8 + curSize). curSize for 2x2 = 86 (even, no pad). framInner = 4 + 2*94 = 192
    Assert-BytesEqualAt ([byte[]](192,0,0,0)) $bytes 76 'LIST inner size'
    Assert-BytesEqualAt ([byte[]][char[]]'fram') $bytes 80
    # First icon at 84
    Assert-BytesEqualAt ([byte[]][char[]]'icon') $bytes 84
    Assert-BytesEqualAt ([byte[]](86,0,0,0)) $bytes 88 'first icon size = 86'
    # First inner .cur starts at 92, must start with ICONDIR 00 00 02 00 01 00
    Assert-BytesEqualAt ([byte[]](0,0, 2,0, 1,0)) $bytes 92 'inner .cur ICONDIR'
    # Second icon at 92 + 86 = 178
    Assert-BytesEqualAt ([byte[]][char[]]'icon') $bytes 178
    $b1.Dispose(); $b2.Dispose()
}

Test-Case 'Get-AniBytes RIFF size matches actual byte count' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    # RIFF size DWORD at offset 4 must equal bytes.Length - 8
    $declared = [BitConverter]::ToUInt32($bytes, 4)
    Assert-Equal ($bytes.Length - 8) $declared 'RIFF size DWORD'
    $b1.Dispose(); $b2.Dispose()
}

Test-Case 'Get-AniBytes rejects mismatched Bitmaps / PerFrameDelays count' {
    $b1 = New-BlankBitmap
    Assert-Throws {
        Get-AniBytes -Bitmaps @($b1) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    } 'count'
    $b1.Dispose()
}

# Task 4.4 test

Test-Case 'Save-AniFile writes a parseable .ani to disk' {
    $tmp = New-TempDir
    try {
        $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
        $path = Join-Path $tmp 'test.ani'
        Save-AniFile -Path $path -Bitmaps @($b1,$b2) -HotspotX 1 -HotspotY 1 -DefaultDelay 6 -PerFrameDelays @(6,6)
        Assert-True (Test-Path $path) 'file exists'
        $disk = [System.IO.File]::ReadAllBytes($path)
        Assert-BytesEqualAt ([byte[]][char[]]'RIFF') $disk 0
        Assert-BytesEqualAt ([byte[]][char[]]'ACON') $disk 8
        $b1.Dispose(); $b2.Dispose()
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
