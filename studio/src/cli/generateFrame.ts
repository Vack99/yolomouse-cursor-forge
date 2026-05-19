// generateFrame — terminal entry point for procedural frame authoring.
//
// Usage:
//   npm --prefix studio run gen-frame -- \
//       --project MacRainbow \
//       --composition path/to/composition.json \
//       --out frames/frame_00.json
//
// The composition file is a small JSON document describing a list of steps.
// Each step is one primitive call. The CLI threads a PixelGrid through the
// steps and writes the resulting frame to <repoRoot>/projects/<project>/<out>.
//
// Composition schema (version 1):
//   {
//     "version": 1,
//     "width":  64,
//     "height": 64,
//     "hotspot": { "x": 32, "y": 32 },   // optional
//     "steps": [
//       { "op": "fillRect",   "x": 0, "y": 0, "width": 64, "height": 64, "paletteIndex": 1 },
//       { "op": "drawRect",   "x": 4, "y": 4, "width": 56, "height": 56, "paletteIndex": 2 },
//       { "op": "drawLine",   "x0": 0, "y0": 0, "x1": 63, "y1": 63, "paletteIndex": 3 },
//       { "op": "drawGradient","axis": "y", "stops": [4, 5, 6] },
//       { "op": "remapPalette","map": { "1": 7, "2": 8 } },
//       { "op": "floodFill",  "x": 32, "y": 32, "paletteIndex": 9 },
//       { "op": "importReference", "imagePath": "source/ref.png", "targetSize": 64 }
//     ]
//   }
//
// importReference replaces the current grid wholesale; subsequent primitives
// paint on top of it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPixelGrid,
  serializePixelGrid,
  type PixelGrid,
} from '../lib/pixelGrid.js';
import {
  drawRect, fillRect, drawLine, drawGradient, remapPalette, floodFill,
  type Region,
} from '../lib/drawingToolkit.js';
import { importReference } from '../lib/referenceImporter.js';
import { decodePng } from '../lib/pngDecoder.js';
import { type PaletteEntry } from '../server/projectStore.js';

interface CliArgs {
  project: string;
  composition: string;
  out: string;
  repoRoot: string;
}

interface Step {
  op: string;
  [key: string]: unknown;
}

interface Composition {
  version: number;
  width: number;
  height: number;
  hotspot?: { x: number; y: number };
  steps: Step[];
}

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`generateFrame: missing value for --${key}`);
      }
      flags[key] = val;
      i++;
    }
  }
  for (const required of ['project', 'composition', 'out']) {
    if (!flags[required]) throw new Error(`generateFrame: --${required} is required`);
  }
  return {
    project: flags.project!,
    composition: flags.composition!,
    out: flags.out!,
    // Default: this file lives in studio/src/cli/, repo root is three levels up.
    repoRoot: flags['repo-root'] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  };
}

function loadPalette(projectDir: string): PaletteEntry[] {
  const palettePath = path.join(projectDir, 'palette.json');
  if (!fs.existsSync(palettePath)) {
    throw new Error(`generateFrame: missing palette.json at ${palettePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(palettePath, 'utf8')) as { colors: PaletteEntry[] };
  if (!Array.isArray(raw.colors) || raw.colors.length === 0) {
    throw new Error(`generateFrame: palette.json has no colours`);
  }
  return raw.colors;
}

function asInt(step: Step, key: string): number {
  const v = step[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`generateFrame: ${step.op}.${key} must be an integer`);
  }
  return v;
}

function asRegion(step: Step): Region & { paletteIndex: number } {
  return {
    x: asInt(step, 'x'),
    y: asInt(step, 'y'),
    width: asInt(step, 'width'),
    height: asInt(step, 'height'),
    paletteIndex: asInt(step, 'paletteIndex'),
  };
}

function runStep(
  grid: PixelGrid,
  step: Step,
  context: { projectDir: string; palette: PaletteEntry[] },
): PixelGrid {
  switch (step.op) {
    case 'fillRect': return fillRect(grid, asRegion(step));
    case 'drawRect': return drawRect(grid, asRegion(step));
    case 'drawLine':
      return drawLine(grid, {
        x0: asInt(step, 'x0'),
        y0: asInt(step, 'y0'),
        x1: asInt(step, 'x1'),
        y1: asInt(step, 'y1'),
        paletteIndex: asInt(step, 'paletteIndex'),
      });
    case 'drawGradient': {
      const axis = step.axis;
      if (axis !== 'x' && axis !== 'y') throw new Error(`drawGradient.axis must be 'x' or 'y'`);
      const stops = step.stops;
      if (!Array.isArray(stops) || stops.some((s) => typeof s !== 'number')) {
        throw new Error(`drawGradient.stops must be an array of numbers`);
      }
      const region = step.region as Region | undefined;
      return drawGradient(grid, { axis, stops: stops as number[], region });
    }
    case 'remapPalette': {
      const map = step.map as Record<string, number> | undefined;
      if (!map || typeof map !== 'object') throw new Error(`remapPalette.map must be an object`);
      const lut: Record<number, number> = {};
      for (const [k, v] of Object.entries(map)) lut[Number(k)] = v;
      return remapPalette(grid, lut);
    }
    case 'floodFill':
      return floodFill(grid, {
        x: asInt(step, 'x'),
        y: asInt(step, 'y'),
        paletteIndex: asInt(step, 'paletteIndex'),
      });
    case 'importReference': {
      const imagePath = step.imagePath;
      const targetSize = asInt(step, 'targetSize');
      if (typeof imagePath !== 'string') throw new Error(`importReference.imagePath must be a string`);
      const full = path.isAbsolute(imagePath) ? imagePath : path.join(context.projectDir, imagePath);
      const bytes = fs.readFileSync(full);
      const image = decodePng(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return importReference({ image, targetSize, palette: context.palette });
    }
    default:
      throw new Error(`generateFrame: unknown op '${step.op}'`);
  }
}

export function generateFrame(args: CliArgs): { outPath: string; grid: PixelGrid } {
  const projectDir = path.join(args.repoRoot, 'projects', args.project);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`generateFrame: project '${args.project}' not found at ${projectDir}`);
  }
  const composition = JSON.parse(fs.readFileSync(args.composition, 'utf8')) as Composition;
  if (composition.version !== 1) {
    throw new Error(`generateFrame: composition.version must be 1, got ${composition.version}`);
  }
  const palette = loadPalette(projectDir);

  let grid = createPixelGrid({
    width: composition.width,
    height: composition.height,
    hotspot: composition.hotspot,
  });
  for (const step of composition.steps) {
    grid = runStep(grid, step, { projectDir, palette });
  }

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(projectDir, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(serializePixelGrid(grid), null, 2) + '\n', 'utf8');
  return { outPath, grid };
}

// Run directly via `tsx`. When imported (e.g. from a smoke test), do nothing.
const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ?? '';
const isDirectRun = path.resolve(invokedFile) === path.resolve(thisFile);
if (isDirectRun) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { outPath } = generateFrame(args);
    process.stdout.write(`wrote ${outPath}\n`);
  } catch (e) {
    process.stderr.write(`generateFrame: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
