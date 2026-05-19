// Project store — filesystem adapter for one Cursor Studio project on disk.
//
// Layout (issue #6 / tracer slice):
//   <repoRoot>/projects/<Name>/frames/frame_NN.json   — JSON pixel grids
//   <repoRoot>/projects/<Name>/palette.json           — palette index -> RGBA hex
//
// Future stages will add candidates, recipes, and write-back. For S1 the
// store is read-only.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';

export interface PaletteEntry {
  index: number;
  rgba: string;
}

export interface Palette {
  version: number;
  colors: PaletteEntry[];
}

export interface ProjectFrame {
  fileName: string;
  grid: PixelGrid;
}

export interface Project {
  name: string;
  frames: ProjectFrame[];
  palette: Palette;
}

export interface ProjectStore {
  readProject(name: string): Project;
}

export interface ProjectStoreOptions {
  /** Repo root — the directory that contains projects/. */
  repoRoot: string;
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createProjectStore({ repoRoot }: ProjectStoreOptions): ProjectStore {
  function projectDir(name: string): string {
    if (!PROJECT_NAME_PATTERN.test(name)) {
      throw new Error(`projectStore: invalid project name '${name}'`);
    }
    return path.join(repoRoot, 'projects', name);
  }

  function readProject(name: string): Project {
    const dir = projectDir(name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`projectStore: project '${name}' not found at ${dir}`);
    }
    const palettePath = path.join(dir, 'palette.json');
    if (!fs.existsSync(palettePath)) {
      throw new Error(`projectStore: missing palette.json at ${palettePath}`);
    }
    const palette = JSON.parse(fs.readFileSync(palettePath, 'utf8')) as Palette;

    const framesDir = path.join(dir, 'frames');
    const frameFiles = fs.existsSync(framesDir)
      ? fs.readdirSync(framesDir).filter((f) => f.endsWith('.json')).sort()
      : [];
    if (frameFiles.length === 0) {
      throw new Error(`projectStore: no JSON frames in ${framesDir}`);
    }
    const frames: ProjectFrame[] = frameFiles.map((fileName) => {
      const full = path.join(framesDir, fileName);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { fileName, grid: parsePixelGrid(raw) };
    });

    return { name, frames, palette };
  }

  return { readProject };
}
