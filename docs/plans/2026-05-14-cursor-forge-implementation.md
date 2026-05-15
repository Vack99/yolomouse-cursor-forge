# Cursor Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PowerShell tooling described in `docs/specs/2026-05-14-cursor-forge-design.md` — a `forge.ps1` CLI that scaffolds, builds, previews, and installs animated YoloMouse cursors from text-grid frame art.

**Architecture:** Single PowerShell 5.1 + .NET stack. `forge.ps1` is a thin verb dispatcher. Five `lib/*.ps1` modules each own one concern (parsing, .cur bytes, .ani bytes, GIF preview, bundle writing). All binary writers are pure functions returning `byte[]` so they can be tested without touching disk. A custom dot-sourced test helper (`tests/_TestHelper.ps1`) replaces Pester to dodge the v3-vs-v5 syntax split that ships inconsistently on Windows.

**Tech Stack:** Windows PowerShell 5.1, .NET `System.Drawing`, .NET `System.IO.BinaryWriter`, zero external dependencies. No Python, no pip, no PSGallery installs. Spec sections referenced throughout as §N.

---

## File Structure

**Created:**
- `.gitignore` — excludes `projects/*/build/` and OS noise
- `README.md` — quickstart, command table, link to spec
- `forge.ps1` — CLI verb dispatcher (new, build, preview, install, uninstall, reload, list, help)
- `lib/PixelGrid.ps1` — `Read-Palette`, `Read-Grid`, `Read-DesignFrontMatter`, `Get-FrameBitmap`
- `lib/CurWriter.ps1` — `Get-CurBytes` (single-image RGBA .cur)
- `lib/AniWriter.ps1` — `Get-AniBytes`, `Save-AniFile` (RIFF/ACON wrapper using CurWriter)
- `lib/GifWriter.ps1` — `Save-GifFile` (multi-frame GIF via `System.Drawing` SaveAdd + PropertyItem)
- `lib/BundleWriter.ps1` — `Save-Bundle`, `Save-PreviewStrip`
- `projects/_template/{brief.md,design.md,palette.txt,frames/frame_00.grid.txt}`
- `library/palettes/{classic_8bit,neon_synthwave,pastel_dream,monochrome_terminal}.txt`
- `tests/_TestHelper.ps1` — assertion helpers + tempdir helpers
- `tests/Run-Tests.ps1` — dot-sources every `*.Tests.ps1` in the directory
- `tests/PixelGrid.Tests.ps1`, `tests/CurWriter.Tests.ps1`, `tests/AniWriter.Tests.ps1`, `tests/BundleWriter.Tests.ps1`, `tests/Forge.Tests.ps1`

**Files-that-change-together rule:** Each `lib/*.ps1` ships with its sibling `tests/*.Tests.ps1`. `forge.ps1` keeps verbs as small functions calling into `lib/`; if any verb body grows past ~30 lines, extract into the relevant lib instead.

---

## Conventions used throughout this plan

- **Test runner:** `powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1`. Exit code 0 = green, 1 = at least one failure.
- **Working directory:** repo root (`C:\Users\Aaron\Documents\Repos\yolomouse-cursor-forge\`). All paths in commands are relative to it.
- **TDD discipline:** write failing test → run → see fail → implement minimal → run → see pass → commit. Binary-writer tests assert on specific byte offsets in the output, not whole-file equality, so they fail with precise diagnostics.
- **Commit messages:** match existing tone (lowercase type prefix + terse "why", no trailing period). Examples: `feat: add palette parser`, `feat: write .ani RIFF wrapper`, `fix: emit AND mask zeros for 32bpp cursors`.
- **PowerShell encoding:** use `Out-File -Encoding utf8` or `Set-Content -Encoding utf8` when writing files other tools read. ASCII is fine for the binary writers (raw byte arrays bypass encoding entirely).

---

## Phase 1 — Repo scaffolding

### Task 1.1: `.gitignore`

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Write `.gitignore`**

```
# Build outputs (per project)
projects/*/build/

# OS junk
Thumbs.db
.DS_Store
desktop.ini

# Editor noise
*.swp
*~
.vs/
.vscode/

# PowerShell transcript noise
*.transcript
```

- [ ] **Step 2: Verify it works**

Run: `git status` — should still be clean. Then create a dummy `projects/Test/build/dummy.txt` and re-run `git status` — should still be clean.

```powershell
New-Item -ItemType Directory -Path projects\Test\build -Force | Out-Null
Set-Content projects\Test\build\dummy.txt 'ignored'
git status --porcelain
```

Expected output: only `?? .gitignore` (the new gitignore itself).

- [ ] **Step 3: Clean up the dummy and commit**

```powershell
Remove-Item -Recurse -Force projects\Test
git add .gitignore
git commit -m "chore: ignore per-project build outputs and OS noise"
```

---

### Task 1.2: `README.md`

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# yolomouse-cursor-forge

A collaborative pixel-art workshop for designing custom animated cursors for [YoloMouse](https://dragonrisegames.com/yolomouse) (Steam edition). Aaron describes a concept; Claude paints each frame as a text grid; one PowerShell command compiles it into a working `.ani` cursor and installs it.

See `docs/specs/2026-05-14-cursor-forge-design.md` for the locked design.

## Quickstart

```powershell
.\forge.ps1 new RedSkull         # scaffold projects\RedSkull\ with 8 empty 64x64 grids
# (Claude fills in palette.txt + frames/*.grid.txt)
.\forge.ps1 build RedSkull       # compile -> projects\RedSkull\build\RedSkull.ani + previews
.\forge.ps1 preview RedSkull     # open preview.gif and preview_strip.png
.\forge.ps1 install RedSkull     # copy bundle into YoloMouse\Cursors\RedSkull\
.\forge.ps1 reload               # restart YoloLauncher to pick up the new cursor
```

## Commands

| Verb | Args | Effect |
|---|---|---|
| `new` | `<Name> [-Frames 8\|12\|24] [-Size 64]` | Scaffold from `projects\_template\`. Default 8 frames at 64x64. |
| `build` | `<Name>` | Compile grids -> `.ani` + bundle + previews in `build\`. |
| `preview` | `<Name>` | Open `build\preview.gif` and `build\preview_strip.png`. |
| `install` | `<Name>` | Copy `build\` contents into YoloMouse `Cursors\<Name>\`. |
| `uninstall` | `<Name>` | Remove `<Name>` from YoloMouse Cursors. |
| `reload` | (none) | Kill + relaunch `YoloLauncher.exe`. |
| `list` | (none) | Show all projects + build/install status. |

## Requirements

- Windows 10/11
- PowerShell 5.1 (built in)
- YoloMouse (Steam, from Dragonrise Games) installed at `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\`

No other dependencies. No Python, no installs.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```
```

- [ ] **Step 2: Commit**

```powershell
git add README.md
git commit -m "docs: add README with quickstart and command table"
```

---

### Task 1.3: Folder skeletons

**Files:**
- Create: `lib/.gitkeep`, `tests/.gitkeep`, `projects/.gitkeep`, `library/palettes/.gitkeep`, `docs/plans/.gitkeep`

(Empty `.gitkeep` files so the folders exist in git history even before they have content.)

- [ ] **Step 1: Create folders and gitkeeps**

```powershell
foreach ($d in 'lib','tests','projects','library\palettes') {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    New-Item -ItemType File -Path "$d\.gitkeep" -Force | Out-Null
}
```

- [ ] **Step 2: Commit**

```powershell
git add lib\.gitkeep tests\.gitkeep projects\.gitkeep library\palettes\.gitkeep
git commit -m "chore: scaffold lib/tests/projects/library folders"
```

---

### Task 1.4: Test helper + runner

**Files:**
- Create: `tests/_TestHelper.ps1`
- Create: `tests/Run-Tests.ps1`
- Create: `tests/Smoke.Tests.ps1` (a single passing test to prove the runner works)

- [ ] **Step 1: Write `tests/_TestHelper.ps1`**

```powershell
# Minimal assertion + tempdir helpers. Dot-sourced by each *.Tests.ps1 file.
# Throws on failure so the outer runner can catch and tally.

$script:CurrentTest = ''

function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    $script:CurrentTest = $Name
    try {
        & $Body
        Write-Host "  PASS  $Name" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  FAIL  $Name" -ForegroundColor Red
        Write-Host "        $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message = 'values differ')
    if ($Expected -ne $Actual) {
        throw "$Message`n        Expected: <$Expected>`n        Actual:   <$Actual>"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message = 'expected true')
    if (-not $Condition) { throw $Message }
}

function Assert-BytesEqual {
    param([byte[]]$Expected, [byte[]]$Actual, [string]$Message = 'byte arrays differ')
    if ($null -eq $Actual) { throw "$Message`n        Actual is `$null" }
    if ($Expected.Length -ne $Actual.Length) {
        throw "$Message`n        Length: expected $($Expected.Length), got $($Actual.Length)"
    }
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        if ($Expected[$i] -ne $Actual[$i]) {
            $e = '0x{0:X2}' -f $Expected[$i]
            $a = '0x{0:X2}' -f $Actual[$i]
            throw "$Message`n        Byte $i differs: expected $e, got $a"
        }
    }
}

function Assert-BytesEqualAt {
    param([byte[]]$Expected, [byte[]]$Actual, [int]$Offset, [string]$Message = 'bytes differ at offset')
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        $a = $Actual[$Offset + $i]
        if ($Expected[$i] -ne $a) {
            $e = '0x{0:X2}' -f $Expected[$i]
            $g = '0x{0:X2}' -f $a
            throw "$Message`n        At offset $($Offset + $i): expected $e, got $g"
        }
    }
}

function Assert-Throws {
    param([scriptblock]$Body, [string]$MatchPattern = '.*')
    try { & $Body } catch {
        if ($_.Exception.Message -notmatch $MatchPattern) {
            throw "Threw, but message did not match /$MatchPattern/`n        Message was: $($_.Exception.Message)"
        }
        return
    }
    throw 'Expected an exception, none was thrown'
}

function New-TempDir {
    $d = Join-Path $env:TEMP ("forge-test-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    return $d
}
```

- [ ] **Step 2: Write `tests/Run-Tests.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$tests = Get-ChildItem $PSScriptRoot -Filter '*.Tests.ps1' | Sort-Object Name
$totalPass = 0; $totalFail = 0
foreach ($t in $tests) {
    Write-Host "=== $($t.Name) ===" -ForegroundColor Cyan
    $localPass = 0; $localFail = 0
    # Each file uses Test-Case which returns $true/$false. We capture that.
    $results = & $t.FullName
    foreach ($r in $results) {
        if ($r -eq $true) { $localPass++ }
        elseif ($r -eq $false) { $localFail++ }
    }
    Write-Host "    $localPass passed, $localFail failed"
    $totalPass += $localPass; $totalFail += $localFail
}
Write-Host ''
Write-Host "Total: $totalPass passed, $totalFail failed" -ForegroundColor $(if ($totalFail -gt 0) { 'Red' } else { 'Green' })
if ($totalFail -gt 0) { exit 1 } else { exit 0 }
```

- [ ] **Step 3: Write `tests/Smoke.Tests.ps1`**

```powershell
. "$PSScriptRoot\_TestHelper.ps1"

Test-Case 'helper Assert-Equal accepts matching values' {
    Assert-Equal 1 1 'one equals one'
}

Test-Case 'helper Assert-BytesEqual accepts matching arrays' {
    Assert-BytesEqual ([byte[]](1,2,3)) ([byte[]](1,2,3))
}
```

- [ ] **Step 4: Run the runner; verify both smoke tests pass**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```

Expected tail: `Total: 2 passed, 0 failed` and exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add tests\_TestHelper.ps1 tests\Run-Tests.ps1 tests\Smoke.Tests.ps1
git commit -m "test: add minimal assertion helper and runner"
```

---

## Phase 2 — `lib/PixelGrid.ps1`

The parsing + bitmap rendering layer. Per spec §5. Four pure functions, each tested independently.

### Task 2.1: `Read-Palette`

Reads `palette.txt` content → `Hashtable<char, System.Drawing.Color>`. Spec §5.2.

**Files:**
- Create: `lib/PixelGrid.ps1`
- Create: `tests/PixelGrid.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

```powershell
# tests/PixelGrid.Tests.ps1
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
```

- [ ] **Step 2: Run, see it fail**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```

Expected: failures complaining that `Read-Palette` is not defined.

- [ ] **Step 3: Implement `Read-Palette`**

```powershell
# lib/PixelGrid.ps1
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
    $palette = @{}
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
```

- [ ] **Step 4: Run, see all six pass**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```

Expected: 6 of the 6 PixelGrid tests pass, plus the 2 smoke tests.

- [ ] **Step 5: Commit**

```powershell
git add lib\PixelGrid.ps1 tests\PixelGrid.Tests.ps1
git commit -m "feat: parse palette.txt into Color hashtable"
```

---

### Task 2.2: `Read-Grid`

Reads a `.grid.txt` → `@{ Width; Height; Hotspot=@{X;Y}|$null; Delay=<int>|$null; Cells=[string[]] }`. Spec §5.1.

**Files:**
- Modify: `lib/PixelGrid.ps1`
- Modify: `tests/PixelGrid.Tests.ps1`

- [ ] **Step 1: Append failing tests**

```powershell
# Append to tests/PixelGrid.Tests.ps1
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
```

- [ ] **Step 2: Run, see failures**

- [ ] **Step 3: Implement `Read-Grid`**

Append to `lib/PixelGrid.ps1`:

```powershell
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
```

- [ ] **Step 4: Run tests; verify all pass**

- [ ] **Step 5: Commit**

```powershell
git add lib\PixelGrid.ps1 tests\PixelGrid.Tests.ps1
git commit -m "feat: parse .grid.txt headers and body"
```

---

### Task 2.3: `Read-DesignFrontMatter`

Parses the `---`-fenced front matter from `design.md`. Spec §5.4.

**Files:**
- Modify: `lib/PixelGrid.ps1`
- Modify: `tests/PixelGrid.Tests.ps1`

- [ ] **Step 1: Append failing tests**

```powershell
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
```

- [ ] **Step 2: Run, see failure**

- [ ] **Step 3: Implement `Read-DesignFrontMatter`**

Append to `lib/PixelGrid.ps1`:

```powershell
function Read-DesignFrontMatter {
    [CmdletBinding(DefaultParameterSetName='Path')]
    param(
        [Parameter(Mandatory, ParameterSetName='Path')][string]$Path,
        [Parameter(Mandatory, ParameterSetName='Text')][string]$Text
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        if (-not (Test-Path $Path)) { throw "design file not found: $Path" }
        $Text = Get-Content -Raw -Path $Path
    }
    $lines = $Text -split "`r?`n"
    if ($lines.Count -lt 1 -or $lines[0].Trim() -ne '---') {
        throw "design.md must open with a '---' fence on line 1"
    }
    $kv = @{}
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { break }
        if ($lines[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$') {
            $kv[$Matches[1]] = $Matches[2]
        }
    }
    $result = @{
        Name           = $kv['name']
        Description    = $kv['description']
        Frames         = if ($kv['frames']) { [int]$kv['frames'] } else { 8 }
        DefaultDelay   = if ($kv['default_delay']) { [int]$kv['default_delay'] } else { 6 }
    }
    if ($kv['size'] -match '^\s*(\d+)\s*x\s*(\d+)\s*$') {
        $result.Width = [int]$Matches[1]; $result.Height = [int]$Matches[2]
    } else { $result.Width = 64; $result.Height = 64 }
    if ($kv['default_hotspot'] -match '^\s*(\d+)\s*,\s*(\d+)\s*$') {
        $result.DefaultHotspot = @{ X=[int]$Matches[1]; Y=[int]$Matches[2] }
    } else {
        $result.DefaultHotspot = @{ X = [int]([math]::Floor($result.Width/2)); Y = [int]([math]::Floor($result.Height/2)) }
    }
    return $result
}
```

- [ ] **Step 4: Run tests; verify pass**

- [ ] **Step 5: Commit**

```powershell
git add lib\PixelGrid.ps1 tests\PixelGrid.Tests.ps1
git commit -m "feat: parse design.md front-matter"
```

---

### Task 2.4: `Get-FrameBitmap`

Combines a parsed grid + palette → `System.Drawing.Bitmap`. Spec §6 step 4.

**Files:**
- Modify: `lib/PixelGrid.ps1`
- Modify: `tests/PixelGrid.Tests.ps1`

- [ ] **Step 1: Append failing tests**

```powershell
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
```

- [ ] **Step 2: Run, see failure**

- [ ] **Step 3: Implement `Get-FrameBitmap`**

Append to `lib/PixelGrid.ps1`:

```powershell
function Get-FrameBitmap {
    param(
        [Parameter(Mandatory)]$Grid,
        [Parameter(Mandatory)][hashtable]$Palette
    )
    $bmp = New-Object System.Drawing.Bitmap $Grid.Width, $Grid.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $transparent = [System.Drawing.Color]::FromArgb(0,0,0,0)
    for ($y = 0; $y -lt $Grid.Height; $y++) {
        $row = $Grid.Cells[$y]
        for ($x = 0; $x -lt $Grid.Width; $x++) {
            $ch = $row[$x]
            if ($ch -eq '.') {
                $bmp.SetPixel($x, $y, $transparent)
            } else {
                $key = [string]$ch
                if (-not $Palette.ContainsKey($key)) {
                    $bmp.Dispose()
                    throw "row $y col $x: character '$key' not in palette"
                }
                $bmp.SetPixel($x, $y, $Palette[$key])
            }
        }
    }
    return $bmp
}
```

- [ ] **Step 4: Run; all green**

- [ ] **Step 5: Commit**

```powershell
git add lib\PixelGrid.ps1 tests\PixelGrid.Tests.ps1
git commit -m "feat: render parsed grid + palette to Bitmap"
```

---

## Phase 3 — `lib/CurWriter.ps1` (single-image .cur bytes)

Pure function: `Get-CurBytes -Bitmap $b -HotspotX $x -HotspotY $y` → `byte[]`. Spec §8.4.

### Task 3.1: ICONDIR + ICONDIRENTRY headers

A `.cur` file is: 6 byte ICONDIR + 16 byte ICONDIRENTRY + 40 byte BITMAPINFOHEADER + XOR mask + AND mask. Hotspot is stored in the ICONDIRENTRY's `wPlanes`/`wBitCount` slots (a quirk of the cursor format).

**Files:**
- Create: `lib/CurWriter.ps1`
- Create: `tests/CurWriter.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

For a 2×2 32bpp bitmap with hotspot (0,0):
- Total size = 6 + 16 + 40 + (2·2·4)=16 + (2 rows of 4 byte AND = 8) = 86 bytes
- Bytes 0..5: ICONDIR — `00 00  02 00  01 00`
- Bytes 6..21: ICONDIRENTRY — `02 02 00 00  00 00 00 00  18 00 00 00  16 00 00 00`
   - Width=2, Height=2, ColorCount=0, Reserved=0
   - HotspotX=0 (WORD LE), HotspotY=0 (WORD LE)
   - BytesInRes = 64 (40 BITMAPINFOHEADER + 16 XOR + 8 AND) = 0x40 → `40 00 00 00`. Recompute: actually 40 + 16 + 8 = 64 → `40 00 00 00`. Correction below.
   - ImageOffset=22 (0x16) → `16 00 00 00`

(Update: the byte string above used `18 00 00 00` for BytesInRes — that was wrong. Correct value for a 2×2 cursor is 64 = `40 00 00 00`. The test below uses the correct value.)

```powershell
# tests/CurWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\CurWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-TestBitmap2x2 {
    $b = New-Object System.Drawing.Bitmap 2,2,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $b.SetPixel(0,0,[System.Drawing.Color]::FromArgb(255,255,0,0))   # red TL
    $b.SetPixel(1,0,[System.Drawing.Color]::FromArgb(255,0,255,0))   # green TR
    $b.SetPixel(0,1,[System.Drawing.Color]::FromArgb(0,0,0,0))       # transparent BL
    $b.SetPixel(1,1,[System.Drawing.Color]::FromArgb(255,0,0,255))   # blue BR
    return $b
}

Test-Case 'Get-CurBytes total size for 2x2 32bpp is 86 bytes' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    Assert-Equal 86 $bytes.Length
    $b.Dispose()
}

Test-Case 'Get-CurBytes ICONDIR header is 00 00 02 00 01 00' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    Assert-BytesEqualAt ([byte[]](0,0, 2,0, 1,0)) $bytes 0 'ICONDIR'
    $b.Dispose()
}

Test-Case 'Get-CurBytes ICONDIRENTRY has correct width/height/hotspot/offset' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 1 -HotspotY 2
    # offset 6: bWidth=2, bHeight=2, bColorCount=0, bReserved=0
    Assert-BytesEqualAt ([byte[]](2,2,0,0)) $bytes 6
    # offset 10: wHotspotX=1 (LE), wHotspotY=2 (LE)
    Assert-BytesEqualAt ([byte[]](1,0, 2,0)) $bytes 10
    # offset 14: dwBytesInRes = 80 (40 header + 16 xor + 8 and = 64)... wait let me recompute
    # For 2x2: XOR=2*2*4=16 bytes. AND row stride = ceil(2/8)=1 byte, padded to 4 = 4 bytes. Total AND = 2*4 = 8.
    # bytesInRes = 40 + 16 + 8 = 64 = 0x40
    Assert-BytesEqualAt ([byte[]](0x40,0,0,0)) $bytes 14 'bytesInRes'
    # offset 18: dwImageOffset = 22 (0x16)
    Assert-BytesEqualAt ([byte[]](0x16,0,0,0)) $bytes 18 'imageOffset'
    $b.Dispose()
}
```

- [ ] **Step 2: Run, see failures**

- [ ] **Step 3: Implement ICONDIR + ICONDIRENTRY portion of `Get-CurBytes`**

Initial implementation (just enough to make the three tests pass — BITMAPINFOHEADER + masks added next):

```powershell
# lib/CurWriter.ps1
Add-Type -AssemblyName System.Drawing

function Get-CurBytes {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap]$Bitmap,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY
    )
    $w = $Bitmap.Width; $h = $Bitmap.Height
    $xorSize = $w * $h * 4
    $andRowStride = [int]([math]::Ceiling($w / 8))
    $andRowPadded = [int]([math]::Ceiling($andRowStride / 4)) * 4
    $andSize = $andRowPadded * $h
    $bytesInRes = 40 + $xorSize + $andSize

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        # ICONDIR (6 bytes)
        $bw.Write([uint16]0)     # Reserved
        $bw.Write([uint16]2)     # Type = 2 (cursor)
        $bw.Write([uint16]1)     # Count = 1

        # ICONDIRENTRY (16 bytes)
        $bw.Write([byte]($w -band 0xFF))         # bWidth (0 means 256+)
        $bw.Write([byte]($h -band 0xFF))         # bHeight
        $bw.Write([byte]0)                       # bColorCount
        $bw.Write([byte]0)                       # bReserved
        $bw.Write([uint16]$HotspotX)             # wHotspotX
        $bw.Write([uint16]$HotspotY)             # wHotspotY
        $bw.Write([uint32]$bytesInRes)           # dwBytesInRes
        $bw.Write([uint32]22)                    # dwImageOffset (6 + 16 = 22)

        # BITMAPINFOHEADER (40 bytes) + XOR + AND filled in next task
        $bw.Write([uint32]40)                    # biSize
        $bw.Write([int32]$w)                     # biWidth
        $bw.Write([int32]($h * 2))               # biHeight = 2*H (XOR + AND mask)
        $bw.Write([uint16]1)                     # biPlanes
        $bw.Write([uint16]32)                    # biBitCount
        $bw.Write([uint32]0)                     # biCompression = BI_RGB
        $bw.Write([uint32]($xorSize + $andSize)) # biSizeImage
        $bw.Write([int32]0)                      # biXPelsPerMeter
        $bw.Write([int32]0)                      # biYPelsPerMeter
        $bw.Write([uint32]0)                     # biClrUsed
        $bw.Write([uint32]0)                     # biClrImportant

        # XOR mask: BGRA bytes, bottom-up rows
        for ($y = $h - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $w; $x++) {
                $c = $Bitmap.GetPixel($x, $y)
                $bw.Write([byte]$c.B)
                $bw.Write([byte]$c.G)
                $bw.Write([byte]$c.R)
                $bw.Write([byte]$c.A)
            }
        }

        # AND mask: all zeros, padded rows
        for ($y = 0; $y -lt $h; $y++) {
            for ($i = 0; $i -lt $andRowPadded; $i++) { $bw.Write([byte]0) }
        }

        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
        $ms.Dispose()
    }
}
```

- [ ] **Step 4: Run; the three header tests pass**

- [ ] **Step 5: Commit**

```powershell
git add lib\CurWriter.ps1 tests\CurWriter.Tests.ps1
git commit -m "feat: write .cur ICONDIR + ICONDIRENTRY headers"
```

---

### Task 3.2: BITMAPINFOHEADER + XOR + AND mask byte assertions

The implementation in 3.1 already wrote these. This task only adds assertions to lock them in against future regressions.

**Files:**
- Modify: `tests/CurWriter.Tests.ps1`

- [ ] **Step 1: Append byte-level tests**

```powershell
Test-Case 'Get-CurBytes BITMAPINFOHEADER has biSize=40 biWidth=W biHeight=2H biPlanes=1 biBitCount=32' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # BITMAPINFOHEADER starts at offset 22
    Assert-BytesEqualAt ([byte[]](40,0,0,0))   $bytes 22 'biSize=40'
    Assert-BytesEqualAt ([byte[]](2,0,0,0))    $bytes 26 'biWidth=2'
    Assert-BytesEqualAt ([byte[]](4,0,0,0))    $bytes 30 'biHeight=2*2=4'
    Assert-BytesEqualAt ([byte[]](1,0))        $bytes 34 'biPlanes=1'
    Assert-BytesEqualAt ([byte[]](32,0))       $bytes 36 'biBitCount=32'
    Assert-BytesEqualAt ([byte[]](0,0,0,0))    $bytes 38 'biCompression=BI_RGB'
    $b.Dispose()
}

Test-Case 'Get-CurBytes XOR mask is bottom-up BGRA' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # XOR mask starts at 6 + 16 + 40 = 62
    # Bottom row first: pixel (0,1) transparent, (1,1) blue
    # (0,1) is transparent: B=0 G=0 R=0 A=0
    Assert-BytesEqualAt ([byte[]](0,0,0,0)) $bytes 62 'bottom-left pixel (transparent)'
    # (1,1) blue: B=255 G=0 R=0 A=255
    Assert-BytesEqualAt ([byte[]](255,0,0,255)) $bytes 66 'bottom-right pixel (blue)'
    # Then top row: (0,0) red B=0 G=0 R=255 A=255 at offset 70
    Assert-BytesEqualAt ([byte[]](0,0,255,255)) $bytes 70 'top-left pixel (red)'
    # (1,0) green B=0 G=255 R=0 A=255 at offset 74
    Assert-BytesEqualAt ([byte[]](0,255,0,255)) $bytes 74 'top-right pixel (green)'
    $b.Dispose()
}

Test-Case 'Get-CurBytes AND mask is all zeros (8 bytes for 2x2)' {
    $b = New-TestBitmap2x2
    $bytes = Get-CurBytes -Bitmap $b -HotspotX 0 -HotspotY 0
    # AND mask starts at 78, length 8 (2 rows * 4 padded bytes)
    Assert-BytesEqualAt ([byte[]](0,0,0,0,0,0,0,0)) $bytes 78 'AND mask zeros'
    $b.Dispose()
}

Test-Case 'Get-CurBytes for 64x64 has correct total size' {
    $big = New-Object System.Drawing.Bitmap 64,64,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = Get-CurBytes -Bitmap $big -HotspotX 32 -HotspotY 32
    # 6 + 16 + 40 + (64*64*4=16384) + (64 rows * 8 padded bytes = 512) = 16958
    Assert-Equal 16958 $bytes.Length 'total size for 64x64'
    $big.Dispose()
}
```

- [ ] **Step 2: Run; all four pass**

- [ ] **Step 3: Commit**

```powershell
git add tests\CurWriter.Tests.ps1
git commit -m "test: lock .cur DIB header and mask byte layout"
```

---

## Phase 4 — `lib/AniWriter.ps1`

Wraps a list of bitmaps + per-frame jiffies into a RIFF/ACON .ani. Spec §8.4.

### Task 4.1: `Get-AniBytes` skeleton (RIFF + anih)

**Files:**
- Create: `lib/AniWriter.ps1`
- Create: `tests/AniWriter.Tests.ps1`

- [ ] **Step 1: Write failing tests**

```powershell
# tests/AniWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\CurWriter.ps1"
. "$PSScriptRoot\..\lib\AniWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-BlankBitmap { param([int]$Size = 2)
    $b = New-Object System.Drawing.Bitmap $Size,$Size,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y=0; $y -lt $Size; $y++) { for ($x=0; $x -lt $Size; $x++) {
        $b.SetPixel($x,$y,[System.Drawing.Color]::FromArgb(255,128,128,128))
    }}
    return $b
}

Test-Case 'Get-AniBytes starts with RIFF .... ACON' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    Assert-BytesEqualAt ([byte[]][char[]]'RIFF') $bytes 0
    Assert-BytesEqualAt ([byte[]][char[]]'ACON') $bytes 8
    $b1.Dispose(); $b2.Dispose()
}

Test-Case 'Get-AniBytes anih chunk: tag, size=36, cbSize=36, nFrames=N, flags=1' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 7 -PerFrameDelays @(7,7)
    # anih tag at offset 12
    Assert-BytesEqualAt ([byte[]][char[]]'anih') $bytes 12
    # Chunk size DWORD at 16 = 36
    Assert-BytesEqualAt ([byte[]](36,0,0,0)) $bytes 16
    # cbSize at 20 = 36
    Assert-BytesEqualAt ([byte[]](36,0,0,0)) $bytes 20
    # nFrames at 24 = 2
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 24
    # nSteps at 28 = 2
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 28
    # iWidth=2 at 32, iHeight=2 at 36, iBitCount=32 at 40, nPlanes=1 at 44, jifRate=7 at 48, flags=1 at 52
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 32 'iWidth'
    Assert-BytesEqualAt ([byte[]](2,0,0,0)) $bytes 36 'iHeight'
    Assert-BytesEqualAt ([byte[]](32,0,0,0)) $bytes 40 'iBitCount=32'
    Assert-BytesEqualAt ([byte[]](1,0,0,0)) $bytes 44 'nPlanes=1'
    Assert-BytesEqualAt ([byte[]](7,0,0,0)) $bytes 48 'jifRate=7'
    Assert-BytesEqualAt ([byte[]](1,0,0,0)) $bytes 52 'flags=0x01'
    $b1.Dispose(); $b2.Dispose()
}
```

- [ ] **Step 2: Run, see failures**

- [ ] **Step 3: Implement `Get-AniBytes` (anih only, rate + LIST stubbed empty for now)**

```powershell
# lib/AniWriter.ps1
Add-Type -AssemblyName System.Drawing

function Write-RiffChunkHeader {
    param([System.IO.BinaryWriter]$Writer, [string]$Tag, [uint32]$Size)
    if ($Tag.Length -ne 4) { throw "RIFF tag must be 4 chars, got '$Tag'" }
    foreach ($c in $Tag.ToCharArray()) { $Writer.Write([byte][char]$c) }
    $Writer.Write([uint32]$Size)
}

function Get-AniBytes {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY,
        [Parameter(Mandatory)][int]$DefaultDelay,
        [Parameter(Mandatory)][int[]]$PerFrameDelays
    )
    if ($Bitmaps.Count -ne $PerFrameDelays.Count) {
        throw "Bitmaps count ($($Bitmaps.Count)) != PerFrameDelays count ($($PerFrameDelays.Count))"
    }
    $n = $Bitmaps.Count
    $w = $Bitmaps[0].Width; $h = $Bitmaps[0].Height

    # Build each inner .cur once
    $curs = @()
    foreach ($bmp in $Bitmaps) {
        if ($bmp.Width -ne $w -or $bmp.Height -ne $h) {
            throw "Frame size mismatch: expected ${w}x${h}, got $($bmp.Width)x$($bmp.Height)"
        }
        $curs += ,(Get-CurBytes -Bitmap $bmp -HotspotX $HotspotX -HotspotY $HotspotY)
    }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        # Compute LIST/fram chunk inner size: 4 ('fram') + sum over frames of (8 'icon' header + curSize + (curSize odd? 1 : 0))
        $framInner = 4
        foreach ($c in $curs) {
            $framInner += 8 + $c.Length
            if (($c.Length % 2) -ne 0) { $framInner += 1 }
        }
        # rate chunk inner size = 4*N
        $rateInner = 4 * $n
        # RIFF inner size = 4 ('ACON') + 8 + 36 (anih) + 8 + rateInner + 8 + framInner
        $riffInner = 4 + 8 + 36 + 8 + $rateInner + 8 + $framInner

        # RIFF header
        Write-RiffChunkHeader $bw 'RIFF' $riffInner
        foreach ($c in 'ACON'.ToCharArray()) { $bw.Write([byte][char]$c) }

        # anih chunk
        Write-RiffChunkHeader $bw 'anih' 36
        $bw.Write([uint32]36)         # cbSize
        $bw.Write([uint32]$n)         # nFrames
        $bw.Write([uint32]$n)         # nSteps
        $bw.Write([uint32]$w)         # iWidth
        $bw.Write([uint32]$h)         # iHeight
        $bw.Write([uint32]32)         # iBitCount
        $bw.Write([uint32]1)          # nPlanes
        $bw.Write([uint32]$DefaultDelay)  # jifRate
        $bw.Write([uint32]1)          # flags = 0x01

        # rate chunk
        Write-RiffChunkHeader $bw 'rate' $rateInner
        foreach ($d in $PerFrameDelays) { $bw.Write([uint32]$d) }

        # LIST fram chunk
        Write-RiffChunkHeader $bw 'LIST' $framInner
        foreach ($c in 'fram'.ToCharArray()) { $bw.Write([byte][char]$c) }
        foreach ($cur in $curs) {
            Write-RiffChunkHeader $bw 'icon' $cur.Length
            $bw.Write($cur)
            if (($cur.Length % 2) -ne 0) { $bw.Write([byte]0) }  # RIFF pad
        }

        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
        $ms.Dispose()
    }
}

function Save-AniFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int]$HotspotX,
        [Parameter(Mandatory)][int]$HotspotY,
        [Parameter(Mandatory)][int]$DefaultDelay,
        [Parameter(Mandatory)][int[]]$PerFrameDelays
    )
    $bytes = Get-AniBytes -Bitmaps $Bitmaps -HotspotX $HotspotX -HotspotY $HotspotY -DefaultDelay $DefaultDelay -PerFrameDelays $PerFrameDelays
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}
```

- [ ] **Step 4: Run; first two anih tests pass**

- [ ] **Step 5: Commit**

```powershell
git add lib\AniWriter.ps1 tests\AniWriter.Tests.ps1
git commit -m "feat: write RIFF/ACON header and anih chunk"
```

---

### Task 4.2: `rate` chunk byte assertions

The implementation already writes rate. Lock the layout.

**Files:**
- Modify: `tests/AniWriter.Tests.ps1`

- [ ] **Step 1: Append tests**

```powershell
Test-Case 'Get-AniBytes rate chunk follows anih with N DWORDs' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap; $b3 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2,$b3) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(4,8,12)
    # anih ends at offset 12 + 8 + 36 = 56. rate starts there.
    Assert-BytesEqualAt ([byte[]][char[]]'rate') $bytes 56
    Assert-BytesEqualAt ([byte[]](12,0,0,0)) $bytes 60 'rate inner size = 4*3'
    Assert-BytesEqualAt ([byte[]](4,0,0,0))  $bytes 64 'frame 0 delay'
    Assert-BytesEqualAt ([byte[]](8,0,0,0))  $bytes 68 'frame 1 delay'
    Assert-BytesEqualAt ([byte[]](12,0,0,0)) $bytes 72 'frame 2 delay'
    $b1.Dispose(); $b2.Dispose(); $b3.Dispose()
}
```

- [ ] **Step 2: Run; passes**

- [ ] **Step 3: Commit**

```powershell
git add tests\AniWriter.Tests.ps1
git commit -m "test: lock rate chunk byte layout"
```

---

### Task 4.3: `LIST fram` chunk + per-frame `icon` sub-chunks

**Files:**
- Modify: `tests/AniWriter.Tests.ps1`

- [ ] **Step 1: Append tests**

```powershell
Test-Case 'Get-AniBytes LIST chunk follows rate' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    # After anih: 56. After rate (4*2 inner + 8 header) = 56 + 8 + 8 = 72. LIST starts at 72.
    Assert-BytesEqualAt ([byte[]][char[]]'LIST') $bytes 72
    # framInner = 4 (fram) + 2 * (8 + curSize). curSize for 2x2 = 86 (even, no pad). framInner = 4 + 2*94 = 192
    Assert-BytesEqualAt ([byte[]](192,0,0,0)) $bytes 76 'LIST inner size'
    Assert-BytesEqualAt ([byte[]][char[]]'fram') $bytes 80
    # First icon at 84
    Assert-BytesEqualAt ([byte[]][char[]]'icon') $bytes 84
    Assert-BytesEqualAt ([byte[]](86,0,0,0)) $bytes 88 'first icon size = 86'
    # First inner .cur starts at 92, must start with ICONDIR 00 00 02 00 01 00
    Assert-BytesEqualAt ([byte[]](0,0, 2,0, 1,0)) $bytes 92 'inner .cur ICONDIR'
    # Second icon at 92 + 86 = 178
    Assert-BytesEqualAt ([byte[]][char[]]'icon') $bytes 178
    $b1.Dispose(); $b2.Dispose()
}

Test-Case 'Get-AniBytes RIFF size matches actual byte count' {
    $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
    $bytes = Get-AniBytes -Bitmaps @($b1,$b2) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    # RIFF size DWORD at offset 4 must equal bytes.Length - 8
    $declared = [BitConverter]::ToUInt32($bytes, 4)
    Assert-Equal ($bytes.Length - 8) $declared 'RIFF size DWORD'
}

Test-Case 'Get-AniBytes rejects mismatched Bitmaps / PerFrameDelays count' {
    $b1 = New-BlankBitmap
    Assert-Throws {
        Get-AniBytes -Bitmaps @($b1) -HotspotX 0 -HotspotY 0 -DefaultDelay 6 -PerFrameDelays @(6,6)
    } 'count'
    $b1.Dispose()
}
```

- [ ] **Step 2: Run; all pass**

- [ ] **Step 3: Commit**

```powershell
git add tests\AniWriter.Tests.ps1
git commit -m "test: lock LIST/fram and inner icon chunk layout"
```

---

### Task 4.4: `Save-AniFile` end-to-end test (write + read back)

**Files:**
- Modify: `tests/AniWriter.Tests.ps1`

- [ ] **Step 1: Append test**

```powershell
Test-Case 'Save-AniFile writes a parseable .ani to disk' {
    $tmp = New-TempDir
    try {
        $b1 = New-BlankBitmap; $b2 = New-BlankBitmap
        $path = Join-Path $tmp 'test.ani'
        Save-AniFile -Path $path -Bitmaps @($b1,$b2) -HotspotX 1 -HotspotY 1 -DefaultDelay 6 -PerFrameDelays @(6,6)
        Assert-True (Test-Path $path) 'file exists'
        $disk = [System.IO.File]::ReadAllBytes($path)
        Assert-BytesEqualAt ([byte[]][char[]]'RIFF') $disk 0
        Assert-BytesEqualAt ([byte[]][char[]]'ACON') $disk 8
        $b1.Dispose(); $b2.Dispose()
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
```

- [ ] **Step 2: Run; passes**

- [ ] **Step 3: Commit**

```powershell
git add tests\AniWriter.Tests.ps1
git commit -m "test: round-trip Save-AniFile via tempdir"
```

---

## Phase 5 — `lib/GifWriter.ps1`

Animated GIF for preview only. Per spec §10.4, fidelity is not the goal — animation timing is. Use `System.Drawing.Imaging` SaveAdd + PropertyItem 0x5100 (FrameDelay) + 0x5101 (LoopCount).

### Task 5.1: `Save-GifFile`

**Files:**
- Create: `lib/GifWriter.ps1`
- Create: `tests/GifWriter.Tests.ps1`

- [ ] **Step 1: Write failing test**

```powershell
# tests/GifWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\GifWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-SolidBitmap { param([int]$Size, $Color)
    $b = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear($Color); $g.Dispose()
    return $b
}

Test-Case 'Save-GifFile produces a file starting with GIF89a' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap 8 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap 8 ([System.Drawing.Color]::Blue)
        $path = Join-Path $tmp 'out.gif'
        Save-GifFile -Path $path -Bitmaps @($b1,$b2) -PerFrameDelaysJiffies @(6,6)
        Assert-True (Test-Path $path) 'gif exists'
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $sig = -join ($bytes[0..5] | ForEach-Object { [char]$_ })
        Assert-Equal 'GIF89a' $sig
        $b1.Dispose(); $b2.Dispose()
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
```

- [ ] **Step 2: Run, see failure**

- [ ] **Step 3: Implement `Save-GifFile`**

```powershell
# lib/GifWriter.ps1
Add-Type -AssemblyName System.Drawing

function Save-GifFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [Parameter(Mandatory)][int[]]$PerFrameDelaysJiffies
    )
    if ($Bitmaps.Count -ne $PerFrameDelaysJiffies.Count) {
        throw "Bitmaps ($($Bitmaps.Count)) != delays ($($PerFrameDelaysJiffies.Count))"
    }
    # Convert jiffies (1/60) -> centiseconds (1/100) per spec §8.8
    $delaysCs = $PerFrameDelaysJiffies | ForEach-Object { [int][math]::Round($_ * 100.0 / 60.0) }

    $gifEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/gif' } | Select-Object -First 1
    if ($null -eq $gifEncoder) { throw 'no GIF encoder available' }

    # FrameDelay PropertyItem: 4 bytes per frame, type=4 (long), id=0x5100
    $delayBytes = New-Object byte[] (4 * $Bitmaps.Count)
    for ($i = 0; $i -lt $Bitmaps.Count; $i++) {
        $b = [BitConverter]::GetBytes([uint32]$delaysCs[$i])
        [Array]::Copy($b, 0, $delayBytes, $i * 4, 4)
    }
    # Use the first bitmap's existing PropertyIdList to clone a PropertyItem instance
    # (PropertyItem has an internal-only ctor; we must clone an existing one).
    $first = $Bitmaps[0]
    # Try cloning an existing property item; if the bitmap has none, set via the back door.
    if ($first.PropertyIdList.Count -eq 0) {
        # Workaround: paint then re-load via a roundtrip to get a property item.
        $tmpPath = [System.IO.Path]::GetTempFileName() + '.png'
        try {
            $first.Save($tmpPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $loaded = [System.Drawing.Bitmap]::FromFile($tmpPath)
            try {
                if ($loaded.PropertyIdList.Count -gt 0) {
                    $protoItem = $loaded.GetPropertyItem($loaded.PropertyIdList[0])
                } else {
                    # As a last resort, use reflection to construct a PropertyItem.
                    $protoItem = [System.Activator]::CreateInstance([System.Drawing.Imaging.PropertyItem], $true)
                }
                $protoItem.Id    = 0x5100
                $protoItem.Type  = 4
                $protoItem.Len   = $delayBytes.Length
                $protoItem.Value = $delayBytes
                $first.SetPropertyItem($protoItem)
            } finally { $loaded.Dispose() }
        } finally { Remove-Item -Force $tmpPath -ErrorAction SilentlyContinue }
    } else {
        $protoItem = $first.GetPropertyItem($first.PropertyIdList[0])
        $protoItem.Id    = 0x5100
        $protoItem.Type  = 4
        $protoItem.Len   = $delayBytes.Length
        $protoItem.Value = $delayBytes
        $first.SetPropertyItem($protoItem)
    }

    # LoopCount: PropertyTagLoopCount = 0x5101, 2-byte SHORT, 0 = infinite
    $loopProto = [System.Activator]::CreateInstance([System.Drawing.Imaging.PropertyItem], $true)
    $loopProto.Id    = 0x5101
    $loopProto.Type  = 3
    $loopProto.Len   = 2
    $loopProto.Value = [byte[]](0,0)
    try { $first.SetPropertyItem($loopProto) } catch { }  # best-effort; some GDI+ builds reject

    $multi = [System.Drawing.Imaging.EncoderValue]::MultiFrame
    $frame = [System.Drawing.Imaging.EncoderValue]::FrameDimensionTime
    $flush = [System.Drawing.Imaging.EncoderValue]::Flush

    $epStart = New-Object System.Drawing.Imaging.EncoderParameters 1
    $epStart.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::SaveFlag, [long]$multi)
    $first.Save($Path, $gifEncoder, $epStart)
    try {
        for ($i = 1; $i -lt $Bitmaps.Count; $i++) {
            $epNext = New-Object System.Drawing.Imaging.EncoderParameters 1
            $epNext.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::SaveFlag, [long]$frame)
            $first.SaveAdd($Bitmaps[$i], $epNext)
        }
        $epEnd = New-Object System.Drawing.Imaging.EncoderParameters 1
        $epEnd.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::SaveFlag, [long]$flush)
        $first.SaveAdd($epEnd)
    } catch {
        # If GDI+ chokes (rare), fall back to writing one PNG-per-frame and a single-frame GIF.
        throw "GIF save failed: $($_.Exception.Message)"
    }
}
```

> **Note for implementer:** The `System.Activator]::CreateInstance($t, $true)` trick uses the non-public default constructor of `PropertyItem`. This is documented to work on .NET Framework. If it fails on the target machine, the loaded-PNG roundtrip below it is the documented fallback. If both fail, downgrade gracefully: write a single-frame GIF of `frame_00` and emit a warning. The smoke test will surface the failure.

- [ ] **Step 4: Run; the smoke test passes**

- [ ] **Step 5: Commit**

```powershell
git add lib\GifWriter.ps1 tests\GifWriter.Tests.ps1
git commit -m "feat: write animated preview GIF with per-frame delays"
```

---

## Phase 6 — `lib/BundleWriter.ps1`

Writes `Bundle.json`, `Preview.png`, `preview_strip.png`, and per-frame PNGs. Spec §6 steps 5, 7, 8, 9.

### Task 6.1: `Save-Bundle` + `Save-PreviewStrip`

**Files:**
- Create: `lib/BundleWriter.ps1`
- Create: `tests/BundleWriter.Tests.ps1`

- [ ] **Step 1: Write failing tests**

```powershell
# tests/BundleWriter.Tests.ps1
. "$PSScriptRoot\_TestHelper.ps1"
. "$PSScriptRoot\..\lib\PixelGrid.ps1"
. "$PSScriptRoot\..\lib\BundleWriter.ps1"
Add-Type -AssemblyName System.Drawing

function New-SolidBitmap2 { param($Color)
    $b = New-Object System.Drawing.Bitmap 4,4,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear($Color); $g.Dispose(); return $b
}

Test-Case 'Save-Bundle writes Bundle.json with PascalCase keys and Types=animated' {
    $tmp = New-TempDir
    try {
        Save-Bundle -OutDir $tmp -Name 'PulseDot' -Description 'A breathing red dot'
        $json = Get-Content -Raw -Path (Join-Path $tmp 'Bundle.json') | ConvertFrom-Json
        Assert-Equal 'PulseDot' $json.Name
        Assert-Equal 'A breathing red dot' $json.Description
        Assert-Equal 'Forge' $json.Author
        Assert-Equal 'animated' $json.Types
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Test-Case 'Save-FramePngs writes one PNG per frame and copies Preview.png from frame 0' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap2 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap2 ([System.Drawing.Color]::Blue)
        Save-FramePngs -OutDir $tmp -Bitmaps @($b1,$b2)
        Assert-True (Test-Path (Join-Path $tmp 'frames\frame_00.png')) 'frame_00 png'
        Assert-True (Test-Path (Join-Path $tmp 'frames\frame_01.png')) 'frame_01 png'
        Assert-True (Test-Path (Join-Path $tmp 'Preview.png')) 'Preview.png'
        $b1.Dispose(); $b2.Dispose()
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Test-Case 'Save-PreviewStrip produces a wide PNG sized W*N + gutters' {
    $tmp = New-TempDir
    try {
        $b1 = New-SolidBitmap2 ([System.Drawing.Color]::Red)
        $b2 = New-SolidBitmap2 ([System.Drawing.Color]::Blue)
        $b3 = New-SolidBitmap2 ([System.Drawing.Color]::Green)
        $path = Join-Path $tmp 'preview_strip.png'
        Save-PreviewStrip -Path $path -Bitmaps @($b1,$b2,$b3) -Gutter 2
        $strip = [System.Drawing.Image]::FromFile($path)
        # 3 frames * 4 wide + 2 gutters * 2 = 12 + 4 = 16
        Assert-Equal 16 $strip.Width
        Assert-Equal 4 $strip.Height
        $strip.Dispose()
        $b1.Dispose(); $b2.Dispose(); $b3.Dispose()
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
```

- [ ] **Step 2: Run, see failures**

- [ ] **Step 3: Implement `lib/BundleWriter.ps1`**

```powershell
# lib/BundleWriter.ps1
Add-Type -AssemblyName System.Drawing

function Save-Bundle {
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Description,
        [string]$Types = 'animated',
        [string]$Author = 'Forge'
    )
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $obj = [ordered]@{
        Name        = $Name
        Description = $Description
        Author      = $Author
        Types       = $Types
    }
    $json = $obj | ConvertTo-Json -Compress:$false
    Set-Content -Path (Join-Path $OutDir 'Bundle.json') -Value $json -Encoding utf8
}

function Save-FramePngs {
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps
    )
    $framesDir = Join-Path $OutDir 'frames'
    if (-not (Test-Path $framesDir)) { New-Item -ItemType Directory -Path $framesDir -Force | Out-Null }
    for ($i = 0; $i -lt $Bitmaps.Count; $i++) {
        $name = 'frame_{0:D2}.png' -f $i
        $Bitmaps[$i].Save((Join-Path $framesDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $Bitmaps[0].Save((Join-Path $OutDir 'Preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
}

function Save-PreviewStrip {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps,
        [int]$Gutter = 2
    )
    if ($Bitmaps.Count -eq 0) { throw 'no bitmaps' }
    $w = $Bitmaps[0].Width; $h = $Bitmaps[0].Height; $n = $Bitmaps.Count
    $totalW = $n * $w + ($n - 1) * $Gutter
    $strip = New-Object System.Drawing.Bitmap $totalW, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($strip)
    try {
        $g.Clear([System.Drawing.Color]::FromArgb(0,0,0,0))
        for ($i = 0; $i -lt $n; $i++) {
            $g.DrawImage($Bitmaps[$i], ($i * ($w + $Gutter)), 0)
        }
    } finally { $g.Dispose() }
    $strip.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $strip.Dispose()
}
```

- [ ] **Step 4: Run; all three tests pass**

- [ ] **Step 5: Commit**

```powershell
git add lib\BundleWriter.ps1 tests\BundleWriter.Tests.ps1
git commit -m "feat: write Bundle.json, per-frame PNGs, and preview strip"
```

---

## Phase 7 — Template + starter palettes

### Task 7.1: `projects/_template/`

**Files:**
- Create: `projects/_template/brief.md`
- Create: `projects/_template/design.md`
- Create: `projects/_template/palette.txt`
- Create: `projects/_template/frames/frame_00.grid.txt`

- [ ] **Step 1: Write `projects/_template/brief.md`**

```markdown
# {{Name}} — Brief

**Concept:** (Aaron fills in: what is this cursor? a character? a vibe? a reference?)

**Intended use:** (game, app, system-wide, etc.)

**Reference:** (optional: link or text description)
```

- [ ] **Step 2: Write `projects/_template/design.md`**

```markdown
---
name: {{Name}}
description: A short one-liner shown in YoloMouse's selector
size: 64x64
frames: 8
default_delay: 6
default_hotspot: 32,32
---

# {{Name}} — Design

## Palette choice

(Why these colors. Reference `palette.txt`.)

## Motion plan

| Frame | What changes |
|---|---|
| 0 | resting pose |
| 1 | ... |
| ... | ... |

## Hotspot rationale

(Why 32,32 / 0,0 / wherever.)

## Loop transition

(How does frame N-1 flow back into frame 0?)
```

- [ ] **Step 3: Write `projects/_template/palette.txt`**

```
# Letter -> hex (RRGGBB or RRGGBBAA)
# A FF6B6B
# B FF4757
# C FFA502
```

- [ ] **Step 4: Write `projects/_template/frames/frame_00.grid.txt`**

A 64×64 grid of all `.` (transparent), with the standard headers:

```
# size 64x64
# hotspot 32,32
# delay 6
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
................................................................
```

(64 dot-lines, each exactly 64 chars wide.)

- [ ] **Step 5: Commit**

```powershell
git add projects\_template\
git commit -m "feat: scaffold _template project skeleton"
```

---

### Task 7.2: Library palettes

**Files:**
- Create: `library/palettes/classic_8bit.txt`
- Create: `library/palettes/neon_synthwave.txt`
- Create: `library/palettes/pastel_dream.txt`
- Create: `library/palettes/monochrome_terminal.txt`

- [ ] **Step 1: Write `library/palettes/classic_8bit.txt`**

```
# Classic 8-bit — NES-adjacent primaries plus black/white
A 000000
B FFFFFF
C E40058
D FF7777
E 00A800
F 50FF50
G 0000FC
H 5070FF
I FCFC00
J FFE4A0
```

- [ ] **Step 2: Write `library/palettes/neon_synthwave.txt`**

```
# Neon synthwave — magenta/cyan/yellow on dark
A 0D0221
B FF00C8
C 00FFE5
D FFD300
E FF6EC7
F 7A0BC0
G FFFFFF
```

- [ ] **Step 3: Write `library/palettes/pastel_dream.txt`**

```
# Pastel dream — soft pinks/blues/cream
A FFD6E0
B FFEEF3
C C8E7FF
D B8F2E6
E FFEFCF
F 6E7BA2
```

- [ ] **Step 4: Write `library/palettes/monochrome_terminal.txt`**

```
# Monochrome green-on-black terminal
A 000000
B 003B00
C 007700
D 00BB00
E 33FF33
F 88FF88
G CCFFCC
```

- [ ] **Step 5: Verify palettes parse**

```powershell
. .\lib\PixelGrid.ps1
Get-ChildItem library\palettes\*.txt | ForEach-Object {
    $p = Read-Palette -Path $_.FullName
    "$($_.Name): $($p.Count) colors"
}
```

Expected: prints "classic_8bit.txt: 10 colors", etc.

- [ ] **Step 6: Commit**

```powershell
git add library\palettes\
git commit -m "feat: add four starter palettes"
```

---

## Phase 8 — `forge.ps1` CLI dispatcher

### Task 8.1: Skeleton + `help`

**Files:**
- Create: `forge.ps1`
- Create: `tests/Forge.Tests.ps1`

- [ ] **Step 1: Write failing test**

```powershell
# tests/Forge.Tests.ps1
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
```

- [ ] **Step 2: Write `forge.ps1` skeleton**

```powershell
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
$Script:RepoRoot     = Split-Path -Parent $MyInvocation.MyCommand.Definition
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
    ''        { Show-Help; exit 0 }
    'help'    { Show-Help; exit 0 }
    default {
        Write-Host "forge: unknown verb '$Verb'" -ForegroundColor Red
        Show-Help
        exit 1
    }
}
```

- [ ] **Step 3: Run tests; both pass**

- [ ] **Step 4: Commit**

```powershell
git add forge.ps1 tests\Forge.Tests.ps1
git commit -m "feat: forge.ps1 skeleton with help verb"
```

---

### Task 8.2: `new` verb

Copies `_template/` → `projects/<Name>/`, substitutes `{{Name}}` in `brief.md` and `design.md`, generates N empty grid files.

**Files:**
- Modify: `forge.ps1`
- Modify: `tests/Forge.Tests.ps1`

- [ ] **Step 1: Append failing test**

```powershell
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
```

- [ ] **Step 2: Implement `new` verb**

Add to `forge.ps1` before the `switch ($Verb)` block:

```powershell
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
        $name = 'frame_{0:D2}.grid.txt' -f $i
        Set-Content (Join-Path $framesDir $name) $body -Encoding ascii
    }
    Write-Host "Created projects\$Name with $Frames frames at ${Size}x${Size}." -ForegroundColor Green
}
```

Then add the case to the `switch`:

```powershell
    'new' {
        $f = if ($PSBoundParameters.ContainsKey('Frames')) { $Frames } else { 8 }
        $s = if ($PSBoundParameters.ContainsKey('Size'))   { $Size }   else { 64 }
        Invoke-New -Name $Name -Frames $f -Size $s
        exit 0
    }
```

- [ ] **Step 3: Run tests; both `new` tests pass**

- [ ] **Step 4: Commit**

```powershell
git add forge.ps1 tests\Forge.Tests.ps1
git commit -m "feat: forge new — scaffold project from _template"
```

---

### Task 8.3: `list` verb

**Files:**
- Modify: `forge.ps1`
- Modify: `tests/Forge.Tests.ps1`

- [ ] **Step 1: Append failing test**

```powershell
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
```

- [ ] **Step 2: Implement `list`**

Add to `forge.ps1`:

```powershell
function Invoke-List {
    $projectsDir = Join-Path $Script:RepoRoot 'projects'
    if (-not (Test-Path $projectsDir)) { Write-Host '(no projects yet)'; return }
    $rows = @()
    Get-ChildItem $projectsDir -Directory | Where-Object { $_.Name -ne '_template' } | ForEach-Object {
        $design = Join-Path $_.FullName 'design.md'
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
```

Switch case:

```powershell
    'list' { Invoke-List; exit 0 }
```

- [ ] **Step 3: Run tests; passes**

- [ ] **Step 4: Commit**

```powershell
git add forge.ps1 tests\Forge.Tests.ps1
git commit -m "feat: forge list — show project status table"
```

---

### Task 8.4: `build` verb (wires everything)

The pipeline from spec §6.

**Files:**
- Modify: `forge.ps1`
- Modify: `tests/Forge.Tests.ps1`

- [ ] **Step 1: Append failing test**

```powershell
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
            $aniBytes = [System.IO.File]::ReadAllBytes('projects\Dot\build\Dot.ani')
            $sig = -join ($aniBytes[0..3] | ForEach-Object { [char]$_ })
            Assert-Equal 'RIFF' $sig 'starts with RIFF'
        } finally { Pop-Location }
    } finally { Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue }
}
```

- [ ] **Step 2: Implement `build`**

Add to `forge.ps1`:

```powershell
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
```

Switch case:

```powershell
    'build' {
        if (-not $Name) { throw 'forge build: <Name> is required' }
        Invoke-Build -Name $Name
        exit 0
    }
```

- [ ] **Step 3: Run tests; build test passes**

- [ ] **Step 4: Commit**

```powershell
git add forge.ps1 tests\Forge.Tests.ps1
git commit -m "feat: forge build — full grids -> .ani + previews pipeline"
```

---

### Task 8.5: `preview` verb

**Files:**
- Modify: `forge.ps1`

- [ ] **Step 1: Implement `preview`**

```powershell
function Invoke-Preview {
    param([Parameter(Mandatory)][string]$Name)
    $buildDir = Join-Path $Script:RepoRoot "projects\$Name\build"
    if (-not (Test-Path $buildDir)) { throw "forge preview: '$Name' has no build/. Run 'forge build $Name' first." }
    foreach ($f in 'preview.gif','preview_strip.png') {
        $p = Join-Path $buildDir $f
        if (Test-Path $p) { Start-Process $p } else { Write-Warning "missing $p" }
    }
}
```

Switch case:

```powershell
    'preview' {
        if (-not $Name) { throw 'forge preview: <Name> is required' }
        Invoke-Preview -Name $Name
        exit 0
    }
```

- [ ] **Step 2: Smoke-test manually**

```powershell
.\forge.ps1 new SmokeDot -Size 8 -Frames 4
.\forge.ps1 build SmokeDot     # may need a palette + filled frame_00 first
.\forge.ps1 preview SmokeDot   # Windows opens preview.gif in default handler
```

(For the smoke run, copy the build test's setup from Task 8.4. After verifying, `Remove-Item -Recurse -Force projects\SmokeDot` to clean up.)

- [ ] **Step 3: Commit**

```powershell
git add forge.ps1
git commit -m "feat: forge preview — open preview.gif and strip in default handler"
```

---

### Task 8.6: `install` + `uninstall` verbs

**Files:**
- Modify: `forge.ps1`

- [ ] **Step 1: Implement `install`**

```powershell
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
```

Switch cases:

```powershell
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
```

- [ ] **Step 2: Commit**

```powershell
git add forge.ps1
git commit -m "feat: forge install / uninstall verbs"
```

---

### Task 8.7: `reload` verb

**Files:**
- Modify: `forge.ps1`

- [ ] **Step 1: Implement `reload`**

```powershell
function Invoke-Reload {
    Get-Process -Name YoloLauncher,YoloMouse -ErrorAction SilentlyContinue | Stop-Process -Force
    $exe = Join-Path $Script:YoloMouseRoot 'YoloLauncher.exe'
    if (-not (Test-Path $exe)) { throw "forge reload: $exe not found" }
    Start-Process -FilePath $exe
    Write-Host "Restarted YoloLauncher." -ForegroundColor Green
}
```

Switch case:

```powershell
    'reload' { Invoke-Reload; exit 0 }
```

- [ ] **Step 2: Commit**

```powershell
git add forge.ps1
git commit -m "feat: forge reload — kill + restart YoloLauncher"
```

---

## Phase 9 — End-to-end smoke test + gotcha verification

This is where spec §10 items get answered for real. Each verification step records its result in `docs/specs/2026-05-14-cursor-forge-design.md` and `CLAUDE.md` if findings deviate from the spec.

### Task 9.1: Run the full test suite

- [ ] **Step 1: Run all tests**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```

Expected: all tests green, exit 0.

If any are red, stop and fix before continuing.

---

### Task 9.2: Scaffold and build a real test cursor

A simple "pulsing red dot" — 8 frames at 16×16, dot grows and shrinks. Picked because:
- Small enough that grid editing in-session is fast
- Animation is visible at a glance in YoloMouse
- Exercises non-trivial palette (multi-color), per-frame variation, and looping

- [ ] **Step 1: Scaffold**

```powershell
.\forge.ps1 new PulseDot -Size 16 -Frames 8
```

- [ ] **Step 2: Write `projects\PulseDot\palette.txt`**

```
# Pulsing red dot
A 661111
B BB2222
C FF4444
D FF8888
```

- [ ] **Step 3: Author each frame**

Edit each `projects\PulseDot\frames\frame_NN.grid.txt`. Frame 0 = smallest dot (1 pixel), frame 3 = biggest (5×5 with gradient), frames 4-7 = mirror back down. Sample frame 0 body (after the three headers):

```
................
................
................
................
................
................
................
.......A........
................
................
................
................
................
................
................
................
```

For frame 3 (peak), expand to a 5×5 with `D` core surrounded by `C` then `B`:

```
................
................
................
................
................
................
......BBB.......
......BCB.......
.....BCDCB......
......BCB.......
......BBB.......
................
................
................
................
................
```

The full 8-frame sequence: 0 (1px), 1 (3px), 2 (3px brighter), 3 (5px peak), 4 (5px), 5 (3px brighter), 6 (3px), 7 (1px). Frame 7 must blend smoothly back into frame 0 (the loop boundary).

- [ ] **Step 4: Build**

```powershell
.\forge.ps1 build PulseDot
```

Expected: prints success line; `projects\PulseDot\build\PulseDot.ani` exists.

- [ ] **Step 5: Preview**

```powershell
.\forge.ps1 preview PulseDot
```

Verify visually: GIF pulses, strip shows 8 frames cleanly, peak at frame 3.

- [ ] **Step 6: Commit the test cursor**

```powershell
git add projects\PulseDot\
git commit -m "test: add PulseDot end-to-end test cursor"
```

---

### Task 9.3: Install and verify YoloMouse picks it up

This is the gotcha-verification moment.

- [ ] **Step 1: Install**

```powershell
.\forge.ps1 install PulseDot
.\forge.ps1 reload
```

- [ ] **Step 2: Open YoloMouse's tray menu and check the cursor selector**

Aaron action: right-click the YoloMouse tray icon → cursors → look for "PulseDot".

**Decision point — spec §10 #1 (Bundle.json `Types` value):**
- If PulseDot appears in the selector → `"Types": "animated"` is correct. No spec change needed.
- If PulseDot is missing → edit `lib/BundleWriter.ps1` to default `Types = 'basic,animated'`, re-`build`, re-`install`, re-`reload`. If now visible, update spec §3.14, §8.3, §10 #1 and `CLAUDE.md` to reflect the corrected value. Commit separately: `fix: Bundle.json Types must be 'basic,animated' for YoloMouse to list cursor`.

- [ ] **Step 3: Bind PulseDot to a test app**

Aaron action: bind PulseDot to a test target via YoloMouse UI, move mouse, watch it animate.

**Decision point — spec §10 #2 (`anih.flags = 0x01`):**
- If the cursor animates correctly → flags=1 is correct. No change.
- If the cursor doesn't render or animates wrong → hex-compare against `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\Cursors\Desktop\Wait.Blue.ani`:

```powershell
Format-Hex 'C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\Cursors\Desktop\Wait.Blue.ani' | Select-Object -First 4
Format-Hex 'projects\PulseDot\build\PulseDot.ani' | Select-Object -First 4
```

Compare bytes 52..55 (the flags DWORD). If Dragonrise uses something other than 0x01, adopt it in `lib/AniWriter.ps1`, update tests, update spec §8.4 and §10 #2.

- [ ] **Step 4: Record results in spec**

For each of §10's 8 gotchas, append a "**Verified 2026-05-14:**" line under the gotcha with the observed behaviour (pass/fail + what was changed if anything). Commit:

```powershell
git add docs\specs\2026-05-14-cursor-forge-design.md CLAUDE.md
git commit -m "docs: record gotcha verification results from PulseDot smoke test"
```

---

### Task 9.4: Final sweep

- [ ] **Step 1: Run the full test suite one more time**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Run-Tests.ps1
```

All green expected.

- [ ] **Step 2: `forge.ps1 list` shows PulseDot built + installed**

```powershell
.\forge.ps1 list
```

Expected: PulseDot row with `Built: yes`, `Installed: yes`.

- [ ] **Step 3: Inspect repo cleanliness**

```powershell
git status
git log --oneline
```

Expected: clean working tree, ~25-30 commits, each focused on a single concern.

- [ ] **Step 4: Update `CLAUDE.md` "Project state" section**

Change the line at the bottom of `CLAUDE.md` from `Implementation: not yet started` to:

```markdown
- Implementation: complete as of 2026-05-14. `forge.ps1` + lib/ + tests/ working end-to-end. PulseDot test cursor installed and verified animating in YoloMouse.
```

Commit:

```powershell
git add CLAUDE.md
git commit -m "docs: mark implementation complete in CLAUDE.md"
```

---

## Done

At this point the repo should contain:
- A working `forge.ps1` CLI with all 7 verbs (+ help)
- `lib/` with 5 modules, each independently tested
- `tests/` with ~30 passing assertions across 5 test files
- `projects/_template/` ready to be cloned by `forge new`
- `library/palettes/` with 4 starter palettes
- One verified end-to-end cursor (`projects/PulseDot/`) installed in YoloMouse
- Spec §10 gotchas all marked verified or corrected
- ~25-30 commits, all green
