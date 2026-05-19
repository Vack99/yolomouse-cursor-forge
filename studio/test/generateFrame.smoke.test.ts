import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateFrame } from '../src/cli/generateFrame.js';
import { parsePixelGrid } from '../src/lib/pixelGrid.js';

// Smoke test: stand up a fake repo + project on a temp dir, feed the CLI a
// composition that exercises every primitive plus importReference, and
// verify the JSON pixel grid on disk parses back to a sensible PixelGrid.

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeProject(name: string): { projectDir: string } {
  const projectDir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(projectDir, 'frames'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'palette.json'),
    JSON.stringify({
      version: 1,
      colors: [
        { index: 0, rgba: '00000000' },
        { index: 1, rgba: 'FF0000FF' },
        { index: 2, rgba: '00FF00FF' },
        { index: 3, rgba: '0000FFFF' },
        { index: 4, rgba: 'FFFFFFFF' },
      ],
    }, null, 2),
    'utf8',
  );
  return { projectDir };
}

describe('generateFrame CLI (smoke)', () => {
  it('composes primitives and writes a JSON pixel grid the parser accepts', () => {
    const { projectDir } = writeProject('Demo');
    const compPath = path.join(tmpRoot, 'composition.json');
    fs.writeFileSync(compPath, JSON.stringify({
      version: 1,
      width: 4,
      height: 4,
      hotspot: { x: 2, y: 2 },
      steps: [
        { op: 'fillRect', x: 0, y: 0, width: 4, height: 4, paletteIndex: 4 },
        { op: 'drawRect', x: 0, y: 0, width: 4, height: 4, paletteIndex: 2 },
        { op: 'drawLine', x0: 0, y0: 0, x1: 3, y1: 3, paletteIndex: 1 },
        { op: 'floodFill', x: 2, y: 1, paletteIndex: 3 },
        { op: 'remapPalette', map: { 4: 0 } },
      ],
    }, null, 2));

    const { outPath, grid } = generateFrame({
      project: 'Demo',
      composition: compPath,
      out: 'frames/frame_00.json',
      repoRoot: tmpRoot,
    });

    expect(outPath).toBe(path.join(projectDir, 'frames', 'frame_00.json'));
    expect(fs.existsSync(outPath)).toBe(true);

    const onDisk = parsePixelGrid(JSON.parse(fs.readFileSync(outPath, 'utf8')));
    expect(onDisk).toEqual(grid);
    expect(onDisk.width).toBe(4);
    expect(onDisk.height).toBe(4);
    expect(onDisk.hotspot).toEqual({ x: 2, y: 2 });

    // Outline should be index 2 except where the diagonal (1) overpaints it,
    // and the remap collapses the 4-fill to transparent (0) inside.
    // (0,0) is corner: filled by fillRect=4, then outline=2, then line=1 → 1.
    expect(onDisk.pixels[0]![0]).toBe(1);
    // (3,3) endpoint of diagonal → 1.
    expect(onDisk.pixels[3]![3]).toBe(1);
    // (0,3) bottom-left corner: fill 4 → outline 2 → line skips → remap leaves 2 → 2.
    expect(onDisk.pixels[3]![0]).toBe(2);
  });

  it('importReference seeds a grid from a PNG, then later primitives paint on top', () => {
    const { projectDir } = writeProject('FromImage');
    // Copy the fixture into the project so the relative path resolves.
    const fixture = path.resolve(__dirname, '..', '..', 'tools', 'test-fixtures', 'quadrant_4x4.png');
    fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
    fs.copyFileSync(fixture, path.join(projectDir, 'source', 'ref.png'));

    const compPath = path.join(tmpRoot, 'composition.json');
    fs.writeFileSync(compPath, JSON.stringify({
      version: 1,
      width: 2,
      height: 2,
      steps: [
        { op: 'importReference', imagePath: 'source/ref.png', targetSize: 2 },
        // Paint a single pixel over the imported grid to prove ordering.
        { op: 'fillRect', x: 1, y: 1, width: 1, height: 1, paletteIndex: 4 },
      ],
    }, null, 2));

    const { grid } = generateFrame({
      project: 'FromImage',
      composition: compPath,
      out: 'frames/frame_00.json',
      repoRoot: tmpRoot,
    });
    expect(grid.pixels).toEqual([
      [1, 0], // imported red, imported transparent
      [2, 4], // imported green, overpainted white (idx 4)
    ]);
  });
});
