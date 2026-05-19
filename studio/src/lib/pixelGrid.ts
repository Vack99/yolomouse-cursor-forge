// Pixel-grid model — one frame of a cursor animation.
//
// JSON schema (version 1):
//   {
//     "version": 1,
//     "width":   <int>,
//     "height":  <int>,
//     "hotspot": { "x": <int>, "y": <int> },
//     "pixels":  [[<idx>, ...], ...]   // height rows of width ints
//   }
//
// Palette indices are non-negative ints. 0 is reserved for "transparent".
// Positive values index into a per-project palette.json — this module is
// palette-agnostic on purpose.

export type Point = { x: number; y: number };

export interface PixelGrid {
  readonly width: number;
  readonly height: number;
  readonly hotspot: Point;
  /** Row-major: pixels[y][x]. Treated as immutable. */
  readonly pixels: ReadonlyArray<ReadonlyArray<number>>;
}

export interface PixelGridJson {
  version: 1;
  width: number;
  height: number;
  hotspot: Point;
  pixels: number[][];
}

export interface CreateOptions {
  width: number;
  height: number;
  hotspot?: Point;
}

export function createPixelGrid({ width, height, hotspot }: CreateOptions): PixelGrid {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`pixelGrid: width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`pixelGrid: height must be a positive integer, got ${height}`);
  }
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row = new Array<number>(width).fill(0);
    rows.push(row);
  }
  return {
    width,
    height,
    hotspot: hotspot ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) },
    pixels: rows,
  };
}

export function dimensions(grid: PixelGrid): { width: number; height: number } {
  return { width: grid.width, height: grid.height };
}

function assertInBounds(grid: PixelGrid, x: number, y: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid.width || y >= grid.height) {
    throw new Error(`pixelGrid: (${x}, ${y}) out of bounds for ${grid.width}x${grid.height} grid`);
  }
}

export function getPixel(grid: PixelGrid, x: number, y: number): number {
  assertInBounds(grid, x, y);
  return grid.pixels[y]![x]!;
}

export function setPixel(grid: PixelGrid, x: number, y: number, paletteIndex: number): PixelGrid {
  assertInBounds(grid, x, y);
  if (!Number.isInteger(paletteIndex) || paletteIndex < 0) {
    throw new Error(`pixelGrid: palette index must be a non-negative integer, got ${paletteIndex}`);
  }
  // Copy only the modified row so most rows share references with the input.
  const nextRows: number[][] = grid.pixels.map((row, ry) => (ry === y ? [...row] : (row as number[])));
  nextRows[y]![x] = paletteIndex;
  return { ...grid, pixels: nextRows };
}

export function serializePixelGrid(grid: PixelGrid): PixelGridJson {
  return {
    version: 1,
    width: grid.width,
    height: grid.height,
    hotspot: { x: grid.hotspot.x, y: grid.hotspot.y },
    pixels: grid.pixels.map((row) => [...row]),
  };
}

export function parsePixelGrid(raw: unknown): PixelGrid {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('pixelGrid: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const width = obj.width;
  const height = obj.height;
  if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0) {
    throw new Error('pixelGrid: width must be a positive integer');
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height <= 0) {
    throw new Error('pixelGrid: height must be a positive integer');
  }
  const hotspotRaw = obj.hotspot;
  let hotspot: Point;
  if (hotspotRaw === undefined) {
    hotspot = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  } else if (typeof hotspotRaw === 'object' && hotspotRaw !== null) {
    const hs = hotspotRaw as Record<string, unknown>;
    if (typeof hs.x !== 'number' || typeof hs.y !== 'number') {
      throw new Error('pixelGrid: hotspot.x and hotspot.y must be numbers');
    }
    hotspot = { x: hs.x, y: hs.y };
  } else {
    throw new Error('pixelGrid: hotspot must be an object');
  }
  const pixelsRaw = obj.pixels;
  if (!Array.isArray(pixelsRaw)) {
    throw new Error('pixelGrid: pixels must be a 2D array');
  }
  if (pixelsRaw.length !== height) {
    throw new Error(`pixelGrid: expected ${height} rows, got ${pixelsRaw.length}`);
  }
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row = pixelsRaw[y];
    if (!Array.isArray(row)) {
      throw new Error(`pixelGrid: row ${y} is not an array`);
    }
    if (row.length !== width) {
      throw new Error(`pixelGrid: row ${y} has ${row.length} columns, expected ${width}`);
    }
    const out = new Array<number>(width);
    for (let x = 0; x < width; x++) {
      const v = row[x];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(`pixelGrid: pixel at (${x}, ${y}) must be a non-negative integer, got ${String(v)}`);
      }
      out[x] = v;
    }
    rows.push(out);
  }
  return { width, height, hotspot, pixels: rows };
}
