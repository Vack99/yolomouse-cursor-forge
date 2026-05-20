import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProjectStore } from '../src/server/projectStore.js';
import { createPixelGrid, serializePixelGrid, setPixel } from '../src/lib/pixelGrid.js';
import { extractRecipe } from '../src/lib/workflowMachine.js';

// The project store is the only module that touches the filesystem in this
// slice. It locates a project under projects/<Name>/ and reads the JSON pixel
// grid + palette.json that the renderer needs.

let tmpRoot: string;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-'));
}

beforeEach(() => {
  tmpRoot = mkTmp();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeProject(name: string, files: Record<string, unknown | string>): string {
  const projDir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(projDir, 'frames'), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(projDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
    fs.writeFileSync(full, text, 'utf8');
  }
  return projDir;
}

describe('projectStore', () => {
  it('reads a project frame + palette from disk', () => {
    const grid = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 1);
    const palette = {
      version: 1,
      colors: [
        { index: 0, rgba: '00000000' },
        { index: 1, rgba: 'FF0000FF' },
      ],
    };
    writeProject('Hello', {
      'frames/frame_00.json': serializePixelGrid(grid),
      'palette.json': palette,
    });

    const store = createProjectStore({ repoRoot: tmpRoot });
    const project = store.readProject('Hello');

    expect(project.name).toBe('Hello');
    expect(project.frames).toHaveLength(1);
    expect(project.frames[0]!.fileName).toBe('frame_00.json');
    expect(project.frames[0]!.grid).toEqual(grid);
    expect(project.palette).toEqual(palette);
  });

  it('returns frames sorted by file name', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    writeProject('Multi', {
      'frames/frame_02.json': blank,
      'frames/frame_00.json': blank,
      'frames/frame_01.json': blank,
      'palette.json': { version: 1, colors: [{ index: 0, rgba: '00000000' }] },
    });

    const store = createProjectStore({ repoRoot: tmpRoot });
    const project = store.readProject('Multi');

    expect(project.frames.map((f) => f.fileName)).toEqual([
      'frame_00.json',
      'frame_01.json',
      'frame_02.json',
    ]);
  });

  it('throws when the project directory is missing', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readProject('Ghost')).toThrow(/not found/i);
  });

  it('throws when palette.json is missing', () => {
    writeProject('NoPalette', {
      'frames/frame_00.json': serializePixelGrid(createPixelGrid({ width: 1, height: 1 })),
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readProject('NoPalette')).toThrow(/palette\.json/);
  });

  it('throws when no JSON frames exist', () => {
    writeProject('Empty', {
      'palette.json': { version: 1, colors: [{ index: 0, rgba: '00000000' }] },
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readProject('Empty')).toThrow(/no JSON frame/i);
  });

  it('rejects path-traversal in project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readProject('../escape')).toThrow(/invalid project name/i);
    expect(() => store.readProject('a/b')).toThrow(/invalid project name/i);
  });
});

describe('projectStore.listProjects', () => {
  it('lists every studio project (directory containing palette.json) under projects/', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
    writeProject('Alpha', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('Beta', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('Gamma', { 'palette.json': palette, 'frames/frame_00.json': blank });

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listProjects()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('skips template directories (underscore prefix) and dot-directories', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
    writeProject('_template', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('.hidden', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('Real', { 'palette.json': palette, 'frames/frame_00.json': blank });

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listProjects()).toEqual(['Real']);
  });

  it('skips non-studio directories that have no palette.json (legacy grid/PNG projects)', () => {
    // Simulate a legacy hand-painted project: has frames/ but no palette.json.
    const projDir = path.join(tmpRoot, 'projects', 'Legacy');
    fs.mkdirSync(path.join(projDir, 'frames'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'frames', 'frame_00.grid.txt'), '', 'utf8');

    // And a real studio project alongside it.
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
    writeProject('Studio', { 'palette.json': palette, 'frames/frame_00.json': blank });

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listProjects()).toEqual(['Studio']);
  });

  it('returns names sorted alphabetically', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
    writeProject('Zeta', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('alpha', { 'palette.json': palette, 'frames/frame_00.json': blank });
    writeProject('Mira', { 'palette.json': palette, 'frames/frame_00.json': blank });

    const store = createProjectStore({ repoRoot: tmpRoot });
    // Case-insensitive sort so users don't see Capital then lowercase weirdness.
    expect(store.listProjects()).toEqual(['alpha', 'Mira', 'Zeta']);
  });

  it('returns an empty list when no projects exist', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listProjects()).toEqual([]);
  });
});

describe('projectStore.readCandidates', () => {
  const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
  const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));

  it('reads every JSON candidate grid from candidates/first/, sorted by filename', () => {
    writeProject('Gallery', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_02.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/candidate_01.json': blank,
    });

    const store = createProjectStore({ repoRoot: tmpRoot });
    const candidates = store.readCandidates('Gallery', 'first');

    expect(candidates.map((c) => c.id)).toEqual([
      'candidate_00',
      'candidate_01',
      'candidate_02',
    ]);
    // Id is the filename without extension — used by the workflow reducer as
    // an opaque stable identifier.
    expect(candidates[0]!.fileName).toBe('candidate_00.json');
    expect(candidates[0]!.grid.width).toBe(1);
    expect(candidates[0]!.grid.height).toBe(1);
  });

  it('returns an empty list when the stage directory does not exist yet', () => {
    writeProject('NoCandidates', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.readCandidates('NoCandidates', 'first')).toEqual([]);
  });

  it('ignores non-JSON files in the stage directory', () => {
    writeProject('Mixed', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/notes.txt': 'aaron scribbled this',
      'candidates/first/.DS_Store': '',
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const candidates = store.readCandidates('Mixed', 'first');
    expect(candidates.map((c) => c.id)).toEqual(['candidate_00']);
  });

  it('rejects path-traversal in project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readCandidates('../escape', 'first')).toThrow(/invalid project name/i);
  });

  it('surfaces parse errors so a malformed candidate fails loudly', () => {
    writeProject('Broken', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': '{ this is not json',
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.readCandidates('Broken', 'first')).toThrow();
  });

  it('excludes the reserved lock.json and recipe.json marker files from the candidate list', () => {
    writeProject('Locked', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/candidate_01.json': blank,
      // Lock markers live alongside the candidates but must not appear as
      // candidates themselves — they describe which candidate was locked,
      // they are not themselves a candidate.
      'candidates/first/lock.json': { candidateId: 'candidate_00' },
      'candidates/first/recipe.json': { width: 1, height: 1 },
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.readCandidates('Locked', 'first').map((c) => c.id)).toEqual([
      'candidate_00',
      'candidate_01',
    ]);
  });
});

// Lock + recipe write-back — issue #12.
//
// writeLock(name, stage, { candidateId, grid, recipe }) is the atomic
// operation that ends a stage:
//   1. The locked candidate's grid is frozen as the canonical frame at
//      `frames/frame_NN.json` (frame_00 for the `first` stage), since
//      that is what `forge build` compiles. The PRD calls this "freezing
//      the candidate's pixel grid as the truth for the frame."
//   2. A lock marker `candidates/<stage>/lock.json` records which
//      candidate id was locked and when.
//   3. A recipe metadata file `candidates/<stage>/recipe.json` records
//      the composition recipe so the next stage's candidate generator
//      can seed from it.
//
// readLock(name, stage) returns the lock+recipe if both markers exist,
// undefined otherwise. The reducer uses this on page-load rehydration.

describe('projectStore.writeLock / readLock', () => {
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
  ] };

  function project(name: string, locked: { id: string }): { dir: string } {
    const blank = serializePixelGrid(createPixelGrid({ width: 2, height: 2 }));
    const candidateGrid = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    writeProject(name, {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      [`candidates/first/${locked.id}.json`]: serializePixelGrid(candidateGrid),
      'candidates/first/candidate_other.json': blank,
    });
    return { dir: path.join(tmpRoot, 'projects', name) };
  }

  it('writes lock.json + recipe.json and freezes the candidate grid as frame_00.json', () => {
    const { dir } = project('LockProj', { id: 'candidate_00' });
    const store = createProjectStore({ repoRoot: tmpRoot });

    const candidateGrid = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const recipe = extractRecipe(candidateGrid);
    store.writeLock('LockProj', 'first', {
      candidateId: 'candidate_00',
      grid: candidateGrid,
      recipe,
    });

    // Lock marker: candidate id is recorded.
    const lockRaw = JSON.parse(fs.readFileSync(path.join(dir, 'candidates', 'first', 'lock.json'), 'utf8'));
    expect(lockRaw.candidateId).toBe('candidate_00');
    // Recipe is persisted verbatim — it is a Recipe object.
    const recipeRaw = JSON.parse(fs.readFileSync(path.join(dir, 'candidates', 'first', 'recipe.json'), 'utf8'));
    expect(recipeRaw).toEqual(recipe);
    // The candidate grid is now the canonical first frame.
    const frameRaw = JSON.parse(fs.readFileSync(path.join(dir, 'frames', 'frame_00.json'), 'utf8'));
    expect(frameRaw).toEqual(serializePixelGrid(candidateGrid));
  });

  it('returns undefined from readLock when no lock has been written', () => {
    project('Unlocked', { id: 'candidate_00' });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.readLock('Unlocked', 'first')).toBeUndefined();
  });

  it('round-trips lock + recipe through readLock', () => {
    project('Roundtrip', { id: 'candidate_00' });
    const store = createProjectStore({ repoRoot: tmpRoot });

    const candidateGrid = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const recipe = extractRecipe(candidateGrid);
    store.writeLock('Roundtrip', 'first', {
      candidateId: 'candidate_00',
      grid: candidateGrid,
      recipe,
    });

    const loaded = store.readLock('Roundtrip', 'first');
    expect(loaded).toEqual({ candidateId: 'candidate_00', recipe });
  });

  it('rejects locking a candidate id that does not exist on disk', () => {
    project('NoSuch', { id: 'candidate_00' });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const candidateGrid = createPixelGrid({ width: 2, height: 2 });
    expect(() =>
      store.writeLock('NoSuch', 'first', {
        candidateId: 'candidate_99',
        grid: candidateGrid,
        recipe: extractRecipe(candidateGrid),
      }),
    ).toThrow(/candidate_99/);
  });

  it('rejects path-traversal in project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = createPixelGrid({ width: 1, height: 1 });
    expect(() =>
      store.writeLock('../escape', 'first', { candidateId: 'x', grid: g, recipe: extractRecipe(g) }),
    ).toThrow(/invalid project name/i);
    expect(() => store.readLock('../escape', 'first')).toThrow(/invalid project name/i);
  });

  it('refuses to overwrite an existing lock', () => {
    project('AlreadyLocked', { id: 'candidate_00' });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const recipe = extractRecipe(g);
    store.writeLock('AlreadyLocked', 'first', { candidateId: 'candidate_00', grid: g, recipe });
    expect(() =>
      store.writeLock('AlreadyLocked', 'first', { candidateId: 'candidate_other', grid: g, recipe }),
    ).toThrow(/already locked/i);
  });
});
