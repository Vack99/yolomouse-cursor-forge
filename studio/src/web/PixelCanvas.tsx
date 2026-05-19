import { useEffect, useRef } from 'react';
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
}

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
export function PixelCanvas({ grid, palette, pixelSize }: Props): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);

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
  }, [grid, palette, pixelSize]);

  return <canvas ref={ref} className="studio__canvas" />;
}
