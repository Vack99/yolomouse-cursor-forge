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

switch ($Verb) {
    ''     { Show-Help; exit 0 }
    'help' { Show-Help; exit 0 }
    default {
        Write-Host "forge: unknown verb '$Verb'" -ForegroundColor Red
        Show-Help
        exit 1
    }
}
