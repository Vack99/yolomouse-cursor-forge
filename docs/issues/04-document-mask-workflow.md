# Issue #4 — Document mask-based frame authoring path in CLAUDE.md

**Tracker:** https://github.com/Vack99/yolomouse-cursor-forge/issues/4
**Label:** documentation
**Type:** AFK
**Status:** open

## What to build

CLAUDE.md currently describes the cursor authoring workflow as "Claude paints each `frames/frame_NN.grid.txt` directly." A second authoring path now exists: extract a silhouette from a reference image, save as `mask.txt`, then run a project-local generator to emit all frames programmatically. This path is undocumented, so future sessions will default to hand-painting and never discover it.

Add a section (or sub-section under "Workflow per cursor") to CLAUDE.md that:
- Names both authoring paths and when to use each
- Hand-painting: small static cursors, cursors with non-formulaic per-frame variation
- Mask-based: cursors whose animation is a deterministic per-frame transformation of a single shape (e.g. the rainbow stripe shift in MacRainbow)
- References the actual script paths after the closeout of issues #1 and #3
- Mentions `silhouette.ps1` as the way to derive a mask from a reference screenshot

Keep it tight — match the existing CLAUDE.md tone (terse, decision-focused, links to spec for rationale).

## Acceptance criteria

- [ ] CLAUDE.md describes both the hand-paint and mask-based authoring paths
- [ ] Decision criteria for choosing between them are stated
- [ ] All script paths referenced in the new section reflect the post-issue-#3 state (project-local generator location)
- [ ] `silhouette.ps1` is mentioned as the reference-extraction step
- [ ] No references to the pre-fix state of any of the tools touched in #1, #2, #3

## Blocked by

- #1 (silhouette extractor fix — docs reference its corrected behavior)
- #2 (hotspot fix — docs shouldn't promise warning-free builds while warnings still fire)
- #3 (generator relocation — docs reference the final path)
