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
    $designPath  = Join-Path $projDir 'design.md'
    $palettePath = Join-Path $projDir 'palette.txt'
    $framesDir   = Join-Path $projDir 'frames'
    $buildDir    = Join-Path $projDir 'build'
    foreach ($p in $designPath, $palettePath) {
        if (-not (Test-Path $p)) { throw "forge build: missing $p" }
    }
    $design  = Read-DesignFrontMatter -Path $designPath
    $palette = Read-Palette -Path $palettePath
    $gridFiles = @(Get-ChildItem $framesDir -Filter '*.grid.txt' | Sort-Object Name)
    if ($gridFiles.Count -eq 0) { throw "forge build: no frame_*.grid.txt files in $framesDir" }

    $bitmaps = @()
    $delays  = @()
    $hotspot = $design.DefaultHotspot
    $firstHotspotOverride = $null
    for ($i = 0; $i -lt $gridFiles.Count; $i++) {
        $g = Read-Grid -Path $gridFiles[$i].FullName
        if ($g.Width -ne $design.Width -or $g.Height -ne $design.Height) {
            throw "$($gridFiles[$i].Name): size $($g.Width)x$($g.Height) != project size $($design.Width)x$($design.Height)"
        }
        try {
            $bmp = Get-FrameBitmap -Grid $g -Palette $palette
        } catch {
            throw "$($gridFiles[$i].Name): $($_.Exception.Message)"
        }
        $bitmaps += $bmp
        $delays  += if ($g.Delay) { $g.Delay } else { $design.DefaultDelay }
        if ($i -eq 0 -and $g.Hotspot) { $firstHotspotOverride = $g.Hotspot }
        if ($i -gt 0 -and $g.Hotspot) {
            Write-Warning "$($gridFiles[$i].Name): per-frame hotspot ignored (Windows .ani uses frame_00's hotspot for all frames)"
        }
    }
    if ($firstHotspotOverride) { $hotspot = $firstHotspotOverride }

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
        $frameCount = (Get-ChildItem (Join-Path $_.FullName 'frames') -Filter '*.grid.txt' -ErrorAction SilentlyContinue).Count
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

switch ($Verb) {
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
