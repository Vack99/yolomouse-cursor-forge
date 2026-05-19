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

function ConvertFrom-RgbaHex {
    # Shared hex -> Color helper. Accepts RRGGBB (alpha defaults to FF) or RRGGBBAA.
    param([Parameter(Mandatory)][string]$Hex, [string]$Context = 'rgba')
    $h = $Hex.Trim()
    if ($h.Length -ne 6 -and $h.Length -ne 8) { throw "${Context}: hex must be 6 or 8 chars, got '$h' ($($h.Length))" }
    if ($h -notmatch '^[0-9A-Fa-f]+$')        { throw "${Context}: hex contains non-hex chars: '$h'" }
    $r = [Convert]::ToInt32($h.Substring(0,2),16)
    $g = [Convert]::ToInt32($h.Substring(2,2),16)
    $b = [Convert]::ToInt32($h.Substring(4,2),16)
    $a = if ($h.Length -eq 8) { [Convert]::ToInt32($h.Substring(6,2),16) } else { 0xFF }
    return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

function Read-JsonFrame {
    # Parses a JSON pixel grid (Cursor Studio's frame format) into the same
    # hashtable shape Read-Grid returns, except cells are a 2D int array
    # under .Pixels (vs a 1D string array under .Cells). Get-FrameBitmap
    # dispatches on whichever is present.
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "json frame file not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    try { $obj = $Text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "json frame: invalid JSON ($($_.Exception.Message))" }

    if ($null -eq $obj.width -or $null -eq $obj.height) {
        throw "json frame: missing 'width' and/or 'height'"
    }
    $width  = [int]$obj.width
    $height = [int]$obj.height
    if ($width -le 0 -or $height -le 0) { throw "json frame: width and height must be positive (got ${width}x${height})" }

    if ($obj.hotspot) {
        $hotspot = @{ X = [int]$obj.hotspot.x; Y = [int]$obj.hotspot.y }
    } else {
        $hotspot = @{ X = [int]([math]::Floor($width / 2)); Y = [int]([math]::Floor($height / 2)) }
    }
    $delay = if ($null -ne $obj.delay) { [int]$obj.delay } else { $null }

    if ($null -eq $obj.pixels) { throw "json frame: missing 'pixels' 2D array" }
    $rows = @($obj.pixels)
    if ($rows.Count -ne $height) { throw "json frame: expected $height rows, got $($rows.Count)" }
    $pixels = New-Object 'System.Collections.ArrayList'
    for ($y = 0; $y -lt $height; $y++) {
        $row = @($rows[$y])
        if ($row.Count -ne $width) { throw "json frame row ${y}: $($row.Count) columns, expected $width" }
        $ints = New-Object 'int[]' $width
        for ($x = 0; $x -lt $width; $x++) {
            $v = $row[$x]
            if ($v -isnot [int] -and $v -isnot [long] -and $v -isnot [double]) {
                throw "json frame row $y col ${x}: expected integer palette index, got '$v'"
            }
            $iv = [int]$v
            if ($iv -lt 0) { throw "json frame row $y col ${x}: palette index must be non-negative (got $iv)" }
            $ints[$x] = $iv
        }
        [void]$pixels.Add($ints)
    }

    return @{
        Width   = $width
        Height  = $height
        Hotspot = $hotspot
        Delay   = $delay
        Pixels  = @($pixels)
    }
}

function Read-PaletteJson {
    # Parses palette.json (Cursor Studio palette format) into a hashtable
    # keyed by integer palette index -> System.Drawing.Color. The int-keyed
    # shape is what Get-FrameBitmap consults when a grid has .Pixels.
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "palette.json not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    try { $obj = $Text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "palette.json: invalid JSON ($($_.Exception.Message))" }
    if ($null -eq $obj.colors) { throw "palette.json: missing 'colors' array" }

    $palette = @{}
    foreach ($entry in @($obj.colors)) {
        if ($null -eq $entry.index) { throw "palette.json: entry missing 'index'" }
        if ($null -eq $entry.rgba)  { throw "palette.json: entry missing 'rgba'" }
        $idx = [int]$entry.index
        if ($idx -lt 0) { throw "palette.json: index must be non-negative (got $idx)" }
        $palette[$idx] = ConvertFrom-RgbaHex -Hex ([string]$entry.rgba) -Context "palette.json index $idx"
    }
    return $palette
}

function Get-FrameBitmap {
    # Renders either a grid.txt-shaped grid (.Cells: string rows + char->Color
    # palette) or a JSON-shaped grid (.Pixels: int[][] + int->Color palette).
    param(
        [Parameter(Mandatory)]$Grid,
        [Parameter(Mandatory)][hashtable]$Palette
    )
    $bmp = New-Object System.Drawing.Bitmap $Grid.Width, $Grid.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $transparent = [System.Drawing.Color]::FromArgb(0,0,0,0)
    if ($null -ne $Grid.Pixels) {
        # JSON path: integer palette indices. Index 0 is reserved for transparent
        # (matches studio/src/lib/pixelGrid.ts) and does not require a palette entry.
        for ($y = 0; $y -lt $Grid.Height; $y++) {
            $row = $Grid.Pixels[$y]
            for ($x = 0; $x -lt $Grid.Width; $x++) {
                $idx = [int]$row[$x]
                if ($idx -eq 0) {
                    $bmp.SetPixel($x, $y, $transparent)
                } elseif (-not $Palette.ContainsKey($idx)) {
                    $bmp.Dispose()
                    throw "row $y col ${x}: palette index '$idx' not in palette"
                } else {
                    $bmp.SetPixel($x, $y, $Palette[$idx])
                }
            }
        }
    } else {
        # grid.txt path: char-keyed palette, '.' is transparent.
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
    }
    return $bmp
}
