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
4. Claude authors the frame grids — either by hand-painting each `frames\frame_NN.grid.txt` directly in chat, or by writing a `mask.txt` and running a project-local generator. See **Authoring paths** below for which to pick.
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
| `canvas` | `<Name> [-Port 5174] [-NoBrowser]` | Launch Cursor Studio (localhost browser canvas) for the project. |
| `preview` | `<Name>` | Open `build\preview.gif` and `build\preview_strip.png`. |
| `install` | `<Name>` | Copy `build\` contents into YoloMouse `Cursors\<Name>\`. |
| `uninstall` | `<Name>` | Remove `<Name>` from YoloMouse Cursors. |
| `reload` | (none) | Kill + relaunch `YoloLauncher.exe`. |
| `list` | (none) | Show all projects + build/install status. |

## Cursor Studio (`studio/`)

`forge canvas <Name>` launches **Cursor Studio**, a localhost browser canvas
that is the shared visual design surface for cursor work (PRD `#5`, umbrella
PR `#21`). The full studio shipped except for tween generation (`#18`, HITL),
loop playback (`#19`, blocked on `#18`), and the in-canvas build/install/reload
buttons (`#20`, blocked on `#18`). The `.ani` build path itself works via
`forge build` — JSON-frame support landed in `#8`.

### What shipped (12 of 15 slices)

- `forge canvas <Name>` — Node HTTP + WebSocket server + React UI; file watcher
  pushes reload events on every disk change.
- Project picker dropdown + Claude-driven switching via `forge canvas-select`.
- Candidate gallery: large main view + thumbnail strip; click to switch.
- **Lock** action freezes the selected candidate's grid and records a
  composition recipe (palette / shapes / silhouette / proportions). Workflow
  state machine advances `first → middle → last → tween-ready`.
- Minimal pixel editor — pencil / eraser / eyedropper / hotspot + undo/redo;
  hotkeys `P` / `E` / `I` / `H`, `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`.
- Onion-skin toggle (ghosts locked keyframes under the current frame),
  reference panel (`projects/<Name>/source/`), draggable hotspot crosshair.
- "Generate more candidates" expansion via `forge canvas-stage` + the
  `/api/projects/:name/candidates/:stage` POST.

### What's paused (in PR #21's HITL section)

- **`#18` — tween interpolator (HITL).** Interpolating hard-edged pixel art is
  not a naive per-pixel lerp; needs a design-review pass + a prototype on a
  representative keyframe pair before the production module lands.
- **`#19` — loop playback.** Sole blocker is `#18`.
- **`#20` — in-canvas Build / Install / Reload buttons.** Blocked on `#18`,
  though the `.ani` build path works via `forge build` today.

### Working a new cursor in the studio — the canonical loop

1. **Concept in chat.** Describe subject / aesthetic / size / palette leanings;
   Claude grills until intent is sharp. Drop reference images into
   `projects/<Name>/source/`.
2. **Scaffold.** `forge canvas-new <Name> [-Size 64]` writes the minimal
   skeleton — `palette.json` (transparent + 3 starter colors) +
   `frames/frame_00.json` (Size×Size blank, hotspot centre). The running
   studio's file watcher surfaces it in the picker live.
3. **First-frame candidates.** Claude writes 4 JSON pixel grids into
   `candidates/first/candidate_00..03.json` (via the procedural drawing
   toolkit at `studio/src/lib/drawingToolkit.ts`, or by composing primitives
   in `pnpm --dir studio gen-frame`). The gallery shows them within ~125ms.
4. **Pick + Lock.** Click a thumbnail, click **Lock this candidate**. The
   grid freezes; the workflow advances to `middle`.
5. **Middle then last.** Claude generates 2–3 middle candidates → lock →
   2–3 last candidates → lock. A lock-chain badge keeps prior keyframes
   visible in the header.
6. **Tween (paused).** When `#18` ships this is where the user picks 8 / 12 /
   24 frames and the in-betweens auto-fill. Until then the `.ani` is a
   3-frame loop from the keyframes alone.
7. **Edit.** Pixel-edits via the in-canvas editor persist via debounced PUT.
   Recipe never overwrites a manual edit (PRD acceptance criterion 6).
8. **Build + deploy.** `forge build <Name>` → `<Name>.ani` + bundle + GIF
   previews. `forge install <Name>` + `forge reload` ship to YoloMouse.

### Rules and traps (non-obvious)

- **`pnpm`, never `npm` or `yarn`.** `studio/` uses `pnpm-lock.yaml`;
  `forge canvas` shells to `pnpm`. `package.json` carries
  `pnpm.onlyBuiltDependencies: ["esbuild"]` so Vite/tsx's native binary
  installs while every other package's build scripts stay gated. From repo
  root: `pnpm --dir studio <cmd>`.
- **JSON files must be BOM-less.** PS 5.1's `Set-Content -Encoding utf8`
  prepends a UTF-8 BOM that Node's `JSON.parse` rejects with
  `Unexpected token '﻿'`. Always use
  `[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))`.
- **`pnpm --dir studio lint`** runs ESLint over `src/`. The load-bearing rule
  is `react-hooks/rules-of-hooks` — it catches the class of bug that gave us
  the black-screen flash at first project load (see `tasks/lessons.md`).
  Run before committing React-component changes.
- **Filesystem is the single source of truth.** The watcher pushes change
  events; the browser refetches. Don't add optimistic UI state that
  disagrees with disk — let the round-trip drive the UI.
- **Deep modules under `studio/src/lib/`** (pure / near-pure) carry the
  logic; **glue under `src/server/` + `src/web/`** carries the orchestration.
  Tests under `studio/test/` assert external behaviour only.

### Key files

- `forge.ps1` — verbs: `canvas`, `canvas-new`, `canvas-select`, `canvas-stage`
  (plus the legacy `new`, `build`, `install`, `reload`, `preview`, `list`).
- `studio/src/lib/pixelGrid.ts` — JSON pixel-grid schema
  (`{ version: 1, width, height, hotspot: {x,y}, pixels: int[][] }`; index 0
  is transparent) and pure ops.
- `studio/src/server/main.ts` — HTTP + WebSocket entry point.
- `studio/src/web/App.tsx` — React root + workflow wiring.
- `lib/PixelGrid.ps1` — `Read-JsonFrame` / `Read-PaletteJson` (the PowerShell
  side of JSON-frame support in `forge build`).

### Reference projects

- `projects/TracerDot/` — 16×16 arrow, the tracer fixture. `forge canvas
  TracerDot` is the smoke test for the whole stack.
- Pre-studio projects (`MacRainbow`, `PulseDot`, `Hinata`) use the legacy
  `grid.txt` / PNG-frame formats; the studio picker filters them out
  (no `palette.json`). They still build through the legacy `forge build`
  path unchanged.

## Authoring paths

Three ways to produce frames. Pick per-cursor.

**Recolor a real cursor** (best when the cursor is a variant of an existing real cursor):
- If the design is "take a real Windows/YoloMouse cursor and change its colors", do NOT reconstruct the shape from a mask — **recolor the actual pixels**.
- Extract the source cursor's largest frame: `tools\cur-to-png.ps1 <cur> <png>`. A project-local `scripts\gen-frames.ps1` then reads that base PNG and recolors per-pixel per frame.
- **Preserve the source alpha channel untouched** — that carries the real cursor's anti-aliasing straight through, so there are no jaggies and no hand-built outline. This is what finally made MacRainbow look right.
- Reference implementation: `projects\MacRainbow\` — recolors `aero_arrow.cur` (white fill → rainbow stripes, black outline kept). Emits `frame_NN.png`; `forge build` packs PNG frames directly.

**Hand-paint** (default for original art):
- Author each `frames\frame_NN.grid.txt` directly, one cell at a time.
- Right when frames vary non-formulaically — character expressions, heartbeats, anything where each frame is its own decision — or for static cursors.
- This is step 4 of the workflow above.

**Mask-based** (when animation is a deterministic per-frame transform of one shape):
- Author a single `projects\<Name>\mask.txt` — the cursor silhouette as `.` (transparent) and `#` (filled), with the same `# size`/`# hotspot` headers a `.grid.txt` uses.
- Add a project-local generator at `projects\<Name>\scripts\gen-frames.ps1` that reads the mask, classifies each filled cell as outline (any transparent 4-neighbor) or interior, and emits N frames by applying the animation formula to interior cells.
- Reference implementation: `projects\MacRainbow\scripts\gen-frames.ps1` — diagonal rainbow stripe shift, `palette[(((x + y) - frame) mod period) / stripeWidth]`.
- Generators are deliberately project-local. If a second cursor wants the same pattern, copy and adapt; only extract a shared helper once two real callers exist and we know what they share. (YAGNI — see below.)

**Extracting a mask from a reference image:**
- `tools\silhouette.ps1 -ImagePath <png> [-Cols 32] [-Threshold 128]` — pixel-samples a reference image and emits an ASCII silhouette. Crops to the largest connected dark region (screenshot borders, watermarks, etc. are ignored). Pipe the output into `mask.txt` and trim the header lines.

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
- **Anti-aliased edges are the top quality lever** — not raw resolution. Hard opaque/transparent cells make diagonals staircase. Emit partial-alpha edge cells to smooth them. Reach for AA before bumping canvas size.
- **Resolution scales with detail, not a fixed default.** Simple geometric cursors: 64–128. Detailed illustration cursors: up to 256. Past ~128, a simple shape only gains finer staircase — AA fixes that cheaper. 256×256 means large files + slow per-cell PowerShell builds; reserve it for real detail.

## What this repo does NOT do (YAGNI)

These were considered and explicitly rejected during the 2026-05-14 grilling — don't add them speculatively:

- Color variants (Blue/Pink/Red multi-output per project) — copy the project folder + edit palette.txt instead
- Static `.cur` companion alongside the `.ani`
- Full system-cursor packs (Desktop-style replacing all 15 Windows roles)
- General-purpose procedural frame generation built into `forge.ps1` (project-local generators under `projects\<Name>\scripts\` are fine — see **Authoring paths** — but no shared "stripe pattern" / "color cycle" abstractions until at least two cursors need the same one)
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
