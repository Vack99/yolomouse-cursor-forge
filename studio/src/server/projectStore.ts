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
import type { Stage } from '../lib/workflowMachine.js';

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

/**
 * One JSON pixel grid sitting in `projects/<Name>/candidates/<stage>/`.
 *
 * `id` is the filename stripped of its `.json` extension — a stable opaque
 * identifier the workflow reducer uses for `select` actions. `fileName` is
 * kept alongside so the gallery UI can show it as a label/tooltip.
 */
export interface ProjectCandidate {
  id: string;
  fileName: string;
  grid: PixelGrid;
}

export interface ProjectStore {
  readProject(name: string): Project;
  /**
   * Names of every studio-format project under `projects/`, alphabetised
   * case-insensitively. A project is "studio-format" iff its directory
   * contains `palette.json` — that distinguishes JSON-frame projects from
   * the legacy hand-painted `.grid.txt` / `.png` projects which the studio
   * cannot display (see PRD: existing projects are out of scope for
   * migration). Template directories (`_*`) and dot-directories are
   * skipped so the picker shows only real projects.
   */
  listProjects(): string[];
  /**
   * All candidate grids for one stage of the workflow, sorted by filename.
   * Returns an empty array when the stage directory has not been created yet
   * — that is the legitimate "no candidates generated yet" state.
   *
   * Errors (invalid project name, malformed JSON) propagate to the caller so
   * a broken candidate fails loud instead of silently disappearing from the
   * gallery.
   */
  readCandidates(name: string, stage: Stage): ProjectCandidate[];
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

  function listProjects(): string[] {
    const projectsDir = path.join(repoRoot, 'projects');
    if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
      return [];
    }
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name.startsWith('_') || name.startsWith('.')) continue;
      // Studio-format projects are identified by palette.json — the only
      // file unique to the JSON-frame layout.
      if (!fs.existsSync(path.join(projectsDir, name, 'palette.json'))) continue;
      names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return names;
  }

  function readCandidates(name: string, stage: Stage): ProjectCandidate[] {
    // Reuses projectDir() so the same path-traversal guard protects this
    // call site without duplicating the validation regex.
    const stageDir = path.join(projectDir(name), 'candidates', stage);
    if (!fs.existsSync(stageDir) || !fs.statSync(stageDir).isDirectory()) {
      return [];
    }
    const files = fs
      .readdirSync(stageDir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .sort();
    return files.map((fileName) => {
      const full = path.join(stageDir, fileName);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return {
        id: fileName.slice(0, -'.json'.length),
        fileName,
        grid: parsePixelGrid(raw),
      };
    });
  }

  return { readProject, listProjects, readCandidates };
}
