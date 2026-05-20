# TracerDot

The tracer fixture for Cursor Studio (issue #6 / PRD #5). One hand-authored
16×16 JSON pixel grid that proves the end-to-end slice works: `forge canvas
TracerDot` should launch the studio and render this arrow with a red
hot-spot dot, against a checkerboard transparency background, with a
visible pixel grid and hotspot crosshair.

- `palette.json` — four colours: transparent / white / black outline / red dot.
- `frames/frame_00.json` — the only frame at this stage; no animation yet.

This project is deliberately committed so the studio always has something to
render after a fresh checkout.
