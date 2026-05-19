// Reference importer — turn a raw RGBA image into a starting PixelGrid.
//
// Pure: takes a buffer + palette + target size and returns a grid. PNG/JPEG
// decoding is glue and lives in the CLI. Keeping decoding out of this module
// means the deep tests can build images byte-by-byte without disk fixtures
// and never need a PNG codec.
//
// Algorithm: box-average downscale, then nearest-palette quantise per cell.
// Cells whose averaged alpha falls below ALPHA_OPAQUE_CUTOFF collapse to
// palette index 0 (the conventional transparent slot).

import { createPixelGrid, type PixelGrid } from './pixelGrid.js';
import { type PaletteEntry } from '../server/projectStore.js';

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA bytes, length = width * height * 4. */
  pixels: Uint8Array;
}

export interface ImportOptions {
  image: RgbaImage;
  /** Target side length (square). Aspect-fitted by stretching — cursors are square. */
  targetSize: number;
  palette: PaletteEntry[];
}

/** A cell with averaged-alpha at or above this threshold is treated as opaque. */
const ALPHA_OPAQUE_CUTOFF = 128;

interface Rgba { r: number; g: number; b: number; a: number }

function parseHexRgba(hex: string): Rgba {
  if (hex.length !== 8 || !/^[0-9a-f]{8}$/i.test(hex)) {
    throw new Error(`referenceImporter: palette colour must be 8 hex chars (RRGGBBAA), got '${hex}'`);
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: parseInt(hex.slice(6, 8), 16),
  };
}

/** Box-average the source region [x0..x1) × [y0..y1) into one averaged RGBA. */
function averageCell(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): Rgba {
  let r = 0, g = 0, b = 0, a = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      r += img.pixels[i + 0]!;
      g += img.pixels[i + 1]!;
      b += img.pixels[i + 2]!;
      a += img.pixels[i + 3]!;
      n++;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

function nearestPaletteIndex(target: Rgba, palette: Array<{ entry: PaletteEntry; rgba: Rgba }>): number {
  // If the cell is below the alpha cutoff, snap to index 0 — the conventional
  // transparent slot. This avoids painting "the colour the half-transparent
  // pixel happens to average to" onto fully transparent regions.
  if (target.a < ALPHA_OPAQUE_CUTOFF) return 0;
  let bestIdx = palette[0]!.entry.index;
  let bestDist = Infinity;
  for (const { entry, rgba } of palette) {
    // Don't quantise opaque cells to the transparent entry.
    if (rgba.a < ALPHA_OPAQUE_CUTOFF) continue;
    const dr = target.r - rgba.r;
    const dg = target.g - rgba.g;
    const db = target.b - rgba.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = entry.index;
    }
  }
  return bestIdx;
}

export function importReference({ image, targetSize, palette }: ImportOptions): PixelGrid {
  if (!Number.isInteger(targetSize) || targetSize <= 0) {
    throw new Error(`referenceImporter: targetSize must be a positive integer, got ${targetSize}`);
  }
  if (palette.length === 0) {
    throw new Error('referenceImporter: palette must contain at least one entry');
  }
  const expected = image.width * image.height * 4;
  if (image.pixels.length !== expected) {
    throw new Error(
      `referenceImporter: pixel buffer length ${image.pixels.length} does not match ${image.width}x${image.height}x4 = ${expected}`,
    );
  }

  const paletteResolved = palette.map((entry) => ({ entry, rgba: parseHexRgba(entry.rgba) }));

  // If no opaque entries exist the importer cannot produce anything but
  // transparent — bail loudly rather than silently emitting a blank grid.
  const hasOpaque = paletteResolved.some((p) => p.rgba.a >= ALPHA_OPAQUE_CUTOFF);
  if (!hasOpaque) {
    throw new Error('referenceImporter: palette has no opaque entries');
  }

  let grid = createPixelGrid({ width: targetSize, height: targetSize });
  const rows: number[][] = grid.pixels.map((row) => [...row]);

  for (let ty = 0; ty < targetSize; ty++) {
    const y0 = Math.floor((ty * image.height) / targetSize);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / targetSize));
    for (let tx = 0; tx < targetSize; tx++) {
      const x0 = Math.floor((tx * image.width) / targetSize);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / targetSize));
      const avg = averageCell(image, x0, y0, Math.min(x1, image.width), Math.min(y1, image.height));
      rows[ty]![tx] = nearestPaletteIndex(avg, paletteResolved);
    }
  }

  grid = { ...grid, pixels: rows };
  return grid;
}
