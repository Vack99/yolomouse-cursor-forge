#requires -Version 5.1
<#
forge.ps1 — YoloMouse Cursor Forge CLI

Verbs: new, build, preview, install, uninstall, reload, list, help

See docs\specs\2026-05-14-cursor-forge-design.md for the full design.
#>
[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0)][string]$Verb,
    [Parameter(Position=1)][string]$Name,
    [int]$Frames,
    [int]$Size,
    [int]$Port,
    [switch]$NoBrowser,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Script:RepoRoot      = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Script:YoloMouseRoot = 'C:\Program Files (x86)\Steam\steamapps\common\YoloMouse'

. (Join-Path $Script:RepoRoot 'lib\PixelGrid.ps1')
. (Join-Path $Script:RepoRoot 'lib\CurWriter.ps1')
. (Join-Path $Script:RepoRoot 'lib\AniWriter.ps1')
. (Join-Path $Script:RepoRoot 'lib\GifWriter.ps1')
. (Join-Path $Script:RepoRoot 'lib\BundleWriter.ps1')

function Show-Help {
    @"
forge.ps1 — YoloMouse Cursor Forge

Usage: .\forge.ps1 <verb> [args]

  new      <Name> [-Frames 8|12|24] [-Size 64]   Scaffold a new project from _template
  build    <Name>                                Compile grids -> .ani + previews
  canvas   <Name> [-Port 5174] [-NoBrowser]      Launch Cursor Studio in the browser
  canvas-select <Name> [-Port 5174]              Switch a running Cursor Studio to <Name>
  canvas-stage [-Port 5174]                      Print the active project + stage (where 'generate more' would land)
  preview  <Name>                                Open preview.gif and preview_strip.png
  install  <Name>                                Copy bundle into YoloMouse\Cursors\<Name>
  uninstall <Name> [-Force]                      Remove bundle from YoloMouse
  reload                                         Kill + restart YoloLauncher.exe
  list                                           Show all projects + status
  help                                           This message

YoloMouse root: $($Script:YoloMouseRoot)
Repo root:      $($Script:RepoRoot)
"@
}

function Invoke-New {
    param([string]$Name, [int]$Frames = 8, [int]$Size = 64)
    if (-not $Name) { throw "forge new: <Name> is required" }
    if ($Frames -notin 8,12,24) { throw "forge new: -Frames must be 8, 12, or 24 (got $Frames)" }
    $projDir = Join-Path $Script:RepoRoot "projects\$Name"
    if (Test-Path $projDir) { throw "forge new: '$Name' already exists at $projDir" }
    $template = Join-Path $Script:RepoRoot 'projects\_template'
    if (-not (Test-Path $template)) { throw "forge new: template not found at $template" }

    Copy-Item -Recurse $template $projDir
    # Substitute {{Name}}
    foreach ($f in 'brief.md','design.md') {
        $p = Join-Path $projDir $f
        if (Test-Path $p) {
            (Get-Content -Raw $p).Replace('{{Name}}', $Name) | Set-Content $p -Encoding utf8
        }
    }
    # Update design.md front-matter size/frames
    $designPath = Join-Path $projDir 'design.md'
    $design = Get-Content -Raw $designPath
    $design = $design -replace 'size:\s*\d+x\d+', "size: ${Size}x${Size}"
    $design = $design -replace 'frames:\s*\d+', "frames: $Frames"
    $center = [int]([math]::Floor($Size/2))
    $design = $design -replace 'default_hotspot:\s*\d+,\d+', "default_hotspot: $center,$center"
    Set-Content $designPath $design -Encoding utf8

    # Regenerate grid files at the requested size and count
    $framesDir = Join-Path $projDir 'frames'
    Get-ChildItem $framesDir -Filter '*.grid.txt' | Remove-Item -Force
    $row = ('.' * $Size)
    $body = (@(
        "# size ${Size}x${Size}"
        "# hotspot $center,$center"
        "# delay 6"
    ) + (1..$Size | ForEach-Object { $row })) -join "`r`n"
    for ($i = 0; $i -lt $Frames; $i++) {
        $fname = 'frame_{0:D2}.grid.txt' -f $i
        Set-Content (Join-Path $framesDir $fname) $body -Encoding ascii
    }
    Write-Host "Created projects\$Name with $Frames frames at ${Size}x${Size}." -ForegroundColor Green
}

function Invoke-Build {
    param([Parameter(Mandatory)][string]$Name)
    $projDir = Join-Path $Script:RepoRoot "projects\$Name"
    if (-not (Test-Path $projDir)) { throw "forge build: project '$Name' not found at $projDir" }
    $designPath     = Join-Path $projDir 'design.md'
    $paletteTxtPath = Join-Path $projDir 'palette.txt'
    $paletteJsonPath= Join-Path $projDir 'palette.json'
    $framesDir      = Join-Path $projDir 'frames'
    $buildDir       = Join-Path $projDir 'build'
    if (-not (Test-Path $designPath)) { throw "forge build: missing $designPath" }
    $design = Read-DesignFrontMatter -Path $designPath

    $pngFiles  = @(Get-ChildItem $framesDir -Filter 'frame_*.png'      -ErrorAction SilentlyContinue | Sort-Object Name)
    $gridFiles = @(Get-ChildItem $framesDir -Filter '*.grid.txt'       -ErrorAction SilentlyContinue | Sort-Object Name)
    $jsonFiles = @(Get-ChildItem $framesDir -Filter 'frame_*.json'     -ErrorAction SilentlyContinue | Sort-Object Name)

    # Each project authors in exactly one format. Mixing is ambiguous (e.g. which
    # frame_00 wins?) so fail fast instead of guessing.
    $modes = @()
    if ($pngFiles.Count  -gt 0) { $modes += 'PNG' }
    if ($gridFiles.Count -gt 0) { $modes += 'grid.txt' }
    if ($jsonFiles.Count -gt 0) { $modes += 'JSON' }
    if ($modes.Count -gt 1) {
        throw "forge build: $framesDir contains mixed frame formats ($($modes -join ', ')). Use one."
    }

    $bitmaps = @()
    $delays  = @()
    $hotspot = $design.DefaultHotspot

    if ($pngFiles.Count -gt 0) {
        # PNG frame mode: frames are pre-rendered bitmaps (e.g. from a project
        # generator that does its own anti-aliasing). No grid/palette involved.
        foreach ($pf in $pngFiles) {
            $loaded = [System.Drawing.Bitmap]::FromFile($pf.FullName)
            $w = $loaded.Width; $h = $loaded.Height
            if ($w -ne $design.Width -or $h -ne $design.Height) {
                $loaded.Dispose()
                throw "$($pf.Name): size ${w}x${h} != project size $($design.Width)x$($design.Height)"
            }
            # FromFile holds a file lock; clone to a standalone bitmap and release.
            $bitmaps += New-Object System.Drawing.Bitmap($loaded)
            $loaded.Dispose()
            $delays  += $design.DefaultDelay
        }
    } elseif ($gridFiles.Count -gt 0 -or $jsonFiles.Count -gt 0) {
        # Pick the parser + palette pair for whichever authoring format is present.
        if ($jsonFiles.Count -gt 0) {
            if (-not (Test-Path $paletteJsonPath)) { throw "forge build: missing $paletteJsonPath" }
            $frameFiles = $jsonFiles
            $readFrame  = Get-Command Read-JsonFrame
            $palette    = Read-PaletteJson -Path $paletteJsonPath
        } else {
            if (-not (Test-Path $paletteTxtPath)) { throw "forge build: missing $paletteTxtPath" }
            $frameFiles = $gridFiles
            $readFrame  = Get-Command Read-Grid
            $palette    = Read-Palette -Path $paletteTxtPath
        }
        $firstHotspotOverride = $null
        for ($i = 0; $i -lt $frameFiles.Count; $i++) {
            $g = & $readFrame -Path $frameFiles[$i].FullName
            if ($g.Width -ne $design.Width -or $g.Height -ne $design.Height) {
                throw "$($frameFiles[$i].Name): size $($g.Width)x$($g.Height) != project size $($design.Width)x$($design.Height)"
            }
            try {
                $bmp = Get-FrameBitmap -Grid $g -Palette $palette
            } catch {
                throw "$($frameFiles[$i].Name): $($_.Exception.Message)"
            }
            $bitmaps += $bmp
            $delays  += if ($g.Delay) { $g.Delay } else { $design.DefaultDelay }
            if ($i -eq 0 -and $g.Hotspot) { $firstHotspotOverride = $g.Hotspot }
            if ($i -gt 0 -and $g.Hotspot) {
                Write-Warning "$($frameFiles[$i].Name): per-frame hotspot ignored (Windows .ani uses frame_00's hotspot for all frames)"
            }
        }
        if ($firstHotspotOverride) { $hotspot = $firstHotspotOverride }
    } else {
        throw "forge build: no frame_*.png, frame_*.json, or frame_*.grid.txt files in $framesDir"
    }

    if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
    New-Item -ItemType Directory -Path $buildDir | Out-Null

    $desc = if ($design.Description) { $design.Description } else { $Name }

    Save-FramePngs -OutDir $buildDir -Bitmaps $bitmaps
    Save-AniFile  -Path (Join-Path $buildDir "$Name.ani") -Bitmaps $bitmaps -HotspotX $hotspot.X -HotspotY $hotspot.Y -DefaultDelay $design.DefaultDelay -PerFrameDelays $delays
    Save-Bundle   -OutDir $buildDir -Name $Name -Description $desc
    Save-PreviewStrip -Path (Join-Path $buildDir 'preview_strip.png') -Bitmaps $bitmaps
    Save-GifFile  -Path (Join-Path $buildDir 'preview.gif') -Bitmaps $bitmaps -PerFrameDelaysJiffies $delays

    $totalCs = ($delays | Measure-Object -Sum).Sum * 100.0 / 60.0
    Write-Host ("Built {0}: {1} frames, ~{2:N0}ms loop" -f $Name, $bitmaps.Count, $totalCs) -ForegroundColor Green
    Write-Host "  -> $buildDir"

    foreach ($b in $bitmaps) { $b.Dispose() }
}

function Invoke-Reload {
    $running = Get-Process -Name YoloLauncher,YoloMouse -ErrorAction SilentlyContinue
    foreach ($p in $running) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }
        catch { Write-Warning "could not stop $($p.Name) (PID $($p.Id)): $($_.Exception.Message). If YoloMouse is elevated, exit it from the tray and re-run." }
    }
    $exe = Join-Path $Script:YoloMouseRoot 'YoloLauncher.exe'
    if (-not (Test-Path $exe)) { throw "forge reload: $exe not found" }
    Start-Process -FilePath $exe
    Write-Host "Started YoloLauncher." -ForegroundColor Green
}

function Invoke-Install {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Test-Path $Script:YoloMouseRoot)) {
        throw "forge install: YoloMouse not found at $($Script:YoloMouseRoot)"
    }
    $buildDir = Join-Path $Script:RepoRoot "projects\$Name\build"
    if (-not (Test-Path $buildDir)) { throw "forge install: '$Name' has no build/. Run 'forge build $Name' first." }
    $dest = Join-Path $Script:YoloMouseRoot "Cursors\$Name"
    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    foreach ($f in "$Name.ani", 'Bundle.json', 'Preview.png') {
        $src = Join-Path $buildDir $f
        if (-not (Test-Path $src)) { throw "forge install: missing $src" }
        Copy-Item -Force $src $dest
    }
    Write-Host "Installed $Name to $dest" -ForegroundColor Green
}

function Invoke-Uninstall {
    param([Parameter(Mandatory)][string]$Name, [switch]$Force)
    $dir = Join-Path $Script:YoloMouseRoot "Cursors\$Name"
    if (-not (Test-Path $dir)) { Write-Host "forge uninstall: '$Name' not installed (no $dir)"; return }
    if (-not $Force) {
        Write-Host "Would delete: $dir" -ForegroundColor Yellow
        Write-Host "Re-run with -Force to actually remove."
        return
    }
    Remove-Item -Recurse -Force $dir
    Write-Host "Removed $dir" -ForegroundColor Green
}

function Invoke-Preview {
    param([Parameter(Mandatory)][string]$Name)
    $buildDir = Join-Path $Script:RepoRoot "projects\$Name\build"
    if (-not (Test-Path $buildDir)) { throw "forge preview: '$Name' has no build/. Run 'forge build $Name' first." }
    foreach ($f in 'preview.gif','preview_strip.png') {
        $p = Join-Path $buildDir $f
        if (Test-Path $p) { Start-Process $p } else { Write-Warning "missing $p" }
    }
}

function Invoke-List {
    $projectsDir = Join-Path $Script:RepoRoot 'projects'
    if (-not (Test-Path $projectsDir)) { Write-Host '(no projects yet)'; return }
    $rows = @()
    Get-ChildItem $projectsDir -Directory | Where-Object { $_.Name -ne '_template' } | ForEach-Object {
        $framesPath = Join-Path $_.FullName 'frames'
        $frameCount = (Get-ChildItem $framesPath -Filter '*.grid.txt' -ErrorAction SilentlyContinue).Count
        if ($frameCount -eq 0) {
            $frameCount = (Get-ChildItem $framesPath -Filter 'frame_*.png' -ErrorAction SilentlyContinue).Count
        }
        if ($frameCount -eq 0) {
            $frameCount = (Get-ChildItem $framesPath -Filter 'frame_*.json' -ErrorAction SilentlyContinue).Count
        }
        $built = Test-Path (Join-Path $_.FullName "build\$($_.Name).ani")
        $installed = Test-Path (Join-Path $Script:YoloMouseRoot "Cursors\$($_.Name)")
        $rows += [pscustomobject]@{
            Name      = $_.Name
            Frames    = $frameCount
            Built     = if ($built) { 'yes' } else { 'no' }
            Installed = if ($installed) { 'yes' } else { 'no' }
        }
    }
    $rows | Format-Table -AutoSize | Out-Host
}

function Invoke-Canvas {
    param(
        [Parameter(Mandatory)][string]$Name,
        [int]$Port = 5174,
        [switch]$NoBrowser
    )
    $projDir = Join-Path $Script:RepoRoot "projects\$Name"
    if (-not (Test-Path $projDir)) { throw "forge canvas: project '$Name' not found at $projDir" }
    $studioDir = Join-Path $Script:RepoRoot 'studio'
    if (-not (Test-Path $studioDir)) { throw "forge canvas: studio/ not found at $studioDir" }

    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { throw "forge canvas: 'node' not found on PATH. Install Node.js 20+." }
    $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
    if (-not $pnpm) { throw "forge canvas: 'pnpm' not found on PATH. Install pnpm: https://pnpm.io/installation. This repo never uses npm." }

    $nodeModules = Join-Path $studioDir 'node_modules'
    if (-not (Test-Path $nodeModules)) {
        Write-Host "studio: installing pnpm dependencies (one-time)…" -ForegroundColor Cyan
        & $pnpm.Source --dir $studioDir install
        if ($LASTEXITCODE -ne 0) { throw "forge canvas: pnpm install failed (exit $LASTEXITCODE)" }
    }
    $distDir = Join-Path $studioDir 'dist'
    if (-not (Test-Path (Join-Path $distDir 'index.html'))) {
        Write-Host "studio: building frontend bundle…" -ForegroundColor Cyan
        & $pnpm.Source --dir $studioDir run build
        if ($LASTEXITCODE -ne 0) { throw "forge canvas: frontend build failed (exit $LASTEXITCODE)" }
    }

    $url = "http://127.0.0.1:$Port/"
    if (-not $NoBrowser) {
        # Open the browser slightly after the server starts so the page loads
        # immediately rather than landing on a connection-refused error.
        Start-Job -ScriptBlock {
            param($u)
            Start-Sleep -Milliseconds 900
            Start-Process $u
        } -ArgumentList $url | Out-Null
    }

    Write-Host "studio: launching for project '$Name' at $url (Ctrl+C to stop)" -ForegroundColor Green
    # Hand off to tsx via pnpm exec. This call blocks until the user Ctrl+Cs.
    $repoRootArg = $Script:RepoRoot
    $mainTs      = Join-Path $studioDir 'src\server\main.ts'
    & $pnpm.Source --dir $studioDir exec tsx $mainTs --project $Name --repo-root $repoRootArg --port $Port --dist $distDir
}

function Invoke-CanvasSelect {
    param(
        [Parameter(Mandatory)][string]$Name,
        [int]$Port = 5174
    )
    # Hits the running studio server's POST /api/active-project endpoint so
    # Claude can switch the canvas's project from the terminal without
    # restarting it. Fails loudly if the server is not running.
    $projDir = Join-Path $Script:RepoRoot "projects\$Name"
    if (-not (Test-Path $projDir)) { throw "forge canvas-select: project '$Name' not found at $projDir" }
    $body = (@{ name = $Name } | ConvertTo-Json -Compress)
    $uri  = "http://127.0.0.1:$Port/api/active-project"
    try {
        $resp = Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' -Body $body
    } catch {
        throw "forge canvas-select: could not reach studio at $uri - is 'forge canvas' running? ($($_.Exception.Message))"
    }
    Write-Host "studio: active project is now '$($resp.name)'" -ForegroundColor Green
}

function Invoke-CanvasStage {
    param([int]$Port = 5174)
    # Hits the running studio server's GET /api/active-stage endpoint so
    # Claude can ask where a "generate 4 more candidates" call would land
    # before authoring more frames. Pure read — no state mutated.
    $uri = "http://127.0.0.1:$Port/api/active-stage"
    try {
        $resp = Invoke-RestMethod -Uri $uri -Method Get
    } catch {
        throw "forge canvas-stage: could not reach studio at $uri - is 'forge canvas' running? ($($_.Exception.Message))"
    }
    # Two-line output: human readable header + a machine-parseable
    # 'project=<x> stage=<y>' line so scripts (and Claude's grep) can
    # consume it without an extra JSON parse.
    Write-Host "studio: active project '$($resp.project)' is in stage '$($resp.stage)'" -ForegroundColor Green
    Write-Output ("project={0} stage={1}" -f $resp.project, $resp.stage)
}

switch ($Verb) {
    'reload' { Invoke-Reload; exit 0 }
    'install' {
        if (-not $Name) { throw 'forge install: <Name> is required' }
        Invoke-Install -Name $Name
        exit 0
    }
    'uninstall' {
        if (-not $Name) { throw 'forge uninstall: <Name> is required' }
        Invoke-Uninstall -Name $Name -Force:$Force
        exit 0
    }
    'preview' {
        if (-not $Name) { throw 'forge preview: <Name> is required' }
        Invoke-Preview -Name $Name
        exit 0
    }
    'build' {
        if (-not $Name) { throw 'forge build: <Name> is required' }
        Invoke-Build -Name $Name
        exit 0
    }
    'list' { Invoke-List; exit 0 }
    'canvas' {
        if (-not $Name) { throw 'forge canvas: <Name> is required' }
        $p = if ($PSBoundParameters.ContainsKey('Port')) { $Port } else { 5174 }
        Invoke-Canvas -Name $Name -Port $p -NoBrowser:$NoBrowser
        exit 0
    }
    'canvas-select' {
        if (-not $Name) { throw 'forge canvas-select: <Name> is required' }
        $p = if ($PSBoundParameters.ContainsKey('Port')) { $Port } else { 5174 }
        Invoke-CanvasSelect -Name $Name -Port $p
        exit 0
    }
    'canvas-stage' {
        $p = if ($PSBoundParameters.ContainsKey('Port')) { $Port } else { 5174 }
        Invoke-CanvasStage -Port $p
        exit 0
    }
    'new' {
        $f = if ($PSBoundParameters.ContainsKey('Frames')) { $Frames } else { 8 }
        $s = if ($PSBoundParameters.ContainsKey('Size'))   { $Size }   else { 64 }
        Invoke-New -Name $Name -Frames $f -Size $s
        exit 0
    }
    ''     { Show-Help; exit 0 }
    'help' { Show-Help; exit 0 }
    default {
        Write-Host "forge: unknown verb '$Verb'" -ForegroundColor Red
        Show-Help
        exit 1
    }
}
