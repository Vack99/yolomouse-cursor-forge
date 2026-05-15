# Issue #3 — Move rainbow frame generator into MacRainbow project

**Tracker:** https://github.com/Vack99/yolomouse-cursor-forge/issues/3
**Label:** enhancement
**Type:** AFK
**Status:** closed

## What to build

`tools/gen-rainbow-frames.ps1` lives in the shared tools directory and is named like a general-purpose tool, but it hardcodes the diagonal-stripe formula `palette[(((x+y) - frame) mod period) / stripeWidth]`. That formula serves exactly one cursor (MacRainbow). Naming and location currently overpromise reuse.

Relocate and rename the script so its scope matches its actual responsibility: a project-local generator for MacRainbow's rainbow-stripe animation. New home: `projects/MacRainbow/scripts/gen-frames.ps1` (or equivalent project-local convention).

This is a deliberate YAGNI choice. If a second cursor later needs a similar diagonal-stripe generator, extract a shared helper at that point — when we know what the second caller actually needs.

Update any callers (CLAUDE.md, build helpers, in-line comments) to reference the new path.

## Acceptance criteria

- [ ] `tools/gen-rainbow-frames.ps1` is removed
- [ ] Equivalent script exists at `projects/MacRainbow/scripts/gen-frames.ps1` (or chosen project-local path) and produces byte-identical output to the original when run against the current `mask.txt`
- [ ] No remaining references to the old path anywhere in the repo
- [ ] Build pipeline still produces the same `.ani` for MacRainbow

## Blocked by

None - can start immediately
