import { describe, it, expect } from 'vitest';
import {
  createPixelGrid,
  getPixel,
  setPixel,
  setHotspot,
  dimensions,
  parsePixelGrid,
  serializePixelGrid,
  type PixelGrid,
} from '../src/lib/pixelGrid.js';

// The pixel grid is the foundational data structure for Cursor Studio.
// It models one animation frame: dimensions, hotspot, and a 2D array of
// palette indices. 0 is reserved for transparent; positive integers are
// palette entries. The palette itself lives in palette.json — this module
// does not care about colours, only indices.

describe('pixelGrid', () => {
  describe('createPixelGrid', () => {
    it('creates a grid filled with transparent pixels', () => {
      const g = createPixelGrid({ width: 3, height: 2 });
      expect(dimensions(g)).toEqual({ width: 3, height: 2 });
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
          expect(getPixel(g, x, y)).toBe(0);
        }
      }
    });

    it('defaults the hotspot to the grid centre', () => {
      const g = createPixelGrid({ width: 64, height: 64 });
      expect(g.hotspot).toEqual({ x: 32, y: 32 });
    });

    it('accepts an explicit hotspot', () => {
      const g = createPixelGrid({ width: 4, height: 4, hotspot: { x: 1, y: 3 } });
      expect(g.hotspot).toEqual({ x: 1, y: 3 });
    });

    it('rejects non-positive dimensions', () => {
      expect(() => createPixelGrid({ width: 0, height: 4 })).toThrow(/width/);
      expect(() => createPixelGrid({ width: 4, height: -1 })).toThrow(/height/);
    });
  });

  describe('getPixel / setPixel', () => {
    it('round-trips a written pixel', () => {
      const g = createPixelGrid({ width: 4, height: 4 });
      const next = setPixel(g, 2, 1, 7);
      expect(getPixel(next, 2, 1)).toBe(7);
      // unchanged neighbours
      expect(getPixel(next, 1, 1)).toBe(0);
      expect(getPixel(next, 3, 1)).toBe(0);
    });

    it('does not mutate the input grid (immutable update)', () => {
      const g = createPixelGrid({ width: 2, height: 2 });
      setPixel(g, 0, 0, 9);
      expect(getPixel(g, 0, 0)).toBe(0);
    });

    it('rejects out-of-bounds coordinates', () => {
      const g = createPixelGrid({ width: 2, height: 2 });
      expect(() => getPixel(g, 2, 0)).toThrow(/bounds/);
      expect(() => getPixel(g, 0, -1)).toThrow(/bounds/);
      expect(() => setPixel(g, 5, 5, 1)).toThrow(/bounds/);
    });

    it('rejects negative palette indices', () => {
      const g = createPixelGrid({ width: 1, height: 1 });
      expect(() => setPixel(g, 0, 0, -1)).toThrow(/palette index/);
    });
  });

  // Issue #16 — the hotspot crosshair on the canvas is draggable. The
  // editor reducer (or any caller) needs an immutable way to relocate the
  // hotspot without rebuilding the pixel array. Mirrors setPixel's shape:
  // pure update that returns a new grid sharing rows with the original.
  describe('setHotspot', () => {
    it('returns a new grid with the requested hotspot', () => {
      const g = createPixelGrid({ width: 4, height: 4 });
      const moved = setHotspot(g, { x: 1, y: 3 });
      expect(moved.hotspot).toEqual({ x: 1, y: 3 });
    });

    it('does not mutate the input grid', () => {
      const g = createPixelGrid({ width: 4, height: 4, hotspot: { x: 0, y: 0 } });
      setHotspot(g, { x: 2, y: 2 });
      expect(g.hotspot).toEqual({ x: 0, y: 0 });
    });

    it('preserves the pixel data', () => {
      const painted = setPixel(createPixelGrid({ width: 3, height: 3 }), 1, 1, 5);
      const moved = setHotspot(painted, { x: 0, y: 2 });
      expect(getPixel(moved, 1, 1)).toBe(5);
      // The same row references survive — the hotspot move never copies
      // pixel data.
      expect(moved.pixels).toBe(painted.pixels);
    });

    it('rejects out-of-bounds hotspots', () => {
      const g = createPixelGrid({ width: 2, height: 2 });
      expect(() => setHotspot(g, { x: 2, y: 0 })).toThrow(/hotspot/);
      expect(() => setHotspot(g, { x: 0, y: -1 })).toThrow(/hotspot/);
    });

    it('rejects non-integer hotspots', () => {
      const g = createPixelGrid({ width: 4, height: 4 });
      expect(() => setHotspot(g, { x: 1.5, y: 2 })).toThrow(/hotspot/);
    });
  });

  describe('serialize / parse round-trip', () => {
    it('serialises to the documented JSON schema', () => {
      const g = createPixelGrid({ width: 2, height: 2, hotspot: { x: 0, y: 1 } });
      const g1 = setPixel(g, 1, 0, 3);
      const json = serializePixelGrid(g1);
      expect(json).toEqual({
        version: 1,
        width: 2,
        height: 2,
        hotspot: { x: 0, y: 1 },
        pixels: [
          [0, 3],
          [0, 0],
        ],
      });
    });

    it('parses a serialised grid back to an equal value', () => {
      const original: PixelGrid = createPixelGrid({ width: 3, height: 2, hotspot: { x: 1, y: 1 } });
      const painted = setPixel(setPixel(original, 0, 0, 1), 2, 1, 2);
      const json = serializePixelGrid(painted);
      const parsed = parsePixelGrid(JSON.parse(JSON.stringify(json)));
      expect(parsed).toEqual(painted);
    });

    it('rejects malformed JSON (missing width)', () => {
      expect(() => parsePixelGrid({ height: 1, pixels: [[0]] })).toThrow(/width/);
    });

    it('rejects row count mismatch', () => {
      expect(() =>
        parsePixelGrid({ version: 1, width: 2, height: 3, hotspot: { x: 0, y: 0 }, pixels: [[0, 0], [0, 0]] }),
      ).toThrow(/rows/);
    });

    it('rejects column count mismatch', () => {
      expect(() =>
        parsePixelGrid({ version: 1, width: 3, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[0, 0]] }),
      ).toThrow(/columns/);
    });
  });
});
