import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePng } from '../src/lib/pngDecoder.js';
import { importReference } from '../src/lib/referenceImporter.js';
import { type PaletteEntry } from '../src/server/projectStore.js';

// Acceptance criterion: an end-to-end fixture image yields the expected
// quantised pixel grid. The fixture lives under tools/test-fixtures/ and is
// committed to the repo so the assertion is fully reproducible.
//
// quadrant_4x4.png is a hand-built 4x4 PNG laid out as four 2x2 quadrants:
//   ┌────┬────┐
//   │ R  │ T  │   R = solid red, T = fully transparent,
//   ├────┼────┤   G = solid green, B = solid blue.
//   │ G  │ B  │
//   └────┴────┘
// Downscaled to 2x2 and quantised against a primary-colour palette, every
// quadrant collapses to its dominant palette index.

const FIXTURE_PATH = path.resolve(
  // tools/test-fixtures lives at the repo root, two levels above studio/test/.
  __dirname,
  '..',
  '..',
  'tools',
  'test-fixtures',
  'quadrant_4x4.png',
);

const PALETTE: PaletteEntry[] = [
  { index: 0, rgba: '00000000' },
  { index: 1, rgba: 'FF0000FF' },
  { index: 2, rgba: '00FF00FF' },
  { index: 3, rgba: '0000FFFF' },
];

describe('referenceImporter + pngDecoder (fixture)', () => {
  it('quantises quadrant_4x4.png to the expected 2x2 grid', () => {
    const bytes = fs.readFileSync(FIXTURE_PATH);
    const image = decodePng(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    expect(image.width).toBe(4);
    expect(image.height).toBe(4);

    const grid = importReference({ image, targetSize: 2, palette: PALETTE });
    expect(grid.width).toBe(2);
    expect(grid.height).toBe(2);
    expect(grid.pixels).toEqual([
      [1, 0], // red,   transparent
      [2, 3], // green, blue
    ]);
  });
});
