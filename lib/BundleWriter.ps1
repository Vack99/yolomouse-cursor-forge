# lib/BundleWriter.ps1
Add-Type -AssemblyName System.Drawing

function Save-Bundle {
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Description,
        [string]$Types = 'animated',
        [string]$Author = 'Forge'
    )
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $obj = [ordered]@{
        Name        = $Name
        Description = $Description
        Author      = $Author
        Types       = $Types
    }
    $json = $obj | ConvertTo-Json -Compress:$false
    Set-Content -Path (Join-Path $OutDir 'Bundle.json') -Value $json -Encoding utf8
}

function Save-FramePngs {
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps
    )
    $framesDir = Join-Path $OutDir 'frames'
    if (-not (Test-Path $framesDir)) { New-Item -ItemType Directory -Path $framesDir -Force | Out-Null }
    for ($i = 0; $i -lt $Bitmaps.Count; $i++) {
        $name = 'frame_{0:D2}.png' -f $i
        $Bitmaps[$i].Save((Join-Path $framesDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $Bitmaps[0].Save((Join-Path $OutDir 'Preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
}

function Save-PreviewStrip {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [int]$Gutter = 2
    )
    if ($Bitmaps.Count -eq 0) { throw 'no bitmaps' }
    $w = $Bitmaps[0].Width; $h = $Bitmaps[0].Height; $n = $Bitmaps.Count
    $totalW = $n * $w + ($n - 1) * $Gutter
    $strip = New-Object System.Drawing.Bitmap $totalW, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($strip)
    try {
        $g.Clear([System.Drawing.Color]::FromArgb(0,0,0,0))
        for ($i = 0; $i -lt $n; $i++) {
            $g.DrawImage($Bitmaps[$i], ($i * ($w + $Gutter)), 0)
        }
    } finally { $g.Dispose() }
    $strip.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $strip.Dispose()
}
