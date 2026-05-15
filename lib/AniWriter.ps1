# lib/AniWriter.ps1
# Pure function: Get-AniBytes -> byte[]
# Wraps N .cur frames into a RIFF/ACON .ani file.
# Spec §8.4.
Add-Type -AssemblyName System.Drawing

function Write-RiffChunkHeader {
    param([System.IO.BinaryWriter]$Writer, [string]$Tag, [uint32]$Size)
    if ($Tag.Length -ne 4) { throw "RIFF tag must be 4 chars, got '$Tag'" }
    foreach ($c in $Tag.ToCharArray()) { $Writer.Write([byte][char]$c) }
    $Writer.Write([uint32]$Size)
}

function Get-AniBytes {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY,
        [Parameter(Mandatory)][int]$DefaultDelay,
        [Parameter(Mandatory)][int[]]$PerFrameDelays
    )
    if ($Bitmaps.Count -ne $PerFrameDelays.Count) {
        throw "Bitmaps count ($($Bitmaps.Count)) != PerFrameDelays count ($($PerFrameDelays.Count))"
    }
    $n = $Bitmaps.Count
    $w = $Bitmaps[0].Width; $h = $Bitmaps[0].Height

    # Build each inner .cur once
    $curs = @()
    foreach ($bmp in $Bitmaps) {
        if ($bmp.Width -ne $w -or $bmp.Height -ne $h) {
            throw "Frame size mismatch: expected ${w}x${h}, got $($bmp.Width)x$($bmp.Height)"
        }
        $curs += ,(Get-CurBytes -Bitmap $bmp -HotspotX $HotspotX -HotspotY $HotspotY)
    }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        # Compute LIST/fram chunk inner size: 4 ('fram') + sum over frames of (8 'icon' header + curSize + (curSize odd? 1 : 0))
        $framInner = 4
        foreach ($c in $curs) {
            $framInner += 8 + $c.Length
            if (($c.Length % 2) -ne 0) { $framInner += 1 }
        }
        # rate chunk inner size = 4*N
        $rateInner = 4 * $n
        # RIFF inner size = 4 ('ACON') + 8 + 36 (anih) + 8 + rateInner + 8 + framInner
        $riffInner = 4 + 8 + 36 + 8 + $rateInner + 8 + $framInner

        # RIFF header
        Write-RiffChunkHeader $bw 'RIFF' $riffInner
        foreach ($c in 'ACON'.ToCharArray()) { $bw.Write([byte][char]$c) }

        # anih chunk
        Write-RiffChunkHeader $bw 'anih' 36
        $bw.Write([uint32]36)               # cbSize
        $bw.Write([uint32]$n)               # nFrames
        $bw.Write([uint32]$n)               # nSteps
        $bw.Write([uint32]$w)               # iWidth
        $bw.Write([uint32]$h)               # iHeight
        $bw.Write([uint32]32)               # iBitCount
        $bw.Write([uint32]1)                # nPlanes
        $bw.Write([uint32]$DefaultDelay)    # jifRate
        $bw.Write([uint32]1)                # flags = 0x01

        # rate chunk
        Write-RiffChunkHeader $bw 'rate' $rateInner
        foreach ($d in $PerFrameDelays) { $bw.Write([uint32]$d) }

        # LIST fram chunk
        Write-RiffChunkHeader $bw 'LIST' $framInner
        foreach ($c in 'fram'.ToCharArray()) { $bw.Write([byte][char]$c) }
        foreach ($cur in $curs) {
            $curBytes = [byte[]]$cur
            Write-RiffChunkHeader $bw 'icon' $curBytes.Length
            $bw.Write($curBytes, 0, $curBytes.Length)
            if (($curBytes.Length % 2) -ne 0) { $bw.Write([byte]0) }  # RIFF pad
        }

        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
        $ms.Dispose()
    }
}

function Save-AniFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY,
        [Parameter(Mandatory)][int]$DefaultDelay,
        [Parameter(Mandatory)][int[]]$PerFrameDelays
    )
    $bytes = Get-AniBytes -Bitmaps $Bitmaps -HotspotX $HotspotX -HotspotY $HotspotY -DefaultDelay $DefaultDelay -PerFrameDelays $PerFrameDelays
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}
