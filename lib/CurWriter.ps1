# lib/CurWriter.ps1
# Pure function: Get-CurBytes -Bitmap $b -HotspotX $x -HotspotY $y -> byte[]
# Writes a single-image Windows .cur file (used as inner frame in .ani RIFF containers).
# Spec §8.4.
Add-Type -AssemblyName System.Drawing

function Get-CurBytes {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap]$Bitmap,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY
    )
    $w = $Bitmap.Width; $h = $Bitmap.Height
    $xorSize = $w * $h * 4
    $andRowStride = [int]([math]::Ceiling($w / 8))
    $andRowPadded = [int]([math]::Ceiling($andRowStride / 4)) * 4
    $andSize = $andRowPadded * $h
    $bytesInRes = 40 + $xorSize + $andSize

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        # ICONDIR (6 bytes)
        $bw.Write([uint16]0)     # Reserved
        $bw.Write([uint16]2)     # Type = 2 (cursor)
        $bw.Write([uint16]1)     # Count = 1

        # ICONDIRENTRY (16 bytes)
        $bw.Write([byte]($w -band 0xFF))         # bWidth (0 means 256+)
        $bw.Write([byte]($h -band 0xFF))         # bHeight
        $bw.Write([byte]0)                       # bColorCount
        $bw.Write([byte]0)                       # bReserved
        $bw.Write([uint16]$HotspotX)             # wHotspotX
        $bw.Write([uint16]$HotspotY)             # wHotspotY
        $bw.Write([uint32]$bytesInRes)           # dwBytesInRes
        $bw.Write([uint32]22)                    # dwImageOffset (6 + 16 = 22)

        # BITMAPINFOHEADER (40 bytes)
        $bw.Write([uint32]40)                    # biSize
        $bw.Write([int32]$w)                     # biWidth
        $bw.Write([int32]($h * 2))               # biHeight = 2*H (XOR + AND mask stacked)
        $bw.Write([uint16]1)                     # biPlanes
        $bw.Write([uint16]32)                    # biBitCount
        $bw.Write([uint32]0)                     # biCompression = BI_RGB
        $bw.Write([uint32]($xorSize + $andSize)) # biSizeImage
        $bw.Write([int32]0)                      # biXPelsPerMeter
        $bw.Write([int32]0)                      # biYPelsPerMeter
        $bw.Write([uint32]0)                     # biClrUsed
        $bw.Write([uint32]0)                     # biClrImportant

        # XOR mask: BGRA bytes, bottom-up rows
        for ($y = $h - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $w; $x++) {
                $c = $Bitmap.GetPixel($x, $y)
                $bw.Write([byte]$c.B)
                $bw.Write([byte]$c.G)
                $bw.Write([byte]$c.R)
                $bw.Write([byte]$c.A)
            }
        }

        # AND mask: all zeros (32bpp cursors rely on XOR alpha channel)
        # Row stride padded to 4-byte boundary
        for ($y = 0; $y -lt $h; $y++) {
            for ($i = 0; $i -lt $andRowPadded; $i++) { $bw.Write([byte]0) }
        }

        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
        $ms.Dispose()
    }
}
