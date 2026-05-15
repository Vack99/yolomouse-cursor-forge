---
name: MacRainbow
description: Modern macOS pointer with a flowing rainbow interior
size: 32x32
frames: 12
default_delay: 6
default_hotspot: 1,1
---

# MacRainbow — Design

## Concept

The classic modern macOS pointer (tilted arrow with a heel cut and stem). The white outline stays static — that's what makes it read as a macOS cursor. The interior is filled with diagonal rainbow stripes (red → orange → yellow → green → blue → purple) that flow toward the tip across 12 frames, looping seamlessly.

## Palette choice

Apple's system colors from Big Sur+: `FF3B30`, `FF9500`, `FFCC00`, `34C759`, `007AFF`, `AF52DE`. Picks are thematically Apple while still being saturated/distinct at 32×32. Outline is pure white for max contrast.

## Motion plan

Diagonal stripes parallel to the anti-diagonal `(x+y) = const`. Each stripe is 2 pixels wide. Pattern repeats every 12 pixels along the diagonal.

Per-pixel color: `palette[(((x + y) - frame) mod 12) / 2]` where the palette index 0..5 maps to R, O, Y, G, B, P.

| Frame | Effect |
|---|---|
| 0 | Initial state — R band along the diagonal `x+y=0,1` |
| 1..11 | Stripes shift 1 pixel toward the tip per frame |
| 11 → 0 | Anti-diagonal wraps cleanly (period = 12 = frame count) |

## Hotspot rationale

`1,1` — the tip of the arrow. Aaron will click where the tip points, matching the macOS convention.

## Loop transition

By construction: a 12-frame cycle on a stripe with period 12. Frame 11 → frame 0 wraps exactly without a visible jump.
