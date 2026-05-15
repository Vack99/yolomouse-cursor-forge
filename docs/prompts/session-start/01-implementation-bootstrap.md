# Session-start prompt — Implementation bootstrap

**Use this when:** Aaron opens a fresh Claude Code session in `yolomouse-cursor-forge` for the first time after the design spec was committed, and the goal is to **build the tool** described in the spec (not to design a cursor — that comes later, once the tool exists).

**How to use:** Copy everything below the `---` divider and paste it as your first message to Claude.

---

You're opening a session inside `C:\Users\Aaron\Documents\Repos\yolomouse-cursor-forge\` — a collaborative pixel-art workshop for designing custom animated cursors for YoloMouse (Steam edition by Dragonrise Games, installed at `C:\Program Files (x86)\Steam\steamapps\common\YoloMouse\`).

## Where things stand

The design phase is **done and committed**. What exists right now:

- `CLAUDE.md` at repo root — auto-loaded on session start; primer with workflow, commands, format quick reference, and YAGNI list. **Read it first.**
- `brief.md` — 1-paragraph mission statement.
- `docs/specs/2026-05-14-cursor-forge-design.md` — the locked design spec. Source of truth. §3 has the decision log with rationale for every structural choice; §11 has the explicit YAGNI list.
- Git is initialised, two commits on `main` (spec + docs).
- **No code exists yet.** No `forge.ps1`, no `lib/`, no `projects/_template/`, no `library/palettes/`. Implementation hasn't started.

## What I want you to do this session

1. **Orient yourself first.** Read `CLAUDE.md`, then read `docs/specs/2026-05-14-cursor-forge-design.md` cover to cover. The spec is dense but every section matters. Do this before proposing anything.

2. **Confirm git state.** Run `git log --oneline` to verify you're on `main` with the design commits and a clean working tree.

3. **Invoke the `writing-plans` skill** to draft an implementation plan from the spec. The plan should sequence the build into reviewable phases — at minimum:
   - Repo scaffolding (`.gitignore`, `README.md`, folder skeletons under `lib/`, `projects/_template/`, `library/palettes/`)
   - `lib/PixelGrid.ps1` (grid + palette parser, validates against spec §5)
   - `lib/CurWriter.ps1` and `lib/AniWriter.ps1` (the binary writers — spec §8.4 has the byte-level layout)
   - `lib/GifWriter.ps1` and `lib/BundleWriter.ps1`
   - `forge.ps1` CLI dispatcher with the seven verbs from spec §7
   - The `_template/` project + a few starter palettes
   - End-to-end smoke test: scaffold a tiny test cursor, build it, install it, verify YoloMouse picks it up. **This step is where the gotchas in §10 get verified** — especially Bundle.json `Types` value (`"animated"` vs `"basic,animated"`) and the `.ani` `flags` field.

4. **Get my approval on the plan**, then execute it via the `executing-plans` or `subagent-driven-development` skill — whichever fits the plan structure better.

## Hard constraints (do not re-debate these)

- **Stack is PowerShell 5.1 + .NET only.** No Python. No pip. No external installs of any kind. My machine has no Python and I explicitly want zero installs. Decision is locked in spec §3 row 1.
- **Follow the YAGNI list in spec §11 strictly.** Don't add color variants, static `.cur` companions, system-cursor packs, procedural frame generation, hot-reload watchers, atomic builds, or anything else listed there. They were considered and rejected.
- **All 14 structural decisions in spec §3 are locked.** Don't propose alternatives. If you spot a genuine bug or contradiction in the spec, surface it and ask — don't silently change direction.
- **The frame-authoring format is text grids** (`.grid.txt` + `palette.txt`). That's the only authoring mode. Spec §5.

## Things you'll have to verify during implementation

These are flagged in spec §10 — surface a result for each on the first end-to-end smoke test:

- Does YoloMouse accept `"Types": "animated"` in `Bundle.json`, or does it need `"basic,animated"`?
- Does `anih.flags = 0x01` produce a working `.ani` (compare via hexdump against `Cursors\Desktop\Wait.Blue.ani` if not)?
- Does `System.Drawing.Common` load on PS 5.1 without an explicit `Add-Type -AssemblyName System.Drawing`?

If anything you verify changes the spec's claims, update the spec inline (commit separately) and update `CLAUDE.md` accordingly.

## Style

Match the existing tone: terse, evidence-based, no filler. Use TaskCreate to track multi-step work. Commit per phase with messages that explain *why*, not what (`git diff` shows what). Don't write comments in code unless the WHY is non-obvious.

When in doubt, the spec wins. Get going.
