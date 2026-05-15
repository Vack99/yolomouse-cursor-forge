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
