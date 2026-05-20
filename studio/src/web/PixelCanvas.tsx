import { useCallback, useEffect, useRef } from 'react';
import { getPixel, type PixelGrid } from '../lib/pixelGrid.js';

interface PaletteEntry {
  index: number;
  rgba: string;
}

interface Palette {
  colors: PaletteEntry[];
}

interface Props {
  grid: PixelGrid;
  palette: Palette;
  /** Screen pixels per pixel of the grid. */
  pixelSize: number;
  /**
   * Optional click handler. Fires with grid-cell coordinates on pointer
   * down or drag. The renderer stays palette-agnostic — the editor reducer
   * decides what to do with the (x, y) hit.
   *
   * The parent picks per-gesture which of `onPixel` / `onHotspot` is wired
   * based on the active tool — never both at once.
   */
  onPixel?: (x: number, y: number, kind: 'down' | 'drag') => void;
  /**
   * Optional hotspot drag handler. When wired, the canvas renders a
   * drag-affordance cursor and emits the cell under the pointer on
   * down/drag. Issue #16 — the user drags the crosshair freely.
   */
  onHotspot?: (x: number, y: number) => void;
  /**
   * Optional onion-skin grids — rendered first, under the working grid, at
   * a faint global alpha. Issue #16 — ghosts the locked keyframes under
   * the current frame so the user can see drift from the approved design.
   * Renderer assumes every onion grid is the same dimensions as `grid`.
   */
  onion?: ReadonlyArray<PixelGrid>;
}

/** Global alpha used when painting onion-skin grids under the working grid. */
const ONION_ALPHA = 0.22;

function parseRgbaHex(hex: string): [number, number, number, number] {
  // Accepts 6 (RRGGBB) or 8 (RRGGBBAA) hex chars.
  const h = hex.trim();
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`palette colour must be 6 or 8 hex chars, got '${hex}'`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

function paletteLookup(palette: Palette): Map<number, [number, number, number, number]> {
  const m = new Map<number, [number, number, number, number]>();
  for (const entry of palette.colors) {
    m.set(entry.index, parseRgbaHex(entry.rgba));
  }
  return m;
}

/**
 * Renders a single PixelGrid to a `<canvas>` at `pixelSize` per cell, then
 * draws a 1px grid overlay between cells so every pixel is individually
 * visible (a hard requirement from the PRD: "clearly see the individual
 * pixels of the frame I am reviewing").
 */
export function PixelCanvas({ grid, palette, pixelSize, onPixel, onHotspot, onion }: Props): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Track the last pointer-emitted cell so a drag-across-many-cells fires
  // exactly once per cell. Without this the editor reducer's same-value
  // no-op still triggers re-renders for every mousemove event.
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);

  const pointFromEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
      const canvas = ref.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      // Use rect (CSS pixels) over canvas width (backing-store pixels) so
      // dpr-scaled displays still hit the right cell.
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const x = Math.floor(cx / pixelSize);
      const y = Math.floor(cy / pixelSize);
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
      return { x, y };
    },
    [grid.width, grid.height, pixelSize],
  );

  // Pick the single active gesture sink for this render. The parent
  // guarantees at most one of {onPixel, onHotspot} is wired at a time
  // (the active tool decides), so dispatching is a simple branch rather
  // than a multiplexer.
  const emit = useCallback(
    (x: number, y: number, kind: 'down' | 'drag'): void => {
      if (onHotspot) {
        onHotspot(x, y);
        return;
      }
      if (onPixel) {
        onPixel(x, y, kind);
      }
    },
    [onPixel, onHotspot],
  );
  const interactive = onPixel !== undefined || onHotspot !== undefined;

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!interactive) return;
      const p = pointFromEvent(e);
      if (!p) return;
      // pointer-capture lets us keep receiving moves even if the cursor
      // briefly leaves the canvas bounds during a drag.
      e.currentTarget.setPointerCapture(e.pointerId);
      lastCellRef.current = p;
      emit(p.x, p.y, 'down');
    },
    [interactive, emit, pointFromEvent],
  );

  const handleMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!interactive) return;
      if (e.buttons === 0) return;
      const p = pointFromEvent(e);
      if (!p) return;
      const last = lastCellRef.current;
      if (last && last.x === p.x && last.y === p.y) return;
      lastCellRef.current = p;
      emit(p.x, p.y, 'drag');
    },
    [interactive, emit, pointFromEvent],
  );

  const handleUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!interactive) return;
      lastCellRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [interactive],
  );

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = grid.width * pixelSize;
    const h = grid.height * pixelSize;
    // Match the backing store to logical CSS size for crisp output.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The checkerboard transparency pattern is supplied by the canvas
    // background CSS, so we leave alpha 0 cells untouched here.
    ctx.clearRect(0, 0, w, h);

    const colours = paletteLookup(palette);

    // Onion-skin first — locked keyframes ghost faintly under the working
    // grid. globalAlpha multiplies each fill's alpha, so transparent cells
    // stay transparent and the working grid above is fully opaque.
    if (onion && onion.length > 0) {
      ctx.globalAlpha = ONION_ALPHA;
      for (const ghost of onion) {
        if (ghost.width !== grid.width || ghost.height !== grid.height) continue;
        for (let y = 0; y < ghost.height; y++) {
          for (let x = 0; x < ghost.width; x++) {
            const idx = getPixel(ghost, x, y);
            const rgba = colours.get(idx);
            if (!rgba || rgba[3] === 0) continue;
            ctx.fillStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;
            ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = getPixel(grid, x, y);
        const rgba = colours.get(idx);
        if (!rgba || rgba[3] === 0) continue;
        ctx.fillStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;
        ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
      }
    }

    // Pixel-grid overlay — light lines between every cell, slightly stronger
    // at the hotspot crosshair so the user can locate it.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= grid.width; x++) {
      const px = x * pixelSize + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let y = 0; y <= grid.height; y++) {
      const py = y * pixelSize + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();

    // Hotspot crosshair.
    const hx = grid.hotspot.x * pixelSize + pixelSize / 2;
    const hy = grid.hotspot.y * pixelSize + pixelSize / 2;
    ctx.strokeStyle = 'rgba(255,184,107,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx - pixelSize, hy);
    ctx.lineTo(hx + pixelSize, hy);
    ctx.moveTo(hx, hy - pixelSize);
    ctx.lineTo(hx, hy + pixelSize);
    ctx.stroke();
  }, [grid, palette, pixelSize, onion]);

  return (
    <canvas
      ref={ref}
      className="studio__canvas"
      onPointerDown={interactive ? handleDown : undefined}
      onPointerMove={interactive ? handleMove : undefined}
      onPointerUp={interactive ? handleUp : undefined}
      onPointerCancel={interactive ? handleUp : undefined}
      // Hotspot mode uses a `move` cursor so the gesture reads as
      // repositioning, not painting.
      style={
        interactive
          ? { cursor: onHotspot ? 'move' : 'crosshair', touchAction: 'none' }
          : undefined
      }
    />
  );
}
