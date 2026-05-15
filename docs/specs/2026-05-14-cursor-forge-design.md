# YoloMouse Cursor Forge — Design Spec

**Date:** 2026-05-14
**Status:** Approved (awaiting implementation plan)
**Owner:** Aaron + Claude (collaborative authoring repo)

---

## 1. Mission

A collaborative workshop for designing custom **animated cursors** for [YoloMouse](https://dragonrisegames.com/yolomouse) (Steam edition by Dragonrise Games), installed at `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\`.

Aaron has tried YoloMouse's bundled animated cursors and doesn't like any of them. The forge gives Aaron + Claude a structured way to:

1. Aaron describes a cursor concept in chat (a character, a vibe, a reference).
2. Claude scaffolds a project, picks a palette, authors each animation frame as a small text grid.
3. They iterate together — line-by-line edits to plain text.
4. One PowerShell command compiles the grids into a working Windows `.ani` cursor and YoloMouse bundle.
5. Another command installs it into YoloMouse.

The repo lives at `C:\Users\Aaron\Documents\Repos\yolomouse-cursor-forge\`.

---

## 2. Architecture overview

```
┌─────────────────────┐    grids + palette    ┌──────────────────────┐
│  projects\<Name>\   │ ────────────────────▶ │   forge.ps1 build    │
│  brief / design /   │                       │   (PixelGrid +       │
│  palette / frames\  │                       │    AniWriter +       │
└─────────────────────┘                       │    GifWriter +       │
                                              │    BundleWriter)     │
                                              └──────────┬───────────┘
                                                         │ writes
                                                         ▼
                                              ┌──────────────────────┐
                                              │ projects\<Name>\     │
                                              │   build\             │
                                              │   ├ <Name>.ani       │
                                              │   ├ Bundle.json      │
                                              │   ├ Preview.png      │
                                              │   ├ preview.gif      │
                                              │   ├ preview_strip.png│
                                              │   └ frames\*.png     │
                                              └──────────┬───────────┘
                                                         │ forge.ps1 install
                                                         ▼
                                              ┌──────────────────────┐
                                              │ YoloMouse\Cursors\   │
                                              │   <Name>\            │
                                              └──────────┬───────────┘
                                                         │ forge.ps1 reload
                                                         ▼
                                              YoloLauncher.exe restart
```

**Stack:** Windows PowerShell 5.1 + .NET `System.Drawing` + `System.IO.BinaryWriter`. Zero external dependencies. No Python, no pip, no clickgen, no Pillow, no installs of any kind.

---

## 3. Decisions log

Locked during the 2026-05-14 grilling session. Each decision includes the option chosen and the reasoning that drove it.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Toolchain | **PowerShell 5.1 + .NET System.Drawing** | Aaron's machine has no Python (`python --version` → "not found"). PowerShell + System.Drawing is built into Windows 11 and can both author PNG frames AND write the .cur/.ani RIFF binary directly. Matches the explicit "no installs" constraint. |
| 2 | Frame authoring format | **Text-grid `.grid.txt` files + per-project `palette.txt`** | Lets Claude paint pixel-by-pixel directly in chat. Text grids are line-diffable, gittable, and Aaron can eyeball / nudge any single pixel from the terminal. Procedural / external-PNG modes were rejected as defeating the "Claude paints with you" goal. |
| 3 | Per-cursor scope | **One animated `.ani`, one variant** | Lightest scope per session. Color variants (Blue/Pink/Red like Dragonrise's bundles) and full system-cursor packs (Desktop-style) were rejected as multiplying authoring work for marginal benefit on bespoke art. |
| 4 | Static `.cur` companion | **Skipped** | Implicit in #3. YoloMouse's animated bundles work fine with just the `.ani`; a static fallback only matters for system-role bundles. |
| 5 | Default frame size | **64×64** | Modern hi-DPI cursor. Grid is still scrollable in chat (64 lines × 64 chars). Enough room for character/shape detail. YoloMouse downscales smoothly. |
| 6 | Frame count | **Selectable at scaffold time: 8 / 12 / 24, default 8** | Aaron asked for runtime choice rather than a hardcoded number. `forge.ps1 new MyCursor -Frames 12` → 12 frame slots. No `-Frames` arg → 8. |
| 7 | Frame timing default | **6 jiffies per frame (~100ms ≈ 10fps)** | Project-overridable via `# delay N` header in any frame's `.grid.txt`. With 8 frames at 6 jiffies → 800ms loop (sweet spot for ambient breathing/spinning cursors). |
| 8 | Loop semantics | **Always seamless loop (design guideline, not a flag)** | `.ani` files always replay indefinitely at the OS level. Authoring guideline: every cursor must transition cleanly from last frame back to first. |
| 9 | Build vs install separation | **Separate `build` and `install` commands** | Explicit two-step. `build` only writes to `projects\<Name>\build\`. `install` copies into YoloMouse. No accidental overwrites of live bundles mid-iteration. |
| 10 | YoloMouse process restart | **Separate `forge.ps1 reload` command** | `install` never touches the YM process. `reload` kills + relaunches `YoloLauncher.exe`. Aaron decides when to interrupt an active session. |
| 11 | Preview output | **Both: frame strip PNG + animated GIF** | `preview_strip.png` (all frames horizontally) for inspecting individual frames; `preview.gif` for actual animation feel. `forge.ps1 preview` opens the GIF. |
| 12 | Repo name | **`yolomouse-cursor-forge`** | Lowercase-kebab, specific to YoloMouse, "forge" telegraphs workshop/authoring vibe. |
| 13 | Git | **Init from day one + initial commit** | Per-cursor iterations get full history. Easy revert if Claude ruins a frame. `.gitignore` excludes `projects\*\build\` so binary outputs don't pollute history. |
| 14 | Project-local memory | **CLAUDE.md (auto-loaded) + brief.md** | When Aaron opens Claude Code in this repo, Claude Code keys memory to the new path — global memory from the YoloMouse Steam folder won't auto-load. CLAUDE.md primes future-Claude instantly with workflow + conventions + paths. brief.md is the human-readable mission paragraph. |

---

## 4. Repo layout

```
C:\Users\Aaron\Documents\Repos\yolomouse-cursor-forge\
├── README.md                        Human-facing overview, quickstart, command table
├── CLAUDE.md                        Auto-loaded context for future Claude sessions in this repo
├── brief.md                         1-paragraph mission statement
├── .gitignore                       Excludes projects\*\build\ + .DS_Store-style noise
├── forge.ps1                        Main CLI entrypoint — dispatches to verb scripts
├── lib\
│   ├── PixelGrid.ps1                Parses .grid.txt + palette.txt → System.Drawing.Bitmap
│   ├── CurWriter.ps1                Writes single-image RGBA .cur (used as inner-frame for .ani)
│   ├── AniWriter.ps1                Writes RIFF/ACON/anih .ani from a list of bitmaps + per-frame jiffies
│   ├── GifWriter.ps1                Writes preview.gif from frame bitmaps + delays
│   └── BundleWriter.ps1             Writes Bundle.json, Preview.png, ensures bundle folder layout
├── docs\
│   └── specs\
│       └── 2026-05-14-cursor-forge-design.md   This document
├── projects\
│   ├── _template\                   Cloned by `forge new <Name>`
│   │   ├── brief.md                 Aaron fills out (concept, references, vibe, intended use)
│   │   ├── design.md                Claude fills out (palette choice, motion plan per frame, hotspot, timing)
│   │   ├── palette.txt              Letter → hex (RRGGBB or RRGGBBAA)
│   │   ├── frames\
│   │   │   └── frame_00.grid.txt    Empty 64×64 grid as starting point
│   │   └── build\                   Generated, gitignored
│   └── <YourCursor>\                One folder per cursor, never deleted
└── library\
    └── palettes\                    Starter palettes Aaron/Claude can copy-paste into projects
        ├── classic_8bit.txt
        ├── neon_synthwave.txt
        ├── pastel_dream.txt
        └── monochrome_terminal.txt
```

---

## 5. Authoring format spec

### 5.1 `.grid.txt` (one per frame)

```
# size 64x64
# hotspot 32,32
# delay 6
................................................................
................................................................
............................AAAA................................
.........................AABBBBAA...............................
.......................ABBCCCCBBA...............................
... (60 more rows, 64 chars each) ...
```

**Rules:**
- One character per pixel. Grid must be exactly `<width> × <height>` chars.
- `.` = fully transparent (alpha 0).
- Any other character = palette index. Resolved against the project's `palette.txt`. Unknown characters → build error with file + line + column.
- Comment lines start with `#`. Recognised header comments:
  - `# size WxH` — declares dimensions. Required (build asserts grid matches).
  - `# hotspot X,Y` — overrides the project default hotspot for this frame. Optional. (Note: only the first frame's hotspot is used in the .ani — Windows `.ani` has one hotspot for the whole animation. If multiple frames declare different hotspots, build emits a warning and uses frame_00's.)
  - `# delay N` — overrides the project default frame delay (in jiffies, 1/60 sec) for this frame. Optional.
- Blank lines outside the grid are ignored.
- Grid lines start at the first non-comment, non-blank line and continue for `height` lines.

### 5.2 `palette.txt` (one per project)

```
# Format: <letter> <hex>
# hex is RRGGBB (alpha = FF) or RRGGBBAA
A FF6B6B
B FF4757
C FFA502
D FFD93D
S 1A1A1A80
```

**Rules:**
- Letters are case-sensitive. `A` and `a` are distinct palette slots.
- Comments start with `#`.
- Hex must be exactly 6 or 8 characters (no `#` prefix).
- Two letters mapping to the same color is allowed (useful for semantic naming during authoring).
- A letter not declared in palette.txt but used in any grid → build error.

### 5.3 Frame ordering

Frames are loaded in lexicographic order of filename. Convention: `frame_00.grid.txt`, `frame_01.grid.txt`, …, `frame_NN.grid.txt`. Two-digit zero-padded.

### 5.4 Project defaults (set in `design.md` front-matter)

`design.md` opens with a small YAML-ish block that the build script parses:

```
---
name: PulseDot
description: A breathing red dot
size: 64x64
frames: 8
default_delay: 6
default_hotspot: 32,32
---
```

These are the project defaults that individual frame grids can override.

---

## 6. Build pipeline

`forge.ps1 build <Name>` performs:

1. **Load project metadata.** Parse `projects\<Name>\design.md` front-matter for size/frames/default_delay/default_hotspot.
2. **Load palette.** Parse `palette.txt` into `@{ 'A' = [Color]::FromArgb(0xFF, 0xFF, 0x6B, 0x6B); ... }`.
3. **Load all frame grids.** For each `frames\frame_*.grid.txt` (sorted), parse header comments + grid body. Validate dimensions match project `size`. Validate every non-`.` char exists in palette. Resolve per-frame `delay` + `hotspot` (or fall back to project default).
4. **Render bitmaps.** For each frame, create a `System.Drawing.Bitmap` of the project size, set every pixel by `(x, y)` from the grid + palette.
5. **Write PNG frames.** `build\frames\frame_NN.png` — one per frame (used by GIF writer + for human inspection).
6. **Write `.ani`.** `build\<Name>.ani` — RIFF/ACON file containing:
   - `anih` chunk: 36 bytes describing frame count, default jiffy rate, flags (icon=1, sequence=optional, default rate=use anih.jifRate).
   - `rate` chunk (always written): per-frame jiffies array (covers project default + per-frame overrides).
   - `LIST fram` chunk: N × `icon` chunks; each `icon` chunk = a one-image .cur file (BMP-format, 32-bit RGBA, hotspot baked in).
7. **Write `Bundle.json`.** `{"Name":"<Name>","Description":"<from design.md>","Author":"Forge","Types":"animated"}`. (Verify on first build whether YoloMouse needs `"basic,animated"` instead — see §10 gotchas.)
8. **Write `Preview.png`.** Copy `frame_00.png` to `Preview.png` (this is YoloMouse's selector thumbnail).
9. **Write previews.** `preview_strip.png` (all frames laid horizontally with a 2px gutter) and `preview.gif` (animated, using the per-frame jiffies converted to centiseconds).
10. **Print summary** — frame count, total duration, output paths.

Failure modes:
- Missing `design.md` / `palette.txt` / no frame files → fail fast with a clear message naming the missing file.
- Grid dimension mismatch → `frame_03.grid.txt: expected 64x64, got 64x63 (last row missing)`.
- Unknown palette letter → `frame_05.grid.txt:line 12 col 7: character 'Z' not in palette.txt`.
- Build is **not** atomic; if it fails partway, `build\` is left in a half-written state. (YAGNI on a temp-dir-rename for now; Aaron can manually delete `build\` if confused.)

---

## 7. CLI commands

Single entrypoint: `forge.ps1 <verb> [args]`. Verbs:

| Verb | Args | Behavior |
|---|---|---|
| `new` | `<Name> [-Frames 8\|12\|24] [-Size 64]` | Copy `projects\_template\` → `projects\<Name>\`. Generate `frames\frame_00.grid.txt` … `frame_NN.grid.txt` (NN = Frames-1) as empty grids of the chosen size. Write `design.md` front-matter. Fails if `<Name>` exists. |
| `build` | `<Name>` | Run pipeline §6. |
| `preview` | `<Name>` | Open `build\preview.gif` and `build\preview_strip.png` in default Windows handler. Errors if `build\` doesn't exist (suggests running `build` first). |
| `install` | `<Name>` | Copy `build\<Name>.ani`, `build\Bundle.json`, `build\Preview.png` into `<YoloMouseRoot>\Cursors\<Name>\` (creating directory). Overwrites without prompting. Errors if `build\` doesn't exist or YoloMouse root not found. |
| `uninstall` | `<Name>` | `Remove-Item -Recurse -Force` `<YoloMouseRoot>\Cursors\<Name>\`. Confirms with `-WhatIf`-style dry-run output unless `-Force` passed. |
| `reload` | (none) | `Get-Process YoloLauncher,YoloMouse -ErrorAction SilentlyContinue \| Stop-Process -Force`, then `Start-Process "<YoloMouseRoot>\YoloLauncher.exe"`. |
| `list` | (none) | Walk `projects\` and print each project name + columns: `Frames`, `Built?`, `Installed?`. |

`<YoloMouseRoot>` is hardcoded at the top of `forge.ps1` as `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse`. Single variable, easy to edit if Aaron moves the install.

`forge.ps1` with no args or `forge.ps1 help` prints the verb table.

---

## 8. YoloMouse integration

### 8.1 Install root

`C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\`. Confirmed during research.

### 8.2 Where bundles live

`<YoloMouseRoot>\Cursors\<BundleName>\` — one folder per bundle. Forge writes:
- `Bundle.json`
- `Preview.png`
- `<Name>.ani`

### 8.3 Bundle.json schema

```json
{
  "Name": "<Name>",
  "Description": "<one-line from design.md>",
  "Author": "Forge",
  "Types": "animated"
}
```

The PascalCase keys match Dragonrise's `Desktop/Bundle.json`. Older bundles (`Arrow/Bundle.json`) use lowercase keys without `Types` — both are tolerated by YoloMouse, but PascalCase + explicit `Types` is the modern form.

### 8.4 .ani format (what AniWriter.ps1 emits)

Standard Windows RIFF/ACON animated cursor:

```
RIFF <total_size> ACON
  anih <36>                              [animated cursor header]
    cbSize         = 36
    nFrames        = N (frame count)
    nSteps         = N (animation steps; equal to nFrames since we don't use seq)
    iWidth         = project size (e.g. 64)
    iHeight        = project size
    iBitCount      = 32 (RGBA)
    nPlanes        = 1
    jifRate        = project default delay (e.g. 6)
    flags          = 0x01 (icon-format frames, no seq chunk)
  rate <4*N>
    [N × DWORD: per-frame jiffies, allowing per-frame # delay overrides]
  LIST <size> fram
    icon <size_0>                        [one-image .cur for frame 0]
    icon <size_1>                        [one-image .cur for frame 1]
    ...
    icon <size_N-1>
```

Each inner `icon` chunk is a complete single-image .cur:
- ICONDIR (6 bytes): reserved=0, type=2 (cursor), count=1
- ICONDIRENTRY (16 bytes): width, height (0 for 256), colorCount=0, reserved=0, hotspotX, hotspotY (xy fields used as hotspot for cursors), bytesInRes, imageOffset=22
- BITMAPINFOHEADER (40 bytes): biSize=40, biWidth=W, biHeight=2*H (XOR + AND mask doubled), biPlanes=1, biBitCount=32, biCompression=0 (BI_RGB), biSizeImage=W*H*4 + W*H/8, others=0
- XOR mask: W*H × BGRA bytes, **bottom-up rows**
- AND mask: W*H bits packed (1=transparent), each row padded to 4-byte boundary. For 32-bit RGBA cursors with alpha, AND mask is conventionally all zeros.

### 8.5 Hotspot

Baked into each inner `icon` chunk's ICONDIRENTRY (the `wPlanes`/`wBitCount` fields are repurposed as hotspot X/Y in cursor format). Same hotspot used for all frames per spec §5.1.

### 8.6 .ani is single-resolution

Per Windows spec, `.ani` cannot multi-pack sizes. We render at one size (project default 64×64). YoloMouse's in-game size slider downscales smoothly.

### 8.7 Frame timing units

`anih.jifRate` and `rate` chunk entries are in **jiffies = 1/60 second**. So `delay 6` = 100ms, `delay 4` = 67ms (15fps), `delay 2` = 33ms (30fps).

### 8.8 GIF preview timing

Animated GIF frame delays are in **centiseconds (1/100 sec)**. GifWriter converts: `cs = round(jiffies * 100 / 60)`. Slight rounding error is acceptable for preview purposes.

---

## 9. Per-cursor workflow

The full lifecycle from idea to live cursor:

1. **Aaron in chat:** "Let's make a cursor that's a tiny pulsing red skull."
2. **Claude:** `.\forge.ps1 new RedSkull` → scaffolds `projects\RedSkull\` with 8 empty 64×64 grids.
3. **Claude fills out `projects\RedSkull\design.md`:** picks palette (4-5 reds + black + white highlights), describes motion (skull holds steady frames 0-3, eyes pulse brighter frames 4-7), declares hotspot (likely 32,32 for crosshair-style or 0,0 for arrow-style).
4. **Claude writes `palette.txt`** with the chosen colors.
5. **Claude fills `frames\frame_00.grid.txt` …** painting each frame as a text grid in chat. Aaron eyeballs and corrects ("the left eye is one pixel too high on frame 3").
6. **Claude:** `.\forge.ps1 build RedSkull` → produces `.ani` + previews.
7. **Claude:** `.\forge.ps1 preview RedSkull` → Aaron sees the GIF + frame strip in Windows Photos.
8. **Aaron requests tweaks** → back to step 5.
9. **Claude:** `.\forge.ps1 install RedSkull` → drops bundle into YoloMouse.
10. **Claude:** `.\forge.ps1 reload` → restarts YoloLauncher.
11. **Aaron:** binds the new cursor to a game/app via the YoloMouse tray menu.

---

## 10. Known gotchas (verify during implementation)

1. **Bundle.json `Types` value.** Spec writes `"animated"`. If YoloMouse rejects it (cursor not appearing in selector), try `"basic,animated"`. Verify on first build.
2. **`.ani` flags field.** `flags = 0x01` indicates frames are full icon resources (not raw bitmap data). Need to verify against a Dragonrise-shipped `.ani` (e.g. `Cursors\Desktop\Wait.Blue.ani`) by hexdump if cursors don't load.
3. **AND mask required even for 32-bit RGBA.** Some Windows cursor parsers crash without it. Always emit, even if all zeros.
4. **GIF transparency.** GIF format has 1-bit transparency (no alpha). For preview only, alpha < 128 → transparent, else opaque. Visual fidelity is not the goal of the GIF — animation timing is.
5. **PowerShell 5.1 string parsing of palette hex.** `[Convert]::ToInt32('FF6B6B', 16)` works; `0xFF6B6B` literal also works. Use `[Color]::FromArgb($a, $r, $g, $b)` for explicit construction.
6. **`System.Drawing.Common` in PS 5.1.** Available without explicit `Add-Type -AssemblyName System.Drawing`. Test on first run; add the assembly load if needed.
7. **YoloMouse install path with parens.** `Program Files (x86)` parens are fine in PowerShell when quoted, but watch for any string concatenation that breaks them.
8. **Process kill privileges.** `Stop-Process YoloLauncher -Force` may prompt UAC if YoloMouse was elevated. Document in README that `reload` needs same privilege as YoloMouse.

---

## 11. Out of scope (YAGNI'd)

Explicitly NOT in this design — listed so future-Claude doesn't add them speculatively:

- **Color variants per cursor** (Blue/Pink/Red multi-output). If Aaron wants a recolor, copy the project folder + edit palette.txt.
- **Static `.cur` companion** alongside the `.ani`. Animated bundles work without it.
- **Full system-cursor packs** (Desktop-style, replacing all 15 Windows roles in one bundle).
- **Procedural code-driven frame generation** (PowerShell scripts that draw to bitmaps). Text grids are the only authoring mode.
- **External PNG drop-in mode.** Only text grids feed into the build.
- **Hot-reload watcher** (re-building on file change). Manual `build` only.
- **Atomic build** (temp-dir rename on success). Best-effort; user deletes `build\` to recover from a failed build.
- **Cross-platform support.** Windows-only. macOS/Linux YoloMouse doesn't exist.
- **GitHub publishing tooling.** Aaron can `gh repo create` later; not the forge's job.
- **Cursor binding management** (writing to `%LOCALAPPDATA%\YoloMouse\*.ini`). YoloMouse's own UI handles this; forge stops at install.

---

## 12. Memory & cross-session continuity

- **In-repo `CLAUDE.md`** at repo root. Auto-loaded by Claude Code when a session starts in this folder. Contains: mission summary, full command table, repo layout, authoring format pointers, gotchas to watch.
- **Global memory update.** The existing `cursor_forge_repo.md` in Claude's global memory dir (currently keyed to the YoloMouse Steam folder) points at the wrong location. To be updated to `C:\Users\Aaron\Documents\Repos\yolomouse-cursor-forge\` as part of implementation.
- **Per-project `design.md`.** Each cursor project's design rationale lives with it, surviving across sessions in plain text.

---

## 13. Open questions

None blocking. All structural decisions resolved. Implementation-time verification items listed in §10.
