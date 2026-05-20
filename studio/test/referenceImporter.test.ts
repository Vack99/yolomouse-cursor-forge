import { describe, it, expect } from 'vitest';
import { importReference, type RgbaImage } from '../src/lib/referenceImporter.js';
import { type PaletteEntry } from '../src/server/projectStore.js';

// The reference importer is the deep module that turns a source image into a
// starting pixel grid. It is intentionally I/O-free — callers hand it raw RGBA
// bytes plus the source dimensions. PNG decoding is glue and lives in the CLI.
//
// Two responsibilities:
//   1. Downscale the source to the target size with average colour per cell.
//   2. Quantise each cell against the palette (nearest RGBA in linear distance).
//
// Index 0 in the palette is conventionally transparent; alpha-based fully-
// transparent cells collapse to it.

function solidImage(rgba: [number, number, number, number], size = 1): RgbaImage {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = rgba[0]!;
    pixels[i * 4 + 1] = rgba[1]!;
    pixels[i * 4 + 2] = rgba[2]!;
    pixels[i * 4 + 3] = rgba[3]!;
  }
  return { width: size, height: size, pixels };
}

function checkerImage(): RgbaImage {
  // 2x2 image: red, green, blue, transparent.
  const pixels = new Uint8Array([
    255, 0,   0,   255,  // (0,0) red
    0,   255, 0,   255,  // (1,0) green
    0,   0,   255, 255,  // (0,1) blue
    0,   0,   0,   0,    // (1,1) transparent
  ]);
  return { width: 2, height: 2, pixels };
}

const RGB_PALETTE: PaletteEntry[] = [
  { index: 0, rgba: '00000000' }, // transparent
  { index: 1, rgba: 'FF0000FF' }, // red
  { index: 2, rgba: '00FF00FF' }, // green
  { index: 3, rgba: '0000FFFF' }, // blue
  { index: 4, rgba: 'FFFFFFFF' }, // white
];

describe('referenceImporter', () => {
  describe('quantisation', () => {
    it('maps a pure-red 1x1 image to the red palette index', () => {
      const grid = importReference({
        image: solidImage([255, 0, 0, 255]),
        targetSize: 1,
        palette: RGB_PALETTE,
      });
      expect(grid.width).toBe(1);
      expect(grid.height).toBe(1);
      expect(grid.pixels).toEqual([[1]]);
    });

    it('maps a fully-transparent image to palette index 0', () => {
      const grid = importReference({
        image: solidImage([255, 0, 0, 0]),
        targetSize: 1,
        palette: RGB_PALETTE,
      });
      expect(grid.pixels).toEqual([[0]]);
    });

    it('picks the nearest palette colour by RGB distance', () => {
      // Off-red (200, 30, 30) is closer to FF0000 than to any other entry.
      const grid = importReference({
        image: solidImage([200, 30, 30, 255]),
        targetSize: 1,
        palette: RGB_PALETTE,
      });
      expect(grid.pixels).toEqual([[1]]);
    });
  });

  describe('downscaling', () => {
    it('reduces a 2x2 checker to a 1x1 grid via average colour', () => {
      // Average of (red, green, blue, transparent) — alpha drops below the
      // transparency cutoff, so the nearest palette entry that matches the
      // averaged RGB is found among the opaque colours. With 3/4 cells opaque
      // the average alpha is 0.75 * 255 ≈ 191, which is above the cutoff, so
      // the cell is opaque. Average RGB = (64, 64, 64) → nearest of FF0000,
      // 00FF00, 0000FF, FFFFFF is one of the primaries.
      const grid = importReference({
        image: checkerImage(),
        targetSize: 1,
        palette: RGB_PALETTE,
      });
      expect(grid.width).toBe(1);
      expect(grid.height).toBe(1);
      // Whichever primary is picked, it must be a non-zero opaque entry.
      expect(grid.pixels[0]![0]).toBeGreaterThan(0);
    });

    it('produces a target-sized grid for a larger source', () => {
      // 4x4 solid green source, target size 2 → every cell green.
      const pixels = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < 16; i++) {
        pixels[i * 4 + 1] = 255;
        pixels[i * 4 + 3] = 255;
      }
      const grid = importReference({
        image: { width: 4, height: 4, pixels },
        targetSize: 2,
        palette: RGB_PALETTE,
      });
      expect(grid.width).toBe(2);
      expect(grid.height).toBe(2);
      expect(grid.pixels).toEqual([
        [2, 2],
        [2, 2],
      ]);
    });

    it('preserves left/right colour separation when downscaling', () => {
      // 4x2 source: left half red, right half blue → 2x1 grid should be [red, blue].
      const pixels = new Uint8Array(4 * 2 * 4);
      const setPx = (x: number, y: number, r: number, g: number, b: number, a: number) => {
        const i = (y * 4 + x) * 4;
        pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
      };
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 4; x++) {
          if (x < 2) setPx(x, y, 255, 0, 0, 255);
          else       setPx(x, y, 0, 0, 255, 255);
        }
      }
      const grid = importReference({
        image: { width: 4, height: 2, pixels },
        targetSize: 2,
        palette: RGB_PALETTE,
      });
      // 4x2 → target 2 means the 2x1 source is reshaped to 2x2 (square output).
      // The horizontal red/blue split must survive in every output row.
      expect(grid.width).toBe(2);
      expect(grid.height).toBe(2);
      for (const row of grid.pixels) {
        expect(row[0]).toBe(1); // red
        expect(row[1]).toBe(3); // blue
      }
    });
  });

  describe('validation', () => {
    it('rejects non-positive target sizes', () => {
      expect(() => importReference({
        image: solidImage([0, 0, 0, 255]),
        targetSize: 0,
        palette: RGB_PALETTE,
      })).toThrow(/target/i);
    });

    it('rejects empty palettes', () => {
      expect(() => importReference({
        image: solidImage([0, 0, 0, 255]),
        targetSize: 1,
        palette: [],
      })).toThrow(/palette/i);
    });

    it('rejects pixel buffer length that does not match dimensions', () => {
      expect(() => importReference({
        image: { width: 2, height: 2, pixels: new Uint8Array(3) },
        targetSize: 1,
        palette: RGB_PALETTE,
      })).toThrow(/pixel/i);
    });
  });

  describe('determinism', () => {
    it('produces identical grids for identical inputs', () => {
      const args = {
        image: checkerImage(),
        targetSize: 2,
        palette: RGB_PALETTE,
      };
      const a = importReference(args);
      const b = importReference(args);
      expect(a.pixels).toEqual(b.pixels);
    });
  });
});
