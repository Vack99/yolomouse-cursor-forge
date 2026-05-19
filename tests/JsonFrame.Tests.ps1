. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
Add-Type -AssemblyName System.Drawing

# ---------- Read-JsonFrame ----------

Test-Case 'Read-JsonFrame parses width, height, and 2D palette-index array' {
    $body = @'
{
  "version": 1,
  "width": 3,
  "height": 2,
  "hotspot": { "x": 1, "y": 0 },
  "pixels": [
    [0, 1, 2],
    [2, 1, 0]
  ]
}
'@
    $g = Read-JsonFrame -Text $body
    Assert-Equal 3 $g.Width
    Assert-Equal 2 $g.Height
    Assert-Equal 1 $g.Hotspot.X
    Assert-Equal 0 $g.Hotspot.Y
    Assert-Equal 2 $g.Pixels.Count        'row count'
    Assert-Equal 3 $g.Pixels[0].Count     'col count row 0'
    Assert-Equal 0 $g.Pixels[0][0]
    Assert-Equal 1 $g.Pixels[0][1]
    Assert-Equal 2 $g.Pixels[1][0]
    Assert-Equal 0 $g.Pixels[1][2]
}

Test-Case 'Read-JsonFrame parses optional delay header' {
    $body = '{ "version": 1, "width": 1, "height": 1, "delay": 12, "pixels": [[0]] }'
    $g = Read-JsonFrame -Text $body
    Assert-Equal 12 $g.Delay
}

Test-Case 'Read-JsonFrame defaults hotspot to center when omitted' {
    $body = '{ "version": 1, "width": 4, "height": 4, "pixels": [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]] }'
    $g = Read-JsonFrame -Text $body
    Assert-Equal 2 $g.Hotspot.X
    Assert-Equal 2 $g.Hotspot.Y
}

Test-Case 'Read-JsonFrame rejects wrong row count' {
    Assert-Throws { Read-JsonFrame -Text '{ "version":1, "width":2, "height":3, "pixels":[[0,0],[0,0]] }' } 'rows'
}

Test-Case 'Read-JsonFrame rejects wrong column count' {
    Assert-Throws { Read-JsonFrame -Text '{ "version":1, "width":3, "height":2, "pixels":[[0,0,0],[0,0]] }' } 'columns'
}

Test-Case 'Read-JsonFrame rejects negative palette index' {
    Assert-Throws { Read-JsonFrame -Text '{ "version":1, "width":1, "height":1, "pixels":[[-1]] }' } 'non-negative'
}

Test-Case 'Read-JsonFrame rejects missing width/height' {
    Assert-Throws { Read-JsonFrame -Text '{ "version":1, "pixels":[[0]] }' } 'width'
}

# ---------- Read-PaletteJson ----------

Test-Case 'Read-PaletteJson parses palette.json into int-keyed color map' {
    $body = @'
{
  "version": 1,
  "colors": [
    { "index": 0, "rgba": "00000000" },
    { "index": 1, "rgba": "FF0000FF" },
    { "index": 2, "rgba": "1A1A1A80" }
  ]
}
'@
    $p = Read-PaletteJson -Text $body
    Assert-Equal 3 $p.Count
    $c1 = $p[1]
    Assert-Equal 0xFF $c1.A
    Assert-Equal 0xFF $c1.R
    $c2 = $p[2]
    Assert-Equal 0x80 $c2.A
    Assert-Equal 0x1A $c2.R
    $c0 = $p[0]
    Assert-Equal 0 $c0.A 'index 0 is transparent'
}

Test-Case 'Read-PaletteJson accepts 6-char rgba and defaults alpha to FF' {
    $p = Read-PaletteJson -Text '{ "version":1, "colors":[{ "index":5, "rgba":"FF6B6B" }] }'
    Assert-Equal 0xFF $p[5].A
    Assert-Equal 0xFF $p[5].R
    Assert-Equal 0x6B $p[5].G
}

Test-Case 'Read-PaletteJson rejects invalid hex' {
    Assert-Throws { Read-PaletteJson -Text '{ "version":1, "colors":[{ "index":1, "rgba":"NOTHEX" }] }' } 'hex'
}

# ---------- Get-FrameBitmap dispatches on Pixels ----------

Test-Case 'Get-FrameBitmap renders a JSON pixel grid via int-keyed palette' {
    $grid = Read-JsonFrame -Text '{ "version":1, "width":2, "height":2, "pixels":[[1,2],[0,1]] }'
    $pal  = Read-PaletteJson -Text @'
{ "version":1, "colors":[
  { "index": 0, "rgba": "00000000" },
  { "index": 1, "rgba": "FF0000FF" },
  { "index": 2, "rgba": "00FF00FF" }
] }
'@
    $bmp = Get-FrameBitmap -Grid $grid -Palette $pal
    Assert-Equal 2 $bmp.Width
    Assert-Equal 2 $bmp.Height
    $c00 = $bmp.GetPixel(0,0); Assert-Equal 255 $c00.R; Assert-Equal 255 $c00.A
    $c10 = $bmp.GetPixel(1,0); Assert-Equal 255 $c10.G
    $c01 = $bmp.GetPixel(0,1); Assert-Equal 0   $c01.A 'index 0 is transparent'
    $c11 = $bmp.GetPixel(1,1); Assert-Equal 255 $c11.R
    $bmp.Dispose()
}

Test-Case 'Get-FrameBitmap rejects unknown palette index for JSON grids' {
    $grid = Read-JsonFrame -Text '{ "version":1, "width":1, "height":1, "pixels":[[7]] }'
    $pal  = Read-PaletteJson -Text '{ "version":1, "colors":[{ "index":0, "rgba":"00000000" }] }'
    Assert-Throws { Get-FrameBitmap -Grid $grid -Palette $pal } '7'
}

# ---------- Parity with the grid.txt path ----------

Test-Case 'JSON grid and equivalent grid.txt produce identical bitmaps' {
    # Same 3x3 shape via both authoring formats.
    $jsonText = @'
{
  "version": 1,
  "width": 3,
  "height": 3,
  "hotspot": { "x": 1, "y": 1 },
  "pixels": [
    [0, 1, 0],
    [1, 2, 1],
    [0, 1, 0]
  ]
}
'@
    $jsonPal = @'
{ "version":1, "colors":[
  { "index": 0, "rgba": "00000000" },
  { "index": 1, "rgba": "FF6B6BFF" },
  { "index": 2, "rgba": "1A1A1AFF" }
] }
'@
    $txtBody = @"
# size 3x3
# hotspot 1,1
.A.
ABA
.A.
"@
    $txtPal = "A FF6B6B`nB 1A1A1A"

    $jg = Read-JsonFrame -Text $jsonText
    $jp = Read-PaletteJson -Text $jsonPal
    $jb = Get-FrameBitmap -Grid $jg -Palette $jp

    $tg = Read-Grid -Text $txtBody
    $tp = Read-Palette -Text $txtPal
    $tb = Get-FrameBitmap -Grid $tg -Palette $tp

    Assert-Equal $tb.Width  $jb.Width
    Assert-Equal $tb.Height $jb.Height
    for ($y = 0; $y -lt $tb.Height; $y++) {
        for ($x = 0; $x -lt $tb.Width; $x++) {
            $a = $tb.GetPixel($x,$y); $b = $jb.GetPixel($x,$y)
            Assert-Equal $a.A $b.A "alpha at ($x,$y)"
            Assert-Equal $a.R $b.R "red at ($x,$y)"
            Assert-Equal $a.G $b.G "green at ($x,$y)"
            Assert-Equal $a.B $b.B "blue at ($x,$y)"
        }
    }
    $jb.Dispose(); $tb.Dispose()
}
