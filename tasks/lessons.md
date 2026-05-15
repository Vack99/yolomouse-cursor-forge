# Lessons

Patterns discovered while in debugging mode. Append-only.

## 2026-05-15 — GIF transparency, perceived shape bugs

**Pattern: attaching ANY PropertyItem to a bitmap suppresses GDI+'s auto-detection of the transparent palette index.**
GDI+'s GIF encoder normally inspects alpha=0 pixels and marks a palette entry transparent via the GCE (Graphic Control Extension) packed flag. The moment you call `SetPropertyItem(0x5100)` (FrameDelay) — or any other property — that auto-detection is bypassed and every frame's GCE drops its transparency flag. The cure: explicitly set `0x5104` (`PropertyTagIndexTransparent`) on **every** frame, including each one passed to `SaveAdd`, not just frame 0. Setting it only on the first frame leaves frames 1..N-1 opaque.

**Pattern: `Bitmap.GetPixel` on a decoded GIF lies about transparency.**
When System.Drawing decodes a GIF, `GetPixel` returns the palette color for "transparent" pixels regardless of whether the GCE flag is set. So a GIF that displays as a solid black square in Edge will report `A=255 R=0 G=0 B=0` from `GetPixel` — looks like "opaque black pixel," looks like a non-bug. To actually prove transparency works: parse the raw GCE bytes (`21 F9 04 <packed>`), or composite the GIF over a colored canvas via `Graphics.DrawImage` and sample the result. The composite test is what real viewers do.

**Pattern: when a user says a cursor "looks like only half a pointer," check the rendering chain (PNG vs strip vs GIF vs YoloMouse-installed) before redesigning the shape.**
In this session the cursor shape was correct (head + vertical stem matching the modern macOS pointer); the apparent missing-stem was caused by the dark-purple stem pixels being invisible against the GIF's opaque-black background after BUG-01. A speculative shape redesign (diagonal stem instead of vertical) would have produced a Windows-Aero / teardrop silhouette, not a Mac pointer, and would have collapsed the rainbow stripes from cross-diagonal bands into longitudinal streaks. Defer shape changes until the rendering pipeline is verified clean and the user re-confirms with fresh eyes.

**Pattern: PowerShell 5.1 `[int](5/2) = 2`, but `[int](2.5) = 2` and `[int](3.5) = 4`.**
PowerShell uses banker's rounding for `[int]` casts on floats — half-to-even. This silently produces off-by-one stripe indices when computing palette positions via integer division. Use `[Math]::Floor($x / 2)` for true truncation.

**Residual risks to monitor:**
- The 0x5104 fix relies on the same Activator-private-constructor trick that builds the loop-count PropertyItem. If a future host blocks reflection-based construction, the GIF will silently revert to opaque background (the existing single-frame fallback still kicks in for total encoder failure, but the no-transparency case sits in between). Worth a single explicit test that probes a known-transparent pixel post-build if/when the test suite grows to cover GIF output.
- The cursor shape (`projects/MacRainbow/frames/frame_NN.grid.txt`) is identical across all 12 frames — only interior letters shift. Any future shape change is a 12-file edit; consider regenerating via the same script in `projects/MacRainbow/design.md` rather than hand-editing.
