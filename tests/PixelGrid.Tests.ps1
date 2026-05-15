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
