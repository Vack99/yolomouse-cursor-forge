. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
Add-Type -AssemblyName System.Drawing

Test-Case 'Read-Palette parses single RGB entry' {
    $p = Read-Palette -Text "A FF0000"
    Assert-Equal 1 $p.Count 'one entry expected'
    $c = $p['A']
    Assert-Equal 255 $c.A 'alpha defaults to FF'
    Assert-Equal 255 $c.R 'red'
    Assert-Equal 0   $c.G 'green'
    Assert-Equal 0   $c.B 'blue'
}

Test-Case 'Read-Palette parses RGBA entry' {
    $p = Read-Palette -Text "S 1A1A1A80"
    $c = $p['S']
    Assert-Equal 0x80 $c.A 'alpha from input'
    Assert-Equal 0x1A $c.R 'red'
}

Test-Case 'Read-Palette ignores comments and blanks' {
    $p = Read-Palette -Text "# header`nA FF0000`n`n# mid`nB 00FF00`n"
    Assert-Equal 2 $p.Count 'two entries'
}

Test-Case 'Read-Palette is case sensitive' {
    $p = Read-Palette -Text "A FF0000`na 0000FF"
    Assert-Equal 2 $p.Count 'A and a are distinct'
    Assert-Equal 255 $p['A'].R
    Assert-Equal 255 $p['a'].B
}

Test-Case 'Read-Palette rejects bad hex length' {
    Assert-Throws { Read-Palette -Text "A FF6B" } 'hex'
}

Test-Case 'Read-Palette rejects multi-char letter' {
    Assert-Throws { Read-Palette -Text "AB FF0000" } 'single character'
}

Test-Case 'Read-Grid parses size + body' {
    $body = @"
# size 4x3
....
.AA.
....
"@
    $g = Read-Grid -Text $body
    Assert-Equal 4 $g.Width
    Assert-Equal 3 $g.Height
    Assert-Equal 3 $g.Cells.Count
    Assert-Equal '.AA.' $g.Cells[1]
    Assert-Equal $null $g.Hotspot 'no hotspot declared'
    Assert-Equal $null $g.Delay 'no delay declared'
}

Test-Case 'Read-Grid parses hotspot and delay headers' {
    $body = @"
# size 2x2
# hotspot 1,0
# delay 12
AB
CD
"@
    $g = Read-Grid -Text $body
    Assert-Equal 1 $g.Hotspot.X
    Assert-Equal 0 $g.Hotspot.Y
    Assert-Equal 12 $g.Delay
}

Test-Case 'Read-Grid rejects wrong row count' {
    Assert-Throws {
        Read-Grid -Text "# size 2x3`n..`n.."
    } 'rows'
}

Test-Case 'Read-Grid rejects wrong column count' {
    Assert-Throws {
        Read-Grid -Text "# size 3x2`n..`n..."
    } 'columns'
}

Test-Case 'Read-DesignFrontMatter extracts key-value pairs' {
    $body = @"
---
name: PulseDot
description: A breathing red dot
size: 64x64
frames: 8
default_delay: 6
default_hotspot: 32,32
---
# Free-form prose

Lots of design notes go here.
"@
    $d = Read-DesignFrontMatter -Text $body
    Assert-Equal 'PulseDot' $d.Name
    Assert-Equal 'A breathing red dot' $d.Description
    Assert-Equal 64 $d.Width
    Assert-Equal 64 $d.Height
    Assert-Equal 8 $d.Frames
    Assert-Equal 6 $d.DefaultDelay
    Assert-Equal 32 $d.DefaultHotspot.X
    Assert-Equal 32 $d.DefaultHotspot.Y
}

Test-Case 'Read-DesignFrontMatter requires opening fence' {
    Assert-Throws { Read-DesignFrontMatter -Text "name: x" } 'fence'
}

Test-Case 'Get-FrameBitmap renders 2x2 with palette' {
    $grid = Read-Grid -Text "# size 2x2`nAB`n.A"
    $pal  = Read-Palette -Text "A FF0000`nB 00FF00"
    $bmp  = Get-FrameBitmap -Grid $grid -Palette $pal
    Assert-Equal 2 $bmp.Width
    Assert-Equal 2 $bmp.Height
    $c00 = $bmp.GetPixel(0,0); Assert-Equal 255 $c00.R; Assert-Equal 255 $c00.A
    $c10 = $bmp.GetPixel(1,0); Assert-Equal 255 $c10.G
    $c01 = $bmp.GetPixel(0,1); Assert-Equal 0   $c01.A 'dot is transparent'
    $c11 = $bmp.GetPixel(1,1); Assert-Equal 255 $c11.R
    $bmp.Dispose()
}

Test-Case 'Get-FrameBitmap rejects unknown palette letter' {
    $grid = Read-Grid -Text "# size 1x1`nZ"
    $pal  = Read-Palette -Text "A FF0000"
    Assert-Throws { Get-FrameBitmap -Grid $grid -Palette $pal } "'Z'"
}
