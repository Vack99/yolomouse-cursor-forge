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
import { parsePixelGrid, serializePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import type { Recipe, Stage } from '../lib/workflowMachine.js';

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

/** Persisted record describing which candidate was locked for a stage. */
export interface LockMarker {
  candidateId: string;
  recipe: Recipe;
}

/** Arguments to `writeLock` — the candidate being frozen and its derived recipe. */
export interface WriteLockArgs {
  candidateId: string;
  grid: PixelGrid;
  recipe: Recipe;
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
   * The workflow stage a "generate N more candidates" call should currently
   * target — derived purely from disk: the first stage whose
   * `candidates/<stage>/lock.json` does not exist. Once `first` is locked
   * the active stage advances to `middle`, etc. Pure read; never mutates.
   *
   * Used by the "generate 4 more" command surface (issue #14) so Claude
   * does not have to inspect the filesystem itself before authoring more
   * candidates.
   */
  computeActiveStage(name: string): Stage;
  /**
   * Allocate `count` fresh, sequential candidate ids for `stage`. The
   * returned ids never collide with existing candidate files or with
   * reserved marker filenames. Padding widens automatically once the
   * sequence crosses an order of magnitude so on-disk listings stay
   * lexicographically sorted.
   *
   * Pure compute over a directory listing — does not write anything.
   * Pair with `writeCandidate` (or `appendCandidates` for the batch case)
   * to actually persist the new candidates.
   */
  allocateCandidateIds(name: string, stage: Stage, count: number): string[];
  /**
   * "Generate N more candidates" in one atomic call: allocate sequential
   * ids, write each grid to its candidate slot, return the ids. Lets the
   * HTTP command surface stay a single POST instead of N round-trips.
   */
  appendCandidates(name: string, stage: Stage, grids: ReadonlyArray<PixelGrid>): string[];
  /**
   * All candidate grids for one stage of the workflow, sorted by filename.
   * Returns an empty array when the stage directory has not been created yet
   * — that is the legitimate "no candidates generated yet" state.
   *
   * The reserved files `lock.json` and `recipe.json` are excluded — they
   * are lock-stage metadata, not candidates.
   *
   * Errors (invalid project name, malformed JSON) propagate to the caller so
   * a broken candidate fails loud instead of silently disappearing from the
   * gallery.
   */
  readCandidates(name: string, stage: Stage): ProjectCandidate[];
  /**
   * Lock a candidate as the canonical frame for a stage. Writes three
   * files atomically (from the caller's point of view):
   *   - `candidates/<stage>/lock.json` — pointer to the locked candidate id.
   *   - `candidates/<stage>/recipe.json` — composition recipe metadata.
   *   - `frames/frame_NN.json` — the candidate's grid frozen as the
   *     canonical frame for the stage.
   *
   * Throws if the candidate id is not on disk, if the project name is
   * invalid, or if the stage is already locked (PRD: locking is one-shot
   * per stage — only manual pixel edits to the frozen grid are allowed
   * after).
   */
  writeLock(name: string, stage: Stage, args: WriteLockArgs): void;
  /**
   * Read the lock marker for a stage. Returns undefined when no lock has
   * been written yet — that is the unlocked state. Returns
   * `{ candidateId, recipe }` once both marker files are present.
   */
  readLock(name: string, stage: Stage): LockMarker | undefined;
  /**
   * Persist a pixel-editor edit to one of the project's frame files.
   * `fileName` must match the `frame_NN.json` pattern — anything else is
   * refused so a bug in the HTTP routing cannot escape the frames/ folder.
   * Overwrites unconditionally; the editor reducer owns "no change → don't
   * write" debouncing.
   */
  writeFrame(name: string, fileName: string, grid: PixelGrid): void;
  /**
   * Persist a pixel-editor edit to one of the stage's candidate files.
   * `id` is the candidate basename without `.json`. Rejects the reserved
   * `lock` / `recipe` ids so a stray edit cannot corrupt the lock markers.
   */
  writeCandidate(name: string, stage: Stage, id: string, grid: PixelGrid): void;
}

export interface ProjectStoreOptions {
  /** Repo root — the directory that contains projects/. */
  repoRoot: string;
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// frame files must look like `frame_NN.json` (any number of digits after the
// underscore — `forge build` already tolerates `frame_000.json` for >100
// frames). Anchored so a slash or path-traversal segment is rejected.
const FRAME_FILE_PATTERN = /^frame_\d+\.json$/;
// Candidate ids share the project-name shape — alphanumerics, dots, dashes,
// underscores. A bare basename, no extension. Reserved ids (lock, recipe)
// are filtered separately.
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_CANDIDATE_IDS = new Set<string>(['lock', 'recipe']);

// Reserved files inside candidates/<stage>/. They live next to the candidate
// JSON files but are not themselves candidates — they describe the lock
// state for the stage.
const LOCK_MARKER_FILE = 'lock.json';
const RECIPE_FILE = 'recipe.json';
const STAGE_RESERVED_FILES = new Set<string>([LOCK_MARKER_FILE, RECIPE_FILE]);

/**
 * Filename of the canonical frame produced by locking `stage`. Only `first`
 * is wired today (#12); later issues add middle (#15 → frame_NN where NN is
 * the middle index) and last (#17 → final frame index). Until the workflow
 * knows the chosen frame count, the middle/last positions are placeholders
 * that get rewritten by the tween step (#18) — `first` is the only stage
 * with a fixed canonical position right now.
 */
const STAGE_FRAME_FILE: { readonly [S in Stage]: string | undefined } = {
  first: 'frame_00.json',
  middle: undefined,
};

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
      // lock.json / recipe.json sit beside candidates but are not candidates.
      .filter((f) => !STAGE_RESERVED_FILES.has(f.toLowerCase()))
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

  function writeLock(name: string, stage: Stage, args: WriteLockArgs): void {
    const dir = projectDir(name);
    const stageDir = path.join(dir, 'candidates', stage);
    const candidatePath = path.join(stageDir, `${args.candidateId}.json`);
    if (!fs.existsSync(candidatePath)) {
      throw new Error(
        `projectStore: cannot lock '${args.candidateId}' — no such candidate at ${candidatePath}`,
      );
    }
    const lockPath = path.join(stageDir, LOCK_MARKER_FILE);
    if (fs.existsSync(lockPath)) {
      throw new Error(`projectStore: stage '${stage}' is already locked at ${lockPath}`);
    }
    const frameFile = STAGE_FRAME_FILE[stage];
    if (frameFile === undefined) {
      // Defensive: keep the error surface narrow until later issues wire
      // middle/last canonical positions.
      throw new Error(`projectStore: stage '${stage}' has no canonical frame slot yet`);
    }
    const framesDir = path.join(dir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    // Marker first — once it lands, downstream readers see the stage as
    // locked. The frame freeze + recipe write follow; the
    // already-locked guard above means a half-finished previous lock is
    // impossible.
    const marker: LockMarker = { candidateId: args.candidateId, recipe: args.recipe };
    fs.writeFileSync(lockPath, JSON.stringify(marker, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(stageDir, RECIPE_FILE),
      JSON.stringify(args.recipe, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(framesDir, frameFile),
      JSON.stringify(serializePixelGrid(args.grid), null, 2),
      'utf8',
    );
  }

  function computeActiveStage(name: string): Stage {
    const dir = projectDir(name);
    // Walk the stage order; the first unlocked stage is the active one.
    // `STAGE_AFTER` (and friends) live in workflowMachine, so we duplicate
    // the order locally to avoid pulling reducer guts into the filesystem
    // adapter. When middle/last are wired (#15 / #17) extend this array
    // alongside the workflow machine's Stage union — the type checker
    // ensures we don't drift.
    const order: ReadonlyArray<Stage> = ['first', 'middle'];
    for (const stage of order) {
      const lockPath = path.join(dir, 'candidates', stage, LOCK_MARKER_FILE);
      if (!fs.existsSync(lockPath)) return stage;
    }
    // Every known stage is locked. Until tweening exists (#18) the final
    // stage in the order is the right answer — there is no "after" yet.
    return order[order.length - 1]!;
  }

  function allocateCandidateIds(name: string, stage: Stage, count: number): string[] {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`projectStore: count must be a positive integer, got ${count}`);
    }
    const stageDir = path.join(projectDir(name), 'candidates', stage);
    // Find the highest existing candidate_NN index by parsing filenames.
    // Reserved marker files (lock.json / recipe.json) are ignored so they
    // do not influence the next index.
    let highest = -1;
    if (fs.existsSync(stageDir) && fs.statSync(stageDir).isDirectory()) {
      for (const f of fs.readdirSync(stageDir)) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        if (STAGE_RESERVED_FILES.has(f.toLowerCase())) continue;
        const m = /^candidate_(\d+)\.json$/i.exec(f);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > highest) highest = n;
      }
    }
    const start = highest + 1;
    const end = start + count - 1;
    // Pad to whichever is wider — the existing files' padding (so we don't
    // unintentionally shorten) or the new high-water mark's natural width.
    // `String(N).length` gives the natural width of the final id.
    const naturalWidth = String(end).length;
    const minWidth = 2; // candidate_00 is the legacy floor.
    const width = Math.max(minWidth, naturalWidth);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const n = start + i;
      ids.push(`candidate_${String(n).padStart(width, '0')}`);
    }
    return ids;
  }

  function appendCandidates(
    name: string,
    stage: Stage,
    grids: ReadonlyArray<PixelGrid>,
  ): string[] {
    if (grids.length === 0) {
      throw new Error('projectStore: appendCandidates requires at least one grid');
    }
    const ids = allocateCandidateIds(name, stage, grids.length);
    for (let i = 0; i < ids.length; i++) {
      writeCandidate(name, stage, ids[i]!, grids[i]!);
    }
    return ids;
  }

  function readLock(name: string, stage: Stage): LockMarker | undefined {
    const stageDir = path.join(projectDir(name), 'candidates', stage);
    const lockPath = path.join(stageDir, LOCK_MARKER_FILE);
    if (!fs.existsSync(lockPath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockMarker>;
    if (typeof raw.candidateId !== 'string' || raw.recipe === undefined) {
      throw new Error(`projectStore: malformed lock marker at ${lockPath}`);
    }
    return { candidateId: raw.candidateId, recipe: raw.recipe as Recipe };
  }

  function writeFrame(name: string, fileName: string, grid: PixelGrid): void {
    const dir = projectDir(name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`projectStore: project '${name}' not found at ${dir}`);
    }
    if (!FRAME_FILE_PATTERN.test(fileName)) {
      throw new Error(`projectStore: invalid frame file name '${fileName}'`);
    }
    const framesDir = path.join(dir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(
      path.join(framesDir, fileName),
      JSON.stringify(serializePixelGrid(grid), null, 2),
      'utf8',
    );
  }

  function writeCandidate(name: string, stage: Stage, id: string, grid: PixelGrid): void {
    const dir = projectDir(name);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`projectStore: project '${name}' not found at ${dir}`);
    }
    if (RESERVED_CANDIDATE_IDS.has(id.toLowerCase())) {
      throw new Error(`projectStore: '${id}' is a reserved candidate id`);
    }
    if (!CANDIDATE_ID_PATTERN.test(id)) {
      throw new Error(`projectStore: invalid candidate id '${id}'`);
    }
    const stageDir = path.join(dir, 'candidates', stage);
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(
      path.join(stageDir, `${id}.json`),
      JSON.stringify(serializePixelGrid(grid), null, 2),
      'utf8',
    );
  }

  return {
    readProject,
    listProjects,
    computeActiveStage,
    allocateCandidateIds,
    appendCandidates,
    readCandidates,
    writeLock,
    readLock,
    writeFrame,
    writeCandidate,
  };
}
