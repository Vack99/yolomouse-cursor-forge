# lib/GifWriter.ps1
# Writes an animated GIF file for preview purposes.
# Per spec §10.4: fidelity is not the goal — animation timing is.
# Uses System.Drawing.Imaging SaveAdd multi-frame approach + PropertyItem tags.
Add-Type -AssemblyName System.Drawing

function Save-GifFile {
    <#
    .SYNOPSIS
        Write an animated GIF to disk with per-frame delays.
    .PARAMETER Path
        Destination file path (will be overwritten).
    .PARAMETER Bitmaps
        Array of System.Drawing.Bitmap frames (in order).
    .PARAMETER PerFrameDelaysJiffies
        Delay for each frame in jiffies (1/60 s). Must match Bitmaps count.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int[]]$PerFrameDelaysJiffies
    )

    if ($Bitmaps.Count -ne $PerFrameDelaysJiffies.Count) {
        throw "Bitmaps ($($Bitmaps.Count)) != delays ($($PerFrameDelaysJiffies.Count))"
    }

    # Convert jiffies (1/60 s) -> GIF centiseconds (1/100 s) per spec §8.8
    $delaysCs = $PerFrameDelaysJiffies | ForEach-Object { [int][math]::Round($_ * 100.0 / 60.0) }

    # Locate the GIF encoder
    $gifEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/gif' } | Select-Object -First 1
    if ($null -eq $gifEncoder) { throw 'No GIF encoder available in System.Drawing' }

    # Build FrameDelay byte array: 4 bytes per frame, little-endian uint32
    $delayBytes = New-Object byte[] (4 * $Bitmaps.Count)
    for ($i = 0; $i -lt $Bitmaps.Count; $i++) {
        $b = [BitConverter]::GetBytes([uint32]$delaysCs[$i])
        [Array]::Copy($b, 0, $delayBytes, $i * 4, 4)
    }

    $first = $Bitmaps[0]

    # Acquire a PropertyItem instance to mutate.
    # PropertyItem has no public constructor; we must get one from an existing image.
    $protoItem = $null

    # Attempt 1: clone from the first bitmap if it already has properties
    if ($first.PropertyIdList.Count -gt 0) {
        $protoItem = $first.GetPropertyItem($first.PropertyIdList[0])
    }

    # Attempt 2: round-trip through a temp PNG to get a PropertyItem
    if ($null -eq $protoItem) {
        $tmpPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString('N') + '.png')
        try {
            $first.Save($tmpPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $loaded = [System.Drawing.Bitmap]::FromFile($tmpPath)
            try {
                if ($loaded.PropertyIdList.Count -gt 0) {
                    $protoItem = $loaded.GetPropertyItem($loaded.PropertyIdList[0])
                }
            } finally {
                $loaded.Dispose()
            }
        } finally {
            Remove-Item -Force $tmpPath -ErrorAction SilentlyContinue
        }
    }

    # Attempt 3: private constructor via reflection (works on .NET Framework 4.x)
    if ($null -eq $protoItem) {
        try {
            $protoItem = [System.Activator]::CreateInstance([System.Drawing.Imaging.PropertyItem], $true)
        } catch {
            # Ignore — will fall back to single-frame below
        }
    }

    # Apply FrameDelay property (0x5100) to first bitmap if we have a prototype
    if ($null -ne $protoItem) {
        $protoItem.Id    = 0x5100
        $protoItem.Type  = 4      # SHORT array
        $protoItem.Len   = $delayBytes.Length
        $protoItem.Value = $delayBytes
        try { $first.SetPropertyItem($protoItem) } catch { }

        # LoopCount property (0x5101) — 0 means infinite loop; best-effort
        try {
            $loopItem = [System.Activator]::CreateInstance([System.Drawing.Imaging.PropertyItem], $true)
            $loopItem.Id    = 0x5101
            $loopItem.Type  = 3      # SHORT
            $loopItem.Len   = 2
            $loopItem.Value = [byte[]](0, 0)
            $first.SetPropertyItem($loopItem)
        } catch {
            # Loop count is best-effort; ignore failure
        }
    }

    # Encoder value constants
    $multiFrame = [System.Drawing.Imaging.EncoderValue]::MultiFrame
    $addFrame   = [System.Drawing.Imaging.EncoderValue]::FrameDimensionTime
    $flush      = [System.Drawing.Imaging.EncoderValue]::Flush

    # Attempt multi-frame animated GIF save
    $animated = $false
    try {
        $epStart = New-Object System.Drawing.Imaging.EncoderParameters 1
        $epStart.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::SaveFlag, [long]$multiFrame)
        $first.Save($Path, $gifEncoder, $epStart)

        for ($i = 1; $i -lt $Bitmaps.Count; $i++) {
            $epNext = New-Object System.Drawing.Imaging.EncoderParameters 1
            $epNext.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                [System.Drawing.Imaging.Encoder]::SaveFlag, [long]$addFrame)
            $first.SaveAdd($Bitmaps[$i], $epNext)
        }

        $epEnd = New-Object System.Drawing.Imaging.EncoderParameters 1
        $epEnd.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::SaveFlag, [long]$flush)
        $first.SaveAdd($epEnd)

        $animated = $true
    } catch {
        # Multi-frame save failed; fall back to single-frame GIF of frame 0
        # TODO: animated preview GIF disabled — GDI+ multi-frame save failed on this host
        Write-Warning "preview.gif is single-frame on this host (multi-frame GIF save error: $($_.Exception.Message))"
        $first.Save($Path, [System.Drawing.Imaging.ImageFormat]::Gif)
    }
}
