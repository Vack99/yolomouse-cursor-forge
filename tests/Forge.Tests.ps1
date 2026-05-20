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

# ------ Helpers shared by the JSON-frame integration tests ------

function script:Initialize-JsonDot {
    # Lays down a JSON-frame project equivalent to the grid.txt Dot project:
    # an 8x8 frame_00 with a red 'A' dot at (4,3) and a small AA bar on row 4;
    # 7 trailing fully-transparent frames. Returns the absolute project dir.
    param([Parameter(Mandatory)][string]$RepoRoot, [string]$Name = 'JsonDot')
    $proj = Join-Path $RepoRoot "projects\$Name"
    New-Item -ItemType Directory -Path (Join-Path $proj 'frames') -Force | Out-Null
    @"
---
name: $Name
description: JSON-frame integration fixture
size: 8x8
frames: 8
default_delay: 6
default_hotspot: 4,4
---
"@ | Set-Content -Path (Join-Path $proj 'design.md') -Encoding utf8
    @'
{
  "version": 1,
  "colors": [
    { "index": 0, "rgba": "00000000" },
    { "index": 1, "rgba": "FF0000FF" },
    { "index": 2, "rgba": "00FF00FF" }
  ]
}
'@ | Set-Content -Path (Join-Path $proj 'palette.json') -Encoding utf8
    # Build frame_00 with the same pixel pattern as the grid.txt fixture above:
    #   row 3 = ....A...  -> pixel (4,3) = index 1
    #   row 4 = ...AA...  -> pixels (3,4) and (4,4) = index 1
    $zeros = ,0 * 8
    $pixels = @()
    for ($y = 0; $y -lt 8; $y++) {
        $row = ,0 * 8
        if ($y -eq 3) { $row[4] = 1 }
        if ($y -eq 4) { $row[3] = 1; $row[4] = 1 }
        $pixels += ,$row
    }
    $frame0 = @{
        version = 1
        width   = 8
        height  = 8
        hotspot = @{ x = 4; y = 4 }
        delay   = 6
        pixels  = $pixels
    } | ConvertTo-Json -Depth 6
    Set-Content -Path (Join-Path $proj 'frames\frame_00.json') -Value $frame0 -Encoding utf8
    # Frames 01..07 are fully transparent.
    $blank = @{
        version = 1
        width   = 8
        height  = 8
        hotspot = @{ x = 4; y = 4 }
        pixels  = @(,$zeros * 8)
    } | ConvertTo-Json -Depth 6
    for ($i = 1; $i -lt 8; $i++) {
        $name = 'frame_{0:D2}.json' -f $i
        Set-Content -Path (Join-Path $proj "frames\$name") -Value $blank -Encoding utf8
    }
    return $proj
}

Test-Case 'forge build accepts a JSON-frame project (palette.json + frames/*.json)' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Initialize-JsonDot -RepoRoot $tmpRepo -Name JsonDot | Out-Null
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 build JsonDot 2>&1 | Out-Null
            Assert-True (Test-Path 'projects\JsonDot\build\JsonDot.ani')      '.ani exists'
            Assert-True (Test-Path 'projects\JsonDot\build\Bundle.json')      'Bundle.json exists'
            Assert-True (Test-Path 'projects\JsonDot\build\Preview.png')      'Preview.png exists'
            Assert-True (Test-Path 'projects\JsonDot\build\preview.gif')      'preview.gif exists'
            Assert-True (Test-Path 'projects\JsonDot\build\preview_strip.png') 'preview_strip.png exists'
            $aniBytes = [System.IO.File]::ReadAllBytes((Join-Path $tmpRepo 'projects\JsonDot\build\JsonDot.ani'))
            $sig = -join ($aniBytes[0..3] | ForEach-Object { [char]$_ })
            Assert-Equal 'RIFF' $sig 'starts with RIFF'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge canvas-new scaffolds a studio-format project with BOM-less JSON' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 canvas-new SandboxDot -Size 32 2>&1 | Out-Null
            Assert-True (Test-Path 'projects\SandboxDot\palette.json')         'palette.json created'
            Assert-True (Test-Path 'projects\SandboxDot\frames\frame_00.json') 'frame_00.json created'
            # No UTF-8 BOM — the studio's JSON.parse rejects `﻿`. We
            # check the leading bytes directly because that is exactly the
            # failure mode (PS 5.1's `-Encoding utf8` writes a BOM).
            $palBytes = [System.IO.File]::ReadAllBytes((Join-Path $tmpRepo 'projects\SandboxDot\palette.json'))
            Assert-True ($palBytes[0] -ne 0xEF) 'palette.json has no UTF-8 BOM'
            $frameBytes = [System.IO.File]::ReadAllBytes((Join-Path $tmpRepo 'projects\SandboxDot\frames\frame_00.json'))
            Assert-True ($frameBytes[0] -ne 0xEF) 'frame_00.json has no UTF-8 BOM'
            # Round-trip through ConvertFrom-Json to prove the bytes really parse.
            $pal = Get-Content (Join-Path $tmpRepo 'projects\SandboxDot\palette.json') -Raw | ConvertFrom-Json
            Assert-Equal 1 $pal.version  'palette version 1'
            Assert-Equal 4 $pal.colors.Count 'palette has 4 starter colors'
            Assert-Equal '00000000' $pal.colors[0].rgba 'index 0 is transparent'
            $frm = Get-Content (Join-Path $tmpRepo 'projects\SandboxDot\frames\frame_00.json') -Raw | ConvertFrom-Json
            Assert-Equal 32 $frm.width   'frame width 32'
            Assert-Equal 32 $frm.height  'frame height 32'
            Assert-Equal 16 $frm.hotspot.x 'hotspot x at center'
            Assert-Equal 16 $frm.hotspot.y 'hotspot y at center'
            Assert-Equal 32 $frm.pixels.Count    '32 rows'
            Assert-Equal 32 $frm.pixels[0].Count '32 columns'
            Assert-Equal 0  $frm.pixels[0][0]    'all-zero pixels'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge canvas-new rejects path-traversal names and re-scaffolds of existing projects' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        Push-Location $tmpRepo
        try {
            # Invoke forge.ps1 in-process so we can try/catch the throws
            # directly. Going through `powershell -File` is brittle here:
            # the runner sets `$ErrorActionPreference = 'Stop'`, and in
            # PS 5.1 the child exe's stderr re-enters the parent host as
            # NativeCommandError records that re-throw into the test.
            $threw = $false
            try { & .\forge.ps1 canvas-new '../escape' | Out-Null } catch { $threw = $true }
            Assert-True $threw                                            'threw on bad name'
            Assert-True (-not (Test-Path 'projects\escape'))              'no escape dir created'
            # First scaffold succeeds, second on the same name fails.
            & .\forge.ps1 canvas-new Existing | Out-Null
            Assert-True (Test-Path 'projects\Existing\palette.json')      'palette created'
            $threw = $false
            try { & .\forge.ps1 canvas-new Existing | Out-Null } catch { $threw = $true }
            Assert-True $threw                                            'threw on duplicate'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}

Test-Case 'forge build: JSON-frame project and equivalent grid.txt project produce identical bitmaps' {
    $tmpRepo = New-TempDir
    try {
        Copy-Item -Recurse "$PSScriptRoot\..\projects\_template" (Join-Path $tmpRepo 'projects\_template')
        Copy-Item -Recurse "$PSScriptRoot\..\lib" (Join-Path $tmpRepo 'lib')
        Copy-Item "$PSScriptRoot\..\forge.ps1" (Join-Path $tmpRepo 'forge.ps1')
        # grid.txt twin — same shape as the JSON fixture above (one red pixel + 2-px bar).
        Push-Location $tmpRepo
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 new GridDot -Size 8 -Frames 8 | Out-Null
            Set-Content projects\GridDot\palette.txt "A FF0000`r`nB 00FF00" -Encoding ascii
            $row = ('.' * 8)
            $f0 = "# size 8x8`r`n# hotspot 4,4`r`n# delay 6`r`n" + (@($row,$row,$row,'....A...','...AA...',$row,$row,$row) -join "`r`n")
            Set-Content projects\GridDot\frames\frame_00.grid.txt $f0 -Encoding ascii
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 build GridDot 2>&1 | Out-Null

            Initialize-JsonDot -RepoRoot $tmpRepo -Name JsonDot | Out-Null
            & powershell -NoProfile -ExecutionPolicy Bypass -File .\forge.ps1 build JsonDot 2>&1 | Out-Null

            # Each build emits build\frames\frame_NN.png — deterministic PNGs of
            # identical RGBA pixels round-trip to identical bytes.
            for ($i = 0; $i -lt 8; $i++) {
                $name = 'frame_{0:D2}.png' -f $i
                $g = [System.IO.File]::ReadAllBytes((Join-Path $tmpRepo "projects\GridDot\build\frames\$name"))
                $j = [System.IO.File]::ReadAllBytes((Join-Path $tmpRepo "projects\JsonDot\build\frames\$name"))
                Assert-BytesEqual $g $j "frame $i bytes differ between grid.txt and JSON builds"
            }
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}
