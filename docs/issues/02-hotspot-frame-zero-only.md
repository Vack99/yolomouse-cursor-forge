# Issue #2 — Frame generator: emit hotspot only on frame 0

**Tracker:** https://github.com/Vack99/yolomouse-cursor-forge/issues/2
**Label:** bug
**Type:** AFK
**Status:** open

## What to build

The rainbow frame generator currently writes a `# hotspot X,Y` header into every generated `frame_NN.grid.txt`. The forge build pipeline correctly ignores per-frame hotspots (Windows `.ani` uses frame_00's hotspot for the entire animation per CLAUDE.md), but it warns once per frame after frame 0 — producing 11 spurious "per-frame hotspot ignored" warnings on every build of MacRainbow.

Update the generator so the hotspot header is emitted on frame 0 only. Other frames omit it entirely.

## Acceptance criteria

- [ ] Running the generator for MacRainbow produces frames where `frame_00.grid.txt` contains a `# hotspot` line and frames 01..N do not
- [ ] `forge build MacRainbow` produces zero "per-frame hotspot ignored" warnings
- [ ] Behavior is unchanged at runtime — the rendered cursor's hotspot is still the one declared in frame 0

## Blocked by

None - can start immediately
