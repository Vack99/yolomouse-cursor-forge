# yolomouse-cursor-forge

A collaborative pixel-art workshop for designing custom **animated cursors** for [YoloMouse](https://dragonrisegames.com/yolomouse) (Steam / Dragonrise edition). Aaron describes a cursor concept in chat — a character, a vibe, a reference — and Claude scaffolds a project, picks a palette, and authors each animation frame as a small text grid (`.grid.txt`) that's diffable, gittable, and tweakable line-by-line. One PowerShell command compiles the grids into a working Windows `.ani` file plus a YoloMouse bundle; another installs it into the YoloMouse `Cursors\` folder. Zero external dependencies — pure PowerShell 5.1 + .NET `System.Drawing`.

See `docs/specs/2026-05-14-cursor-forge-design.md` for the full design spec, and `CLAUDE.md` for the workflow Claude follows when working in this repo.
