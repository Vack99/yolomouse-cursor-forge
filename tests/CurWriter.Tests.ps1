# tests/CurWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\CurWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-TestBitmap2x2 {
    $b = New-Object System.Drawing.Bitmap 2,2,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $b.SetPixel(0,0,[System.Drawing.Color]::FromArgb(255,255,0,0))   # red TL
    $b.SetPixel(1,0,[System.Drawing.Color]::FromArgb(255,0,255,0))   # green TR
    $b.SetPixel(0,1,[System.Drawing.Color]::FromArgb(0,0,0,0))       # transparent BL
    $b.SetPixel(1,1,[System.Drawing.Color]::FromArgb(255,0,0,255))   # blue BR
    return $b
}

Test-Case 'Get-CurBytes total size for 2x2 32bpp is 86 bytes' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    Assert-Equal 86 $bytes.Length
    $b.Dispose()
}

Test-Case 'Get-CurBytes ICONDIR header is 00 00 02 00 01 00' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    Assert-BytesEqualAt ([byte[]](0,0, 2,0, 1,0)) $bytes 0 'ICONDIR'
    $b.Dispose()
}

Test-Case 'Get-CurBytes ICONDIRENTRY has correct width/height/hotspot/offset' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 1 -HotspotY 2
    # offset 6: bWidth=2, bHeight=2, bColorCount=0, bReserved=0
    Assert-BytesEqualAt ([byte[]](2,2,0,0)) $bytes 6
    # offset 10: wHotspotX=1 (LE), wHotspotY=2 (LE)
    Assert-BytesEqualAt ([byte[]](1,0, 2,0)) $bytes 10
    # offset 14: dwBytesInRes = 64 (40 header + 16 xor + 8 and)
    # For 2x2: XOR=2*2*4=16 bytes. AND row stride = ceil(2/8)=1 byte, padded to 4 = 4 bytes. Total AND = 2*4 = 8.
    # bytesInRes = 40 + 16 + 8 = 64 = 0x40
    Assert-BytesEqualAt ([byte[]](0x40,0,0,0)) $bytes 14 'bytesInRes'
    # offset 18: dwImageOffset = 22 (0x16)
    Assert-BytesEqualAt ([byte[]](0x16,0,0,0)) $bytes 18 'imageOffset'
    $b.Dispose()
}

Test-Case 'Get-CurBytes BITMAPINFOHEADER has biSize=40 biWidth=W biHeight=2H biPlanes=1 biBitCount=32' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # BITMAPINFOHEADER starts at offset 22
    Assert-BytesEqualAt ([byte[]](40,0,0,0))   $bytes 22 'biSize=40'
    Assert-BytesEqualAt ([byte[]](2,0,0,0))    $bytes 26 'biWidth=2'
    Assert-BytesEqualAt ([byte[]](4,0,0,0))    $bytes 30 'biHeight=2*2=4'
    Assert-BytesEqualAt ([byte[]](1,0))        $bytes 34 'biPlanes=1'
    Assert-BytesEqualAt ([byte[]](32,0))       $bytes 36 'biBitCount=32'
    Assert-BytesEqualAt ([byte[]](0,0,0,0))    $bytes 38 'biCompression=BI_RGB'
    $b.Dispose()
}

Test-Case 'Get-CurBytes XOR mask is bottom-up BGRA' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # XOR mask starts at 6 + 16 + 40 = 62
    # Bottom row first: pixel (0,1) transparent, (1,1) blue
    # (0,1) is transparent: B=0 G=0 R=0 A=0
    Assert-BytesEqualAt ([byte[]](0,0,0,0)) $bytes 62 'bottom-left pixel (transparent)'
    # (1,1) blue: B=255 G=0 R=0 A=255
    Assert-BytesEqualAt ([byte[]](255,0,0,255)) $bytes 66 'bottom-right pixel (blue)'
    # Then top row: (0,0) red B=0 G=0 R=255 A=255 at offset 70
    Assert-BytesEqualAt ([byte[]](0,0,255,255)) $bytes 70 'top-left pixel (red)'
    # (1,0) green B=0 G=255 R=0 A=255 at offset 74
    Assert-BytesEqualAt ([byte[]](0,255,0,255)) $bytes 74 'top-right pixel (green)'
    $b.Dispose()
}

Test-Case 'Get-CurBytes AND mask is all zeros (8 bytes for 2x2)' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # AND mask starts at 78, length 8 (2 rows * 4 padded bytes)
    Assert-BytesEqualAt ([byte[]](0,0,0,0,0,0,0,0)) $bytes 78 'AND mask zeros'
    $b.Dispose()
}

Test-Case 'Get-CurBytes for 64x64 has correct total size' {
    $big = New-Object System.Drawing.Bitmap 64,64,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = Get-CurBytes -Bitmap $big -HotspotX 32 -HotspotY 32
    # 6 + 16 + 40 + (64*64*4=16384) + (64 rows * 8 padded bytes = 512) = 16958
    Assert-Equal 16958 $bytes.Length 'total size for 64x64'
    $big.Dispose()
}
