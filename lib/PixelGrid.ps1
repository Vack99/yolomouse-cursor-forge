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
