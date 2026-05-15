---
name: MacRainbow
description: Classic Windows pointer with a flowing rainbow interior
size: 96x96
frames: 12
default_delay: 6
default_hotspot: 0,0
---

# MacRainbow — Design

## Concept

The classic Windows pointer with its white fill replaced by a flowing diagonal
rainbow. Black outline and anti-aliased edges are kept exactly as the real
cursor draws them.

## Shape source — recolour, not reconstruction

`pointer-base.png` is the 128px frame of Windows' own `aero_arrow.cur`
(extracted with `tools/cur-to-png.ps1`). The generator does not rebuild the
shape from a mask — it recolours the real cursor pixel-for-pixel:

- transparent pixels stay transparent
- dark pixels (the outline) stay black
- light pixels (the fill) become a rainbow stripe colour

The source **alpha channel is preserved untouched**, so the real cursor's
anti-aliased edges carry straight through. This is why there are no jaggies —
the smoothing is the actual Windows pointer's, not something we approximate.

## Palette choice

Apple's system colours from Big Sur+: `FF3B30`, `FF9500`, `FFCC00`, `34C759`,
`007AFF`, `AF52DE`. Saturated and distinct. The outline is the cursor's own
black; only the fill is recoloured.

## Motion plan

Diagonal stripes parallel to the anti-diagonal `(x + y) = const`. Stripe width
6 px; the 6-colour pattern repeats every 36 px. Each frame shifts the pattern
3 px toward the tip; over 12 frames it advances one full 36 px period, so the
loop is seamless.

## Resolution rationale

96×96 canvas. The pointer is a geometrically simple shape, so resolution past
~128 only buys finer staircase — and anti-aliasing already removes the
staircase. 96 keeps the file small and the per-pixel PowerShell render fast.
The base content (49×75) is scaled ~1.3× to fill the canvas — a gentle bicubic
upscale that stays smooth.

## Hotspot rationale

`0,0` — the tip of the arrow at the top-left of the canvas.

## Pipeline

`pointer-base.png` → `scripts/gen-frames.ps1` → `frames/frame_NN.png` (12
pre-rendered RGBA frames) → `forge build` packs the PNG frames directly into
the `.ani`. No `.grid.txt` and no `mask.txt` for this cursor.
