# CLAUDE.md — yolomouse-cursor-forge

Auto-loaded context for Claude Code sessions opened in this repo.

## What this repo is

A workshop where Aaron + Claude collaboratively design custom **animated cursors** for [YoloMouse](https://dragonrisegames.com/yolomouse). Aaron describes a concept in chat; Claude scaffolds a project under `projects/<Name>/`, authors each animation frame as a text grid (`.grid.txt` + per-project `palette.txt`), and a PowerShell pipeline compiles the grids into a Windows `.ani` cursor + YoloMouse bundle.

**The design spec is the source of truth:** `docs/specs/2026-05-14-cursor-forge-design.md`. Read it whenever a non-obvious question comes up. This file is the working primer.

## Stack

- Windows PowerShell 5.1
- .NET `System.Drawing` (built into Windows — already present, no install)
- .NET `System.IO.BinaryWriter` for raw RIFF/ACON binary writing of `.ani` files

**No Python. No pip. No external dependencies of any kind.** Aaron's machine has no Python and explicitly wants zero installs.

## YoloMouse install path

`C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\` — Steam edition by Dragonrise Games. Cursor bundles live under `Cursors\<BundleName>\`. This path is hardcoded at the top of `forge.ps1` as `$Script:YoloMouseRoot`.

## Workflow per cursor

1. Aaron describes a cursor concept in chat ("a tiny pulsing red skull").
2. Claude runs `.\forge.ps1 new <Name>` to scaffold from `projects\_template\`.
3. Claude fills in `projects\<Name>\design.md` (palette choice, motion plan per frame, hotspot, timing) and `palette.txt`.
4. Claude paints each `frames\frame_NN.grid.txt` directly in chat — line by line, palette letters per pixel.
5. Aaron eyeballs and corrects ("eye is one pixel too high on frame 3").
6. `.\forge.ps1 build <Name>` → `.ani` + `Bundle.json` + `Preview.png` + `preview.gif` + `preview_strip.png` in `projects\<Name>\build\`.
7. `.\forge.ps1 preview <Name>` → opens GIF + strip in default viewer.
8. Iterate steps 4–7 until Aaron is happy.
9. `.\forge.ps1 install <Name>` → copies bundle into YoloMouse `Cursors\<Name>\`.
10. `.\forge.ps1 reload` → restarts YoloLauncher so it picks up the new cursor.
11. Aaron binds it via the YoloMouse tray menu.

## Commands

| Verb | Args | Effect |
|---|---|---|
| `new` | `<Name> [-Frames 8\|12\|24] [-Size 64]` | Scaffold from `projects\_template\`. Default 8 frames at 64×64. |
| `build` | `<Name>` | Compile grids → `.ani` + bundle + previews in `build\`. |
| `preview` | `<Name>` | Open `build\preview.gif` and `build\preview_strip.png`. |
| `install` | `<Name>` | Copy `build\` contents into YoloMouse `Cursors\<Name>\`. |
| `uninstall` | `<Name>` | Remove `<Name>` from YoloMouse Cursors. |
| `reload` | (none) | Kill + relaunch `YoloLauncher.exe`. |
| `list` | (none) | Show all projects + build/install status. |

## Authoring format quick reference

**`.grid.txt`** — one per frame:
```
# size 64x64
# hotspot 32,32
# delay 6
................................................................
... (64 rows total, 64 chars each) ...
```
- `.` = transparent. Any other char = palette index.
- Headers: `# size WxH` (required), `# hotspot X,Y` (optional), `# delay N` (optional, jiffies = 1/60s).

**`palette.txt`** — one per project:
```
# letter <hex>
A FF6B6B
B FF4757
C FFA502
D FFD93D
S 1A1A1A80    (with 80 alpha)
```

**Frame ordering:** lexicographic by filename. Convention: `frame_00.grid.txt`, `frame_01.grid.txt`, …

## Defaults

- Frame size: 64×64
- Frame count: 8 (or 12 / 24 via `-Frames`)
- Frame timing: 6 jiffies = 100ms each (≈ 10fps, ≈ 800ms loop with 8 frames)
- Hotspot: grid center
- Loop: always seamless (Windows `.ani` always replays — design last frame to flow back to first)
- Per-cursor scope: one `.ani`, one variant. NO color variants by default. NO static `.cur` companion.

## Critical conventions

- **Bundle.json `Types`** — currently writing `"animated"`. If YoloMouse rejects it (cursor doesn't appear in selector), try `"basic,animated"`. Verify on first build and update spec + this file accordingly.
- **`.ani` is single-resolution.** YoloMouse's size slider does the downscaling. Don't try to multi-pack sizes.
- **Hotspot is baked into the file.** Windows uses frame_00's hotspot for the whole animation regardless of what other frames declare.
- **AND mask is required** in each inner `.cur` chunk even for 32-bit RGBA — some Windows parsers crash without it. Emit zeros.

## What this repo does NOT do (YAGNI)

These were considered and explicitly rejected during the 2026-05-14 grilling — don't add them speculatively:

- Color variants (Blue/Pink/Red multi-output per project) — copy the project folder + edit palette.txt instead
- Static `.cur` companion alongside the `.ani`
- Full system-cursor packs (Desktop-style replacing all 15 Windows roles)
- Procedural code-driven frame generation
- External PNG drop-in mode
- Hot-reload watcher
- Atomic build with temp-dir rename
- Cross-platform support (Windows-only; no macOS/Linux YoloMouse exists)
- Cursor-binding management (writing `%LOCALAPPDATA%\YoloMouse\*.ini` — YoloMouse's own UI handles this)

## Project state

- Spec committed: `docs/specs/2026-05-14-cursor-forge-design.md` (commit `971682b`).
- Implementation: not yet started. Plan to be drafted via the writing-plans skill.

## When in doubt

Read the spec at `docs/specs/2026-05-14-cursor-forge-design.md`. Every decision has a rationale captured in §3 of the spec.
