# Issue #1 — silhouette extractor: detect content bbox correctly

**Tracker:** https://github.com/Vack99/yolomouse-cursor-forge/issues/1
**Label:** bug
**Type:** AFK
**Status:** open

## What to build

`tools/silhouette.ps1` claims to crop its output to the bounding box of dark pixels in the source image, but the bbox detection treats near-black border pixels (introduced by screenshot tooling, PNG metadata, etc.) as content. Result: the bbox spans the whole image and the actual cursor ends up inset by ~9 columns in the silhouette. Callers have to manually trim the output before using it.

Fix the extractor so that the bbox reflects the actual cursor content, not screenshot padding. Approach is open — viable options include:
- Detect the largest connected dark region and use its bounds
- Trim rows/columns from the bbox edges that are uniformly (or nearly uniformly) light
- Erode/dilate isolated dark pixels before computing bbox

Output: a tight silhouette where row 0 col 0 of the ASCII grid corresponds to the topmost-leftmost dark cursor pixel.

## Acceptance criteria

- [ ] Re-running `tools/silhouette.ps1 -ImagePath <pointer screenshot> -Cols 32` against the original pointer screenshot produces a silhouette where the cursor TIP is at row 0 col 0 (or row 1 col 1 with a 1-cell margin), not col 9
- [ ] Header comment in the output accurately reports the detected content bbox (not the source dimensions)
- [ ] Tool's behavior matches its documented purpose — no manual trimming needed by callers
- [ ] Tested against at least one additional reference image (e.g. another cursor screenshot or a synthetic test image with known padding) to confirm the fix isn't overfit to one screenshot

## Blocked by

None - can start immediately
