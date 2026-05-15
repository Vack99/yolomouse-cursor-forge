. "$PSScriptRoot\_TestHelper.ps1"
$forge = Join-Path $PSScriptRoot '..\forge.ps1'

Test-Case 'forge help prints command table' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $forge help 2>&1 | Out-String
    Assert-True ($out -match 'new')     'mentions new'
    Assert-True ($out -match 'build')   'mentions build'
    Assert-True ($out -match 'install') 'mentions install'
    Assert-True ($out -match 'reload')  'mentions reload'
}

Test-Case 'forge with no args prints help and exits 0' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $forge 2>&1 | Out-String
    Assert-True ($out -match 'new') 'help shown'
    Assert-Equal 0 $LASTEXITCODE 'exit code'
}

Test-Case 'forge new <Name> creates project from template' {
    $tmpRepo = New-TempDir
    try {
        # Mirror the relevant repo structure into the tempdir
        Copy-Item -Recurse "$PSScriptRoot\..\projects\_template" (Join-Path $tmpRepo 'projects\_template')
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new TestDot | Out-Null
            Assert-True (Test-Path 'projects\TestDot\design.md') 'design.md created'
            Assert-True (Test-Path 'projects\TestDot\frames\frame_00.grid.txt') 'frame 0 created'
            Assert-True (Test-Path 'projects\TestDot\frames\frame_07.grid.txt') 'frame 7 created (default 8 frames)'
            Assert-True (-not (Test-Path 'projects\TestDot\frames\frame_08.grid.txt')) 'no frame 8'
            $design = Get-Content -Raw 'projects\TestDot\design.md'
            Assert-True ($design -match 'TestDot') 'name substituted'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge new with -Frames 12 generates 12 grid files' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\projects\_template" (Join-Path $tmpRepo 'projects\_template')
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new Twelver -Frames 12 | Out-Null
            Assert-True (Test-Path 'projects\Twelver\frames\frame_11.grid.txt') 'frame 11 exists'
            Assert-True (-not (Test-Path 'projects\Twelver\frames\frame_12.grid.txt')) 'no frame 12'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge list shows project names and status columns' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\projects\_template" (Join-Path $tmpRepo 'projects\_template')
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new Alpha | Out-Null
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new Beta -Frames 12 | Out-Null
            $out = & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 list 2>&1 | Out-String
            Assert-True ($out -match 'Alpha') 'lists Alpha'
            Assert-True ($out -match 'Beta')  'lists Beta'
            Assert-True ($out -match '12')    'shows frame count'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge build produces .ani + Bundle.json + previews' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\projects\_template" (Join-Path $tmpRepo 'projects\_template')
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new Dot -Size 8 -Frames 8 | Out-Null
            # Provide a minimal palette and a single-pixel frame so build has something to compile
            Set-Content projects\Dot\palette.txt "A FF0000`r`nB 00FF00" -Encoding ascii
            $row = ('.' * 8)
            # Make frame 0 a single red pixel; rest stay all-dots
            $f0 = "# size 8x8`r`n# hotspot 4,4`r`n# delay 6`r`n" + (@($row,$row,$row,'....A...','...AA...',$row,$row,$row) -join "`r`n")
            Set-Content projects\Dot\frames\frame_00.grid.txt $f0 -Encoding ascii
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 build Dot 2>&1 | Out-Null
            Assert-True (Test-Path 'projects\Dot\build\Dot.ani') '.ani exists'
            Assert-True (Test-Path 'projects\Dot\build\Bundle.json') 'Bundle.json exists'
            Assert-True (Test-Path 'projects\Dot\build\Preview.png') 'Preview.png exists'
            Assert-True (Test-Path 'projects\Dot\build\preview.gif') 'preview.gif exists'
            Assert-True (Test-Path 'projects\Dot\build\preview_strip.png') 'preview_strip.png exists'
            $aniPath = Join-Path $tmpRepo 'projects\Dot\build\Dot.ani'
            $aniBytes = [System.IO.File]::ReadAllBytes($aniPath)
            $sig = -join ($aniBytes[0..3] | ForEach-Object { [char]$_ })
            Assert-Equal 'RIFF' $sig 'starts with RIFF'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}
