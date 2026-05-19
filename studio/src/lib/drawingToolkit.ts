// Drawing toolkit — deterministic procedural primitives over a PixelGrid.
//
// Every primitive is a pure function: it takes a grid plus parameters and
// returns a new grid. The input is never mutated. Out-of-bounds writes are
// silently clipped — drawing 'off the edge' is a common authoring pattern
// (e.g. a circle that bleeds off-canvas) and should not throw.
//
// Determinism is the headline contract: identical inputs produce identical
// outputs every time. No randomness, no clocks, no map iteration order
// dependence on insertion (we read explicit keys).

import { type PixelGrid } from './pixelGrid.js';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectParams extends Region {
  paletteIndex: number;
}

export interface LineParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  paletteIndex: number;
}

export interface GradientParams {
  /** 'x' = horizontal bands (left → right); 'y' = vertical bands (top → bottom). */
  axis: 'x' | 'y';
  /** Ordered list of palette indices. Cells map to the nearest stop. */
  stops: number[];
  /** Optional region; defaults to the whole grid. */
  region?: Region;
}

export interface FloodParams {
  x: number;
  y: number;
  paletteIndex: number;
}

/** Per-row clone helper that writes via a (x, y, idx) callback and returns the new grid. */
function withMutableRows(grid: PixelGrid, write: (rows: number[][]) => void): PixelGrid {
  // We pessimistically copy every row. The cost is O(h*w) but the API is
  // small and rarely called in a tight loop — the price of pure semantics.
  const rows: number[][] = grid.pixels.map((row) => [...row]);
  write(rows);
  return { ...grid, pixels: rows };
}

function inBounds(grid: PixelGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

function assertPaletteIndex(paletteIndex: number): void {
  if (!Number.isInteger(paletteIndex) || paletteIndex < 0) {
    throw new Error(`drawingToolkit: palette index must be a non-negative integer, got ${paletteIndex}`);
  }
}

/** Paint the 1-cell outline of a rectangle. Clips to grid bounds. */
export function drawRect(grid: PixelGrid, params: RectParams): PixelGrid {
  assertPaletteIndex(params.paletteIndex);
  const { x, y, width, height, paletteIndex } = params;
  if (width <= 0 || height <= 0) return grid;
  return withMutableRows(grid, (rows) => {
    const x1 = x + width - 1;
    const y1 = y + height - 1;
    for (let cx = x; cx <= x1; cx++) {
      if (inBounds(grid, cx, y)) rows[y]![cx] = paletteIndex;
      if (inBounds(grid, cx, y1)) rows[y1]![cx] = paletteIndex;
    }
    for (let cy = y; cy <= y1; cy++) {
      if (inBounds(grid, x, cy)) rows[cy]![x] = paletteIndex;
      if (inBounds(grid, x1, cy)) rows[cy]![x1] = paletteIndex;
    }
  });
}

/** Paint a solid rectangle. Clips to grid bounds. */
export function fillRect(grid: PixelGrid, params: RectParams): PixelGrid {
  assertPaletteIndex(params.paletteIndex);
  const { x, y, width, height, paletteIndex } = params;
  if (width <= 0 || height <= 0) return grid;
  return withMutableRows(grid, (rows) => {
    const xMin = Math.max(0, x);
    const yMin = Math.max(0, y);
    const xMax = Math.min(grid.width - 1, x + width - 1);
    const yMax = Math.min(grid.height - 1, y + height - 1);
    for (let cy = yMin; cy <= yMax; cy++) {
      const row = rows[cy]!;
      for (let cx = xMin; cx <= xMax; cx++) {
        row[cx] = paletteIndex;
      }
    }
  });
}

/**
 * Paint a 1-pixel-wide line using Bresenham's algorithm. Symmetric: swapping
 * endpoints produces the same set of pixels. Clips to grid bounds.
 */
export function drawLine(grid: PixelGrid, params: LineParams): PixelGrid {
  assertPaletteIndex(params.paletteIndex);
  const { paletteIndex } = params;
  let { x0, y0, x1, y1 } = params;
  return withMutableRows(grid, (rows) => {
    // Canonicalise endpoint order so reversing inputs yields the same path.
    // We sort by x (then by y) — gives the same trace regardless of which end
    // the caller supplied as "0".
    if (x1 < x0 || (x1 === x0 && y1 < y0)) {
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
    }
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let cx = x0;
    let cy = y0;
    // Bounded loop guard against pathological inputs.
    const maxSteps = dx - dy + 1;
    for (let i = 0; i <= maxSteps; i++) {
      if (inBounds(grid, cx, cy)) rows[cy]![cx] = paletteIndex;
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
  });
}

/**
 * Paint a stepped gradient. Cells map to the nearest stop along the chosen
 * axis; with 2 stops on a 6-wide grid you get 3 cells per stop.
 *
 * This is intentionally a *stepped* gradient, not a per-pixel interpolation:
 * pixel art reads as bands, and palette indices don't blend.
 */
export function drawGradient(grid: PixelGrid, params: GradientParams): PixelGrid {
  const { axis, stops, region } = params;
  if (stops.length === 0) {
    throw new Error('drawingToolkit: gradient requires at least one stop');
  }
  for (const idx of stops) assertPaletteIndex(idx);
  const rx = region?.x ?? 0;
  const ry = region?.y ?? 0;
  const rw = region?.width ?? grid.width;
  const rh = region?.height ?? grid.height;
  if (rw <= 0 || rh <= 0) return grid;
  const span = axis === 'x' ? rw : rh;
  return withMutableRows(grid, (rows) => {
    for (let cy = ry; cy < ry + rh; cy++) {
      for (let cx = rx; cx < rx + rw; cx++) {
        if (!inBounds(grid, cx, cy)) continue;
        const t = axis === 'x' ? cx - rx : cy - ry;
        // Map t in [0, span-1] to a stop index. Floor division gives a stable
        // band size: span=6, stops=2 → cells per stop = ceil(6/2)=3.
        const cellsPerStop = Math.max(1, Math.ceil(span / stops.length));
        const stopIndex = Math.min(stops.length - 1, Math.floor(t / cellsPerStop));
        rows[cy]![cx] = stops[stopIndex]!;
      }
    }
  });
}

/** Substitute palette indices via a lookup table. Indices absent from the
 *  table pass through unchanged. */
export function remapPalette(grid: PixelGrid, lut: Record<number, number>): PixelGrid {
  for (const v of Object.values(lut)) assertPaletteIndex(v);
  return withMutableRows(grid, (rows) => {
    for (let y = 0; y < grid.height; y++) {
      const row = rows[y]!;
      for (let x = 0; x < grid.width; x++) {
        const v = row[x]!;
        const mapped = lut[v];
        if (mapped !== undefined) row[x] = mapped;
      }
    }
  });
}

/**
 * 4-connected flood fill from a seed pixel. Replaces every cell reachable
 * from the seed that shares the seed's original palette index.
 */
export function floodFill(grid: PixelGrid, params: FloodParams): PixelGrid {
  assertPaletteIndex(params.paletteIndex);
  const { x: sx, y: sy, paletteIndex } = params;
  if (!inBounds(grid, sx, sy)) return grid;
  const seedIndex = grid.pixels[sy]![sx]!;
  if (seedIndex === paletteIndex) return grid;
  return withMutableRows(grid, (rows) => {
    const stack: Array<[number, number]> = [[sx, sy]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) continue;
      if (rows[cy]![cx] !== seedIndex) continue;
      rows[cy]![cx] = paletteIndex;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  });
}
