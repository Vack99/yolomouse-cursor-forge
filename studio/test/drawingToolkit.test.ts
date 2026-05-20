import { describe, it, expect } from 'vitest';
import {
  drawRect,
  fillRect,
  drawLine,
  drawGradient,
  remapPalette,
  floodFill,
} from '../src/lib/drawingToolkit.js';
import { createPixelGrid, getPixel, setPixel } from '../src/lib/pixelGrid.js';

// The drawing toolkit is the procedural authoring primitive set. Each primitive
// is a pure function: (grid, params) -> grid. Identical inputs MUST produce
// identical outputs; nothing is allowed to read clocks or randomness. Every
// primitive returns a new grid; the input is never mutated.

describe('drawingToolkit', () => {
  describe('drawRect (outline)', () => {
    it('paints exactly the four edges of an axis-aligned rectangle', () => {
      const g = createPixelGrid({ width: 5, height: 5 });
      const out = drawRect(g, { x: 1, y: 1, width: 3, height: 3, paletteIndex: 2 });
      expect(out.pixels).toEqual([
        [0, 0, 0, 0, 0],
        [0, 2, 2, 2, 0],
        [0, 2, 0, 2, 0],
        [0, 2, 2, 2, 0],
        [0, 0, 0, 0, 0],
      ]);
    });

    it('clips to grid bounds without throwing', () => {
      const g = createPixelGrid({ width: 3, height: 3 });
      const out = drawRect(g, { x: -1, y: -1, width: 4, height: 4, paletteIndex: 1 });
      // The interior at (0,0)..(2,2) should not be drawn — only the visible edges.
      // Visible edges of the rect: top row clipped (y=-1 off-grid), left col clipped,
      // right edge at x=2 (top..bottom), bottom edge at y=2.
      expect(out.pixels).toEqual([
        [0, 0, 1],
        [0, 0, 1],
        [1, 1, 1],
      ]);
    });

    it('produces a 1x1 rect for width=height=1', () => {
      const g = createPixelGrid({ width: 3, height: 3 });
      const out = drawRect(g, { x: 1, y: 1, width: 1, height: 1, paletteIndex: 9 });
      expect(getPixel(out, 1, 1)).toBe(9);
      expect(getPixel(out, 0, 0)).toBe(0);
    });
  });

  describe('fillRect (solid)', () => {
    it('fills every cell of the rectangle', () => {
      const g = createPixelGrid({ width: 4, height: 3 });
      const out = fillRect(g, { x: 1, y: 0, width: 2, height: 2, paletteIndex: 5 });
      expect(out.pixels).toEqual([
        [0, 5, 5, 0],
        [0, 5, 5, 0],
        [0, 0, 0, 0],
      ]);
    });

    it('clips to grid bounds', () => {
      const g = createPixelGrid({ width: 3, height: 3 });
      const out = fillRect(g, { x: 2, y: 2, width: 5, height: 5, paletteIndex: 4 });
      expect(getPixel(out, 2, 2)).toBe(4);
      // Everything else untouched.
      let painted = 0;
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (getPixel(out, x, y) !== 0) painted++;
      expect(painted).toBe(1);
    });
  });

  describe('drawLine (Bresenham)', () => {
    it('paints a horizontal line', () => {
      const g = createPixelGrid({ width: 5, height: 3 });
      const out = drawLine(g, { x0: 1, y0: 1, x1: 3, y1: 1, paletteIndex: 1 });
      expect(out.pixels).toEqual([
        [0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0],
      ]);
    });

    it('paints a vertical line', () => {
      const g = createPixelGrid({ width: 3, height: 4 });
      const out = drawLine(g, { x0: 1, y0: 0, x1: 1, y1: 3, paletteIndex: 2 });
      expect(out.pixels).toEqual([
        [0, 2, 0],
        [0, 2, 0],
        [0, 2, 0],
        [0, 2, 0],
      ]);
    });

    it('paints a 45-degree diagonal line', () => {
      const g = createPixelGrid({ width: 4, height: 4 });
      const out = drawLine(g, { x0: 0, y0: 0, x1: 3, y1: 3, paletteIndex: 3 });
      expect(out.pixels).toEqual([
        [3, 0, 0, 0],
        [0, 3, 0, 0],
        [0, 0, 3, 0],
        [0, 0, 0, 3],
      ]);
    });

    it('paints a shallow line with Bresenham step pattern', () => {
      const g = createPixelGrid({ width: 5, height: 3 });
      // From (0,0) to (4,1) — shallow slope, two-row staircase, step at midpoint.
      const out = drawLine(g, { x0: 0, y0: 0, x1: 4, y1: 1, paletteIndex: 1 });
      // Symmetric Bresenham: y advances once at the midpoint of the 5 x-steps.
      expect(out.pixels).toEqual([
        [1, 1, 0, 0, 0],
        [0, 0, 1, 1, 1],
        [0, 0, 0, 0, 0],
      ]);
    });

    it('is symmetric: swapping endpoints paints the same pixels', () => {
      const a = drawLine(createPixelGrid({ width: 5, height: 5 }), { x0: 0, y0: 0, x1: 4, y1: 2, paletteIndex: 7 });
      const b = drawLine(createPixelGrid({ width: 5, height: 5 }), { x0: 4, y0: 2, x1: 0, y1: 0, paletteIndex: 7 });
      expect(b.pixels).toEqual(a.pixels);
    });
  });

  describe('drawGradient (linear, axis-aligned)', () => {
    it('writes evenly-spaced bands along the x axis', () => {
      // 4 wide, 1 tall, palette stops [1, 2, 3, 4] — one stop per column.
      const g = createPixelGrid({ width: 4, height: 1 });
      const out = drawGradient(g, { axis: 'x', stops: [1, 2, 3, 4] });
      expect(out.pixels).toEqual([[1, 2, 3, 4]]);
    });

    it('writes evenly-spaced bands along the y axis', () => {
      const g = createPixelGrid({ width: 1, height: 4 });
      const out = drawGradient(g, { axis: 'y', stops: [5, 6, 7, 8] });
      expect(out.pixels).toEqual([[5], [6], [7], [8]]);
    });

    it('repeats the nearest stop when grid is longer than the stop list', () => {
      // 6 columns, 2 stops [1, 2]: first 3 columns = 1, next 3 = 2.
      const g = createPixelGrid({ width: 6, height: 1 });
      const out = drawGradient(g, { axis: 'x', stops: [1, 2] });
      expect(out.pixels).toEqual([[1, 1, 1, 2, 2, 2]]);
    });

    it('honours an explicit region', () => {
      const g = createPixelGrid({ width: 4, height: 2 });
      const out = drawGradient(g, {
        axis: 'x',
        stops: [1, 2],
        region: { x: 1, y: 0, width: 2, height: 2 },
      });
      expect(out.pixels).toEqual([
        [0, 1, 2, 0],
        [0, 1, 2, 0],
      ]);
    });
  });

  describe('remapPalette', () => {
    it('remaps every pixel according to the lookup table', () => {
      let g = createPixelGrid({ width: 2, height: 2 });
      g = setPixel(g, 0, 0, 1);
      g = setPixel(g, 1, 0, 2);
      g = setPixel(g, 0, 1, 3);
      const out = remapPalette(g, { 1: 10, 2: 20, 3: 30 });
      expect(out.pixels).toEqual([
        [10, 20],
        [30, 0],
      ]);
    });

    it('leaves indices not in the map untouched', () => {
      let g = createPixelGrid({ width: 2, height: 1 });
      g = setPixel(g, 0, 0, 7);
      g = setPixel(g, 1, 0, 8);
      const out = remapPalette(g, { 7: 1 });
      expect(out.pixels).toEqual([[1, 8]]);
    });
  });

  describe('floodFill (4-connected)', () => {
    it('fills a connected region of identical indices', () => {
      // Start with a 4x4 grid with a small inset already filled with index 1.
      let g = createPixelGrid({ width: 4, height: 4 });
      g = fillRect(g, { x: 1, y: 1, width: 2, height: 2, paletteIndex: 1 });
      const out = floodFill(g, { x: 1, y: 1, paletteIndex: 5 });
      expect(out.pixels).toEqual([
        [0, 0, 0, 0],
        [0, 5, 5, 0],
        [0, 5, 5, 0],
        [0, 0, 0, 0],
      ]);
    });

    it('does not cross a boundary of a different index', () => {
      // Surround a 0-region with 9s and flood the 0-region; the 9s stay.
      const g0 = createPixelGrid({ width: 3, height: 3 });
      const ringed = drawRect(g0, { x: 0, y: 0, width: 3, height: 3, paletteIndex: 9 });
      const out = floodFill(ringed, { x: 1, y: 1, paletteIndex: 4 });
      expect(out.pixels).toEqual([
        [9, 9, 9],
        [9, 4, 9],
        [9, 9, 9],
      ]);
    });

    it('is a no-op when seed already has the target index', () => {
      const g = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 3);
      const out = floodFill(g, { x: 0, y: 0, paletteIndex: 3 });
      expect(out).toEqual(g);
    });
  });

  describe('determinism', () => {
    it('produces byte-identical grids across two identical calls', () => {
      const make = () => {
        let g = createPixelGrid({ width: 8, height: 8 });
        g = fillRect(g, { x: 0, y: 0, width: 8, height: 8, paletteIndex: 1 });
        g = drawRect(g, { x: 1, y: 1, width: 6, height: 6, paletteIndex: 2 });
        g = drawLine(g, { x0: 0, y0: 0, x1: 7, y1: 7, paletteIndex: 3 });
        g = drawGradient(g, { axis: 'y', stops: [4, 5], region: { x: 7, y: 0, width: 1, height: 8 } });
        return g;
      };
      expect(make().pixels).toEqual(make().pixels);
    });
  });
});
