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

// writeFrame / writeCandidate — used by the in-canvas pixel editor (#13)
// to persist pixel edits back to disk. Both are simple overwrites; the
// editor reducer owns the "no change → don't write" check, the store just
// writes what it is told. Reject path traversal and unknown projects loud
// so a bug in the editor cannot escape its project directory.

describe('projectStore.writeFrame', () => {
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
  ] };

  it('writes the supplied grid to frames/<fileName> as serialised JSON', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 2, height: 2 }));
    writeProject('Edits', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const edited = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 1, 1);
    store.writeFrame('Edits', 'frame_00.json', edited);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'projects', 'Edits', 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(raw).toEqual(serializePixelGrid(edited));
  });

  it('rejects path-traversal in the project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = createPixelGrid({ width: 1, height: 1 });
    expect(() => store.writeFrame('../escape', 'frame_00.json', g)).toThrow(/invalid project name/i);
  });

  it('rejects a frame filename that does not match the frame_NN.json pattern', () => {
    const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    writeProject('FrameName', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = createPixelGrid({ width: 1, height: 1 });
    // Any slash, ..-segment, or non-conforming basename must be refused —
    // the HTTP layer takes this from the URL.
    expect(() => store.writeFrame('FrameName', '../escape.json', g)).toThrow(/frame file name/i);
    expect(() => store.writeFrame('FrameName', 'frame_00.txt', g)).toThrow(/frame file name/i);
    expect(() => store.writeFrame('FrameName', 'a/b.json', g)).toThrow(/frame file name/i);
  });

  it('throws when the project does not exist', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.writeFrame('Ghost', 'frame_00.json', createPixelGrid({ width: 1, height: 1 }))).toThrow(
      /not found/i,
    );
  });
});

describe('projectStore.writeCandidate', () => {
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
  ] };
  const blank = serializePixelGrid(createPixelGrid({ width: 2, height: 2 }));

  it('writes the supplied grid to candidates/<stage>/<id>.json', () => {
    writeProject('CandEdit', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const edited = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 1);
    store.writeCandidate('CandEdit', 'first', 'candidate_00', edited);
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(tmpRoot, 'projects', 'CandEdit', 'candidates', 'first', 'candidate_00.json'),
        'utf8',
      ),
    );
    expect(raw).toEqual(serializePixelGrid(edited));
  });

  it('refuses to write to the reserved lock.json / recipe.json marker ids', () => {
    writeProject('Reserved', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = createPixelGrid({ width: 1, height: 1 });
    expect(() => store.writeCandidate('Reserved', 'first', 'lock', g)).toThrow(/reserved/i);
    expect(() => store.writeCandidate('Reserved', 'first', 'recipe', g)).toThrow(/reserved/i);
  });

  it('rejects a candidate id with path-traversal characters', () => {
    writeProject('CandPath', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = createPixelGrid({ width: 1, height: 1 });
    expect(() => store.writeCandidate('CandPath', 'first', '../escape', g)).toThrow(/candidate id/i);
    expect(() => store.writeCandidate('CandPath', 'first', 'a/b', g)).toThrow(/candidate id/i);
  });
});

// "Generate 4 more" support — issue #14.
//
// allocateCandidateIds: deterministic, zero-padded sequential ids that do not
// collide with anything already on disk. Implements the "no upper cap" + "new
// candidates appear alongside the existing ones (none replaced)" acceptance
// criteria without the caller having to scan candidates/<stage>/ itself.
//
// appendCandidates: glue of "allocate + writeCandidate × N" so the command
// surface is one atomic call and Claude (or the canvas) cannot half-finish a
// batch and leave gaps in the sequence.
//
// computeActiveStage: derives the current workflow stage from the on-disk
// lock markers — the active stage is the first stage that has no lock.json.
// This is the "queryable active stage" criterion: Claude reads this to know
// where a "generate 4 more" call should land.

describe('projectStore.allocateCandidateIds', () => {
  const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
  const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));

  it('returns sequential candidate_NN ids starting at 00 when the stage is empty', () => {
    writeProject('Empty', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.allocateCandidateIds('Empty', 'first', 4)).toEqual([
      'candidate_00',
      'candidate_01',
      'candidate_02',
      'candidate_03',
    ]);
  });

  it('continues after the highest existing candidate index so no existing file is overwritten', () => {
    writeProject('Existing', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/candidate_01.json': blank,
      'candidates/first/candidate_03.json': blank,
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    // Highest is 03 → next four are 04..07. Gaps (candidate_02) are NOT
    // refilled — sequential allocation keeps the on-disk listing in
    // chronological order, which is what the gallery wants the user to see.
    expect(store.allocateCandidateIds('Existing', 'first', 4)).toEqual([
      'candidate_04',
      'candidate_05',
      'candidate_06',
      'candidate_07',
    ]);
  });

  it('ignores reserved marker files when computing the next index', () => {
    writeProject('Locked', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/lock.json': { candidateId: 'candidate_00' },
      'candidates/first/recipe.json': { width: 1, height: 1 },
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.allocateCandidateIds('Locked', 'first', 2)).toEqual([
      'candidate_01',
      'candidate_02',
    ]);
  });

  it('uses three-digit padding once the index reaches 100', () => {
    // Edge case: we want filename sort order to keep matching numeric order
    // forever. With two-digit padding `candidate_100` would sort before
    // `candidate_99`. The store widens the pad as needed.
    const files: Record<string, unknown> = {
      'palette.json': palette,
      'frames/frame_00.json': blank,
    };
    files['candidates/first/candidate_099.json'] = blank;
    writeProject('Big', files);
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.allocateCandidateIds('Big', 'first', 2)).toEqual([
      'candidate_100',
      'candidate_101',
    ]);
  });

  it('rejects a non-positive count', () => {
    writeProject('Bad', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.allocateCandidateIds('Bad', 'first', 0)).toThrow(/count/i);
    expect(() => store.allocateCandidateIds('Bad', 'first', -1)).toThrow(/count/i);
  });

  it('rejects path-traversal in the project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.allocateCandidateIds('../escape', 'first', 1)).toThrow(/invalid project name/i);
  });
});

describe('projectStore.appendCandidates', () => {
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
  ] };
  const blank = serializePixelGrid(createPixelGrid({ width: 2, height: 2 }));

  it('writes each supplied grid to a freshly-allocated candidate file and returns the ids', () => {
    writeProject('Append', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g1 = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const g2 = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 1, 1);
    const ids = store.appendCandidates('Append', 'first', [g1, g2]);
    expect(ids).toEqual(['candidate_01', 'candidate_02']);

    const stageDir = path.join(tmpRoot, 'projects', 'Append', 'candidates', 'first');
    expect(JSON.parse(fs.readFileSync(path.join(stageDir, 'candidate_01.json'), 'utf8'))).toEqual(
      serializePixelGrid(g1),
    );
    expect(JSON.parse(fs.readFileSync(path.join(stageDir, 'candidate_02.json'), 'utf8'))).toEqual(
      serializePixelGrid(g2),
    );
    // The pre-existing candidate is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(stageDir, 'candidate_00.json'), 'utf8'))).toEqual(
      blank,
    );
  });

  it('rejects an empty grids array', () => {
    writeProject('NoGrids', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.appendCandidates('NoGrids', 'first', [])).toThrow(/at least one/i);
  });
});

describe('projectStore.computeActiveStage', () => {
  const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
  const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));

  it('returns "first" when no stage has a lock marker yet', () => {
    writeProject('Fresh', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.computeActiveStage('Fresh')).toBe('first');
  });

  it('returns "first" when candidates/first/ exists but no lock has been written', () => {
    writeProject('Open', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.computeActiveStage('Open')).toBe('first');
  });

  it('returns "middle" once the first stage is locked', () => {
    writeProject('AfterFirst', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/lock.json': { candidateId: 'candidate_00', recipe: {} },
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.computeActiveStage('AfterFirst')).toBe('middle');
  });

  it('returns "last" once the middle stage is also locked', () => {
    writeProject('AfterMiddle', {
      'palette.json': palette,
      'frames/frame_00.json': blank,
      'candidates/first/candidate_00.json': blank,
      'candidates/first/lock.json': { candidateId: 'candidate_00', recipe: {} },
      'candidates/middle/candidate_00.json': blank,
      'candidates/middle/lock.json': { candidateId: 'candidate_00', recipe: {} },
    });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.computeActiveStage('AfterMiddle')).toBe('last');
  });

  it('rejects path-traversal in the project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.computeActiveStage('../escape')).toThrow(/invalid project name/i);
  });
});

// Middle-stage support — issue #15.
//
// The project store treats middle the same way it treats first: candidates
// live in candidates/middle/, allocateCandidateIds and readCandidates and
// writeCandidate all accept the stage as a typed parameter so a stray edit
// can never hit the wrong directory. writeLock freezes the locked candidate
// into a per-stage canonical frame slot — for middle we keep a placeholder
// filename so #18's tween step has a known location to overwrite once the
// frame count is chosen.

describe('projectStore — middle stage', () => {
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
  ] };
  const blank = serializePixelGrid(createPixelGrid({ width: 2, height: 2 }));

  function lockedFirstProject(name: string): string {
    // A project where the first stage is locked and the middle stage now
    // has two candidates — the typical state at the start of #15's flow.
    const candidateGrid = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const middleA = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 1);
    const middleB = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 1, 1);
    const lockedFirst = extractRecipe(candidateGrid);
    writeProject(name, {
      'palette.json': palette,
      'frames/frame_00.json': serializePixelGrid(candidateGrid),
      'candidates/first/candidate_00.json': serializePixelGrid(candidateGrid),
      'candidates/first/lock.json': { candidateId: 'candidate_00', recipe: lockedFirst },
      'candidates/first/recipe.json': lockedFirst,
      'candidates/middle/candidate_00.json': serializePixelGrid(middleA),
      'candidates/middle/candidate_01.json': serializePixelGrid(middleB),
    });
    return path.join(tmpRoot, 'projects', name);
  }

  it('readCandidates returns middle-stage candidates from candidates/middle/', () => {
    lockedFirstProject('MidRead');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const candidates = store.readCandidates('MidRead', 'middle');
    expect(candidates.map((c) => c.id)).toEqual(['candidate_00', 'candidate_01']);
  });

  it('allocateCandidateIds runs on the middle directory independently of first', () => {
    lockedFirstProject('MidAlloc');
    const store = createProjectStore({ repoRoot: tmpRoot });
    // first has one candidate already; middle has two. Allocations advance
    // each stage's own sequence.
    expect(store.allocateCandidateIds('MidAlloc', 'middle', 2)).toEqual([
      'candidate_02',
      'candidate_03',
    ]);
  });

  it('appendCandidates writes to candidates/middle/ and returns the new ids', () => {
    const projectDir = lockedFirstProject('MidAppend');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 1, 1);
    const ids = store.appendCandidates('MidAppend', 'middle', [g]);
    expect(ids).toEqual(['candidate_02']);
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, 'candidates', 'middle', 'candidate_02.json'),
        'utf8',
      ),
    );
    expect(raw).toEqual(serializePixelGrid(g));
    // first stage untouched.
    expect(
      fs.existsSync(path.join(projectDir, 'candidates', 'first', 'candidate_00.json')),
    ).toBe(true);
  });

  it('writeCandidate persists to candidates/middle/<id>.json', () => {
    const projectDir = lockedFirstProject('MidWriteCand');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const edited = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 1, 1);
    store.writeCandidate('MidWriteCand', 'middle', 'candidate_00', edited);
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, 'candidates', 'middle', 'candidate_00.json'),
        'utf8',
      ),
    );
    expect(raw).toEqual(serializePixelGrid(edited));
  });

  it('writeLock + readLock round-trips a middle-stage lock', () => {
    const projectDir = lockedFirstProject('MidLock');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const middleGrid = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 1);
    const recipe = extractRecipe(middleGrid);
    store.writeLock('MidLock', 'middle', {
      candidateId: 'candidate_00',
      grid: middleGrid,
      recipe,
    });

    // Marker + recipe land in candidates/middle/.
    const lockRaw = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'candidates', 'middle', 'lock.json'), 'utf8'),
    );
    expect(lockRaw.candidateId).toBe('candidate_00');
    expect(lockRaw.recipe).toEqual(recipe);
    const recipeRaw = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'candidates', 'middle', 'recipe.json'), 'utf8'),
    );
    expect(recipeRaw).toEqual(recipe);

    // Round-trip via readLock.
    expect(store.readLock('MidLock', 'middle')).toEqual({
      candidateId: 'candidate_00',
      recipe,
    });

    // Locking middle does NOT overwrite frame_00 — the first stage's
    // canonical frame is preserved. The middle stage gets its own
    // placeholder slot until the tween step chooses the real frame count.
    const frame00 = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_00.json'), 'utf8'),
    );
    // frame_00 still represents the first-frame grid; we verify by reading
    // it back and confirming it's the candidate_00 grid from the first
    // stage (pixel at (0,0) = 1, others = 0).
    expect(frame00.pixels).toEqual([
      [1, 0],
      [0, 0],
    ]);

    // A middle frame placeholder is written so the tween step has a known
    // location to overwrite. The filename is stable so the watcher can fire
    // a deterministic frame-changed event.
    const middlePlaceholderPath = path.join(projectDir, 'frames', 'frame_middle.json');
    expect(fs.existsSync(middlePlaceholderPath)).toBe(true);
    const middleRaw = JSON.parse(fs.readFileSync(middlePlaceholderPath, 'utf8'));
    expect(middleRaw).toEqual(serializePixelGrid(middleGrid));
  });

  it('refuses to overwrite an existing middle lock', () => {
    lockedFirstProject('MidRelock');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const g = setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1);
    const recipe = extractRecipe(g);
    store.writeLock('MidRelock', 'middle', { candidateId: 'candidate_00', grid: g, recipe });
    expect(() =>
      store.writeLock('MidRelock', 'middle', {
        candidateId: 'candidate_01',
        grid: g,
        recipe,
      }),
    ).toThrow(/already locked/i);
  });

  it('excludes lock.json + recipe.json from middle-stage candidate listing', () => {
    const projectDir = lockedFirstProject('MidFilter');
    const store = createProjectStore({ repoRoot: tmpRoot });
    fs.writeFileSync(
      path.join(projectDir, 'candidates', 'middle', 'lock.json'),
      JSON.stringify({ candidateId: 'candidate_00', recipe: {} }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'candidates', 'middle', 'recipe.json'),
      JSON.stringify({ width: 2, height: 2 }),
      'utf8',
    );
    expect(store.readCandidates('MidFilter', 'middle').map((c) => c.id)).toEqual([
      'candidate_00',
      'candidate_01',
    ]);
  });
});

// Reference-image listing — issue #16.
//
// The PRD's reference-panel acceptance criterion ("a reference panel lists
// images from projects/<Name>/source/") needs a deterministic file listing
// the HTTP layer can serialise. The store does the directory read + name
// validation here so the HTTP route stays a thin wrapper that only adds
// MIME / static-file serving.

describe('projectStore.listSourceImages', () => {
  const palette = { version: 1, colors: [{ index: 0, rgba: '00000000' }] };
  const blank = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));

  it('lists every image file from projects/<Name>/source/ sorted by filename', () => {
    writeProject('Refs', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const sourceDir = path.join(tmpRoot, 'projects', 'Refs', 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    // Real cursor projects mix screenshots and photos — accept both.
    fs.writeFileSync(path.join(sourceDir, 'beta.png'), 'png-bytes', 'utf8');
    fs.writeFileSync(path.join(sourceDir, 'alpha.jpg'), 'jpg-bytes', 'utf8');
    fs.writeFileSync(path.join(sourceDir, 'gamma.JPEG'), 'jpeg-bytes', 'utf8');

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listSourceImages('Refs')).toEqual(['alpha.jpg', 'beta.png', 'gamma.JPEG']);
  });

  it('returns an empty list when source/ does not exist', () => {
    writeProject('NoSource', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listSourceImages('NoSource')).toEqual([]);
  });

  it('ignores non-image files and subdirectories', () => {
    writeProject('Mixed', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const sourceDir = path.join(tmpRoot, 'projects', 'Mixed', 'source');
    fs.mkdirSync(path.join(sourceDir, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'ref.png'), 'png-bytes', 'utf8');
    // Notes / READMEs sometimes live alongside reference images; they are
    // not images so the panel ignores them.
    fs.writeFileSync(path.join(sourceDir, 'notes.md'), '# refs', 'utf8');
    // A nested directory must not surface as if it were a file.
    fs.writeFileSync(path.join(sourceDir, 'inner', 'nested.png'), 'png-bytes', 'utf8');

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.listSourceImages('Mixed')).toEqual(['ref.png']);
  });

  it('rejects path-traversal in the project name', () => {
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.listSourceImages('../escape')).toThrow(/invalid project name/i);
  });

  it('resolveSourceImagePath returns the absolute path for a listed image', () => {
    writeProject('Resolve', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const sourceDir = path.join(tmpRoot, 'projects', 'Resolve', 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'pic.png'), 'png-bytes', 'utf8');

    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(store.resolveSourceImagePath('Resolve', 'pic.png')).toBe(
      path.join(sourceDir, 'pic.png'),
    );
  });

  it('resolveSourceImagePath rejects path-traversal in the file name', () => {
    writeProject('Resolve2', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    // A bug in the HTTP routing must not be able to escape the source/
    // directory via `..` or a slash.
    expect(() => store.resolveSourceImagePath('Resolve2', '../escape.png')).toThrow(
      /source image/i,
    );
    expect(() => store.resolveSourceImagePath('Resolve2', 'a/b.png')).toThrow(/source image/i);
  });

  it('resolveSourceImagePath rejects an unknown image', () => {
    writeProject('Resolve3', { 'palette.json': palette, 'frames/frame_00.json': blank });
    const store = createProjectStore({ repoRoot: tmpRoot });
    expect(() => store.resolveSourceImagePath('Resolve3', 'missing.png')).toThrow(/not found/i);
  });
});
