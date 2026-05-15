Add-Type -AssemblyName System.Drawing

function Read-Palette {
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "palette file not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    $palette = New-Object 'System.Collections.Hashtable' ([System.StringComparer]::Ordinal)
    $lineNo = 0
    foreach ($line in $Text -split "`r?`n") {
        $lineNo++
        $trim = $line.Trim()
        if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
        $parts = $trim -split '\s+', 2
        if ($parts.Count -lt 2) { throw "palette.txt:$lineNo : expected '<letter> <hex>', got '$trim'" }
        $letter = $parts[0]; $hex = $parts[1].Trim()
        if ($letter.Length -ne 1) { throw "palette.txt:$lineNo : letter must be a single character, got '$letter'" }
        if ($hex.Length -ne 6 -and $hex.Length -ne 8) { throw "palette.txt:$lineNo : hex must be 6 or 8 chars, got '$hex' ($($hex.Length))" }
        if ($hex -notmatch '^[0-9A-Fa-f]+$') { throw "palette.txt:$lineNo : hex contains non-hex chars: '$hex'" }
        if ($hex.Length -eq 6) {
            $a = 0xFF
            $r = [Convert]::ToInt32($hex.Substring(0,2),16)
            $g = [Convert]::ToInt32($hex.Substring(2,2),16)
            $b = [Convert]::ToInt32($hex.Substring(4,2),16)
        } else {
            $r = [Convert]::ToInt32($hex.Substring(0,2),16)
            $g = [Convert]::ToInt32($hex.Substring(2,2),16)
            $b = [Convert]::ToInt32($hex.Substring(4,2),16)
            $a = [Convert]::ToInt32($hex.Substring(6,2),16)
        }
        $palette[$letter] = [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
    }
    return $palette
}

function Read-Grid {
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "grid file not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    $width = $null; $height = $null; $hotspot = $null; $delay = $null
    $cells = New-Object System.Collections.ArrayList
    $inBody = $false
    foreach ($line in $Text -split "`r?`n") {
        if (-not $inBody) {
            $t = $line.Trim()
            if ($t -eq '') { continue }
            if ($t.StartsWith('#')) {
                if ($t -match '^#\s*size\s+(\d+)\s*x\s*(\d+)') {
                    $width  = [int]$Matches[1]
                    $height = [int]$Matches[2]
                } elseif ($t -match '^#\s*hotspot\s+(\d+)\s*,\s*(\d+)') {
                    $hotspot = @{ X = [int]$Matches[1]; Y = [int]$Matches[2] }
                } elseif ($t -match '^#\s*delay\s+(\d+)') {
                    $delay = [int]$Matches[1]
                }
                continue
            }
            $inBody = $true
        }
        if ($inBody) {
            if ($line -eq '') { continue }   # tolerate trailing blank line
            [void]$cells.Add($line)
        }
    }
    if ($null -eq $width -or $null -eq $height) { throw "missing '# size WxH' header" }
    if ($cells.Count -ne $height) { throw "expected $height rows, got $($cells.Count)" }
    for ($i = 0; $i -lt $cells.Count; $i++) {
        if ($cells[$i].Length -ne $width) {
            throw "row $i has $($cells[$i].Length) columns, expected $width"
        }
    }
    return @{
        Width   = $width
        Height  = $height
        Hotspot = $hotspot
        Delay   = $delay
        Cells   = @($cells)
    }
}

function Read-DesignFrontMatter {
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "design file not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    $lines = $Text -split "`r?`n"
    if ($lines.Count -lt 1 -or $lines[0].Trim() -ne '---') {
        throw "design.md must open with a '---' fence on line 1"
    }
    $kv = @{}
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { break }
        if ($lines[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$') {
            $kv[$Matches[1]] = $Matches[2]
        }
    }
    $result = @{
        Name           = $kv['name']
        Description    = $kv['description']
        Frames         = if ($kv['frames']) { [int]$kv['frames'] } else { 8 }
        DefaultDelay   = if ($kv['default_delay']) { [int]$kv['default_delay'] } else { 6 }
    }
    if ($kv['size'] -match '^\s*(\d+)\s*x\s*(\d+)\s*$') {
        $result.Width = [int]$Matches[1]; $result.Height = [int]$Matches[2]
    } else { $result.Width = 64; $result.Height = 64 }
    if ($kv['default_hotspot'] -match '^\s*(\d+)\s*,\s*(\d+)\s*$') {
        $result.DefaultHotspot = @{ X=[int]$Matches[1]; Y=[int]$Matches[2] }
    } else {
        $result.DefaultHotspot = @{ X = [int]([math]::Floor($result.Width/2)); Y = [int]([math]::Floor($result.Height/2)) }
    }
    return $result
}

function Get-FrameBitmap {
    param(
        [Parameter(Mandatory)]$Grid,
        [Parameter(Mandatory)][hashtable]$Palette
    )
    $bmp = New-Object System.Drawing.Bitmap $Grid.Width, $Grid.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $transparent = [System.Drawing.Color]::FromArgb(0,0,0,0)
    for ($y = 0; $y -lt $Grid.Height; $y++) {
        $row = $Grid.Cells[$y]
        for ($x = 0; $x -lt $Grid.Width; $x++) {
            $ch = $row[$x]
            if ($ch -eq '.') {
                $bmp.SetPixel($x, $y, $transparent)
            } else {
                $key = [string]$ch
                if (-not $Palette.ContainsKey($key)) {
                    $bmp.Dispose()
                    throw "row $y col ${x}: character '$key' not in palette"
                }
                $bmp.SetPixel($x, $y, $Palette[$key])
            }
        }
    }
    return $bmp
}
