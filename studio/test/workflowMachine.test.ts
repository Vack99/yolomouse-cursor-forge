import { describe, it, expect } from 'vitest';
import {
  createWorkflowState,
  extractRecipe,
  reduceWorkflow,
  type Recipe,
  type WorkflowState,
} from '../src/lib/workflowMachine.js';
import { createPixelGrid, setPixel, type PixelGrid } from '../src/lib/pixelGrid.js';

// Workflow state machine — pure reducer for the candidate-gallery workflow.
//
// Issue #11 scope: the `first` stage. The reducer holds the set of candidate
// ids known for the stage plus a "selected candidate" pointer. Later issues
// (#12 lock, #15 middle, #17 last, #14 generate-more) layer extra transitions
// onto the same reducer without changing the shape this slice introduces.
//
// A candidate id is a stable identifier — for the project-store backed
// implementation it is the basename of the JSON file (e.g. 'candidate_03'),
// but the reducer treats ids as opaque strings.

describe('workflowMachine — initial state', () => {
  it('starts on the first stage with no candidates and no selection', () => {
    const s = createWorkflowState();
    expect(s.stage).toBe('first');
    expect(s.candidates.first).toEqual([]);
    expect(s.selected.first).toBeUndefined();
  });
});

describe('workflowMachine — candidates-loaded', () => {
  it('records every candidate id from disk and auto-selects the first one when nothing is selected', () => {
    const s0 = createWorkflowState();
    const s1 = reduceWorkflow(s0, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    expect(s1.candidates.first).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
    expect(s1.selected.first).toBe('candidate_00');
  });

  it('preserves the current selection when it still exists in the new id list', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' });
    expect(s.selected.first).toBe('candidate_01');

    // A new file lands on disk — the existing selection must survive.
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    expect(s.candidates.first).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
    expect(s.selected.first).toBe('candidate_01');
  });

  it('falls back to the first id when the prior selection no longer exists', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' });

    // The selected candidate disappears from disk.
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_02'],
    });
    expect(s.selected.first).toBe('candidate_00');
  });

  it('clears the selection when no candidates remain', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(s.selected.first).toBe('candidate_00');
    s = reduceWorkflow(s, { type: 'candidates-loaded', stage: 'first', ids: [] });
    expect(s.candidates.first).toEqual([]);
    expect(s.selected.first).toBeUndefined();
  });

  it('does not mutate the input state (purity)', () => {
    const s0 = createWorkflowState();
    const before = JSON.stringify(s0);
    reduceWorkflow(s0, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('workflowMachine — select', () => {
  it('updates the selected candidate when the id is in the candidate set', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_02' });
    expect(s.selected.first).toBe('candidate_02');
  });

  it('rejects selection of an id that is not in the candidate set', () => {
    const s = reduceWorkflow(createWorkflowState(), {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_99' }),
    ).toThrow(/not in candidate set/i);
  });

  it('rejects selecting on a stage that has no candidates loaded', () => {
    const s = createWorkflowState();
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_00' }),
    ).toThrow(/not in candidate set/i);
  });
});

// Issue #12 — locking the first frame.
//
// `lock` is the transition that ends the first stage. Once an id is locked
// the reducer:
//   - advances `stage` to 'middle';
//   - records `{ id, recipe }` in `locked.first`;
//   - rejects further first-stage actions (select / candidates-loaded / lock)
//     so the locked grid stays the truth for the frame.
// `extractRecipe(grid)` is the helper that derives a composition recipe from
// a grid; glue code calls it and hands the result into the `lock` action.

function gridWithPixels(): PixelGrid {
  let g = createPixelGrid({ width: 3, height: 3, hotspot: { x: 1, y: 1 } });
  g = setPixel(g, 0, 0, 2);
  g = setPixel(g, 1, 0, 2);
  g = setPixel(g, 2, 1, 5);
  return g;
}

describe('extractRecipe', () => {
  it('captures palette indices in use, proportions, hotspot, and filled-cell count', () => {
    const g = gridWithPixels();
    const r = extractRecipe(g);
    expect(r.width).toBe(3);
    expect(r.height).toBe(3);
    expect(r.hotspot).toEqual({ x: 1, y: 1 });
    // Palette indices are sorted, ascending, and exclude index 0 (transparent).
    expect(r.paletteIndices).toEqual([2, 5]);
    expect(r.filledCells).toBe(3);
  });

  it('returns an empty palette and zero filled cells for a transparent grid', () => {
    const g = createPixelGrid({ width: 2, height: 2 });
    const r = extractRecipe(g);
    expect(r.paletteIndices).toEqual([]);
    expect(r.filledCells).toBe(0);
  });
});

describe('workflowMachine — lock', () => {
  function preload(): WorkflowState {
    return reduceWorkflow(createWorkflowState(), {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
  }

  const sampleRecipe: Recipe = extractRecipe(gridWithPixels());

  it('advances the stage to middle and records the locked id + recipe', () => {
    let s: WorkflowState = preload();
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' });
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'first',
      id: 'candidate_01',
      recipe: sampleRecipe,
    });
    expect(s.stage).toBe('middle');
    expect(s.locked.first).toEqual({ id: 'candidate_01', recipe: sampleRecipe });
    // The candidate set stays on disk and browsable — the gallery still has
    // every candidate after the lock (PRD: "nothing discarded").
    expect(s.candidates.first).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
  });

  it('rejects locking an id that is not in the candidate set', () => {
    const s = preload();
    expect(() =>
      reduceWorkflow(s, {
        type: 'lock',
        stage: 'first',
        id: 'candidate_99',
        recipe: sampleRecipe,
      }),
    ).toThrow(/not in candidate set/i);
  });

  it('rejects a second lock on the same stage', () => {
    let s: WorkflowState = preload();
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'first',
      id: 'candidate_00',
      recipe: sampleRecipe,
    });
    expect(() =>
      reduceWorkflow(s, {
        type: 'lock',
        stage: 'first',
        id: 'candidate_01',
        recipe: sampleRecipe,
      }),
    ).toThrow(/already locked/i);
  });

  it('rejects further first-stage select transitions once locked', () => {
    let s: WorkflowState = preload();
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'first',
      id: 'candidate_00',
      recipe: sampleRecipe,
    });
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' }),
    ).toThrow(/locked/i);
  });

  it('rejects further first-stage candidates-loaded transitions once locked', () => {
    let s: WorkflowState = preload();
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'first',
      id: 'candidate_00',
      recipe: sampleRecipe,
    });
    expect(() =>
      reduceWorkflow(s, {
        type: 'candidates-loaded',
        stage: 'first',
        ids: ['candidate_00', 'candidate_01', 'candidate_02', 'candidate_03'],
      }),
    ).toThrow(/locked/i);
  });

  it('does not mutate the input state (purity)', () => {
    const s = preload();
    const before = JSON.stringify(s);
    reduceWorkflow(s, {
      type: 'lock',
      stage: 'first',
      id: 'candidate_00',
      recipe: sampleRecipe,
    });
    expect(JSON.stringify(s)).toBe(before);
  });
});

// candidates-loaded carries an optional `locked` field so the reducer's
// state can be rehydrated from disk on page reload. This matters because
// the filesystem is the single source of truth — closing the tab and
// re-opening it must restore the locked stage, not drop back to `first`.

describe('workflowMachine — candidates-loaded with lock metadata', () => {
  const sampleRecipe: Recipe = extractRecipe(gridWithPixels());

  it('rehydrates the locked stage from disk and starts on middle', () => {
    const s = reduceWorkflow(createWorkflowState(), {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
      locked: { id: 'candidate_00', recipe: sampleRecipe },
    });
    expect(s.stage).toBe('middle');
    expect(s.locked.first).toEqual({ id: 'candidate_00', recipe: sampleRecipe });
    expect(s.candidates.first).toEqual(['candidate_00', 'candidate_01']);
    // The locked candidate is the auto-selected one — the gallery shows the
    // frozen frame large by default.
    expect(s.selected.first).toBe('candidate_00');
  });

  it('rejects a locked id that is not present in the candidate set', () => {
    expect(() =>
      reduceWorkflow(createWorkflowState(), {
        type: 'candidates-loaded',
        stage: 'first',
        ids: ['candidate_00'],
        locked: { id: 'candidate_99', recipe: sampleRecipe },
      }),
    ).toThrow(/not in candidate set/i);
  });
});

// Issue #15 — middle-frame stage.
//
// Once the `first` stage is locked the reducer advances to `middle`. The same
// `candidates-loaded` / `select` / `lock` actions apply to the new stage; a
// successful lock on `middle` advances to `last`. Crucially, the `first`
// stage's locked metadata must persist through all middle-stage transitions
// — it is the recipe driving middle-candidate generation and the truth for
// the first frame in the eventual tween.

describe('workflowMachine — middle stage', () => {
  const firstRecipe: Recipe = extractRecipe(gridWithPixels());

  function preloadFirstLocked(): WorkflowState {
    // Set up a state where the first stage is already locked — i.e. we are
    // sitting at the start of the middle stage with no middle candidates yet.
    return reduceWorkflow(createWorkflowState(), {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
      locked: { id: 'candidate_00', recipe: firstRecipe },
    });
  }

  it('initial state shape includes a middle slot with no candidates and no selection', () => {
    const s = createWorkflowState();
    expect(s.candidates.middle).toEqual([]);
    expect(s.selected.middle).toBeUndefined();
    expect(s.locked.middle).toBeUndefined();
  });

  it('records middle-stage candidates via candidates-loaded after the first lock', () => {
    let s = preloadFirstLocked();
    expect(s.stage).toBe('middle');
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    expect(s.candidates.middle).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
    expect(s.selected.middle).toBe('candidate_00');
    // First stage stays locked through middle-stage transitions.
    expect(s.locked.first).toEqual({ id: 'candidate_00', recipe: firstRecipe });
    expect(s.candidates.first).toEqual(['candidate_00', 'candidate_01']);
  });

  it('selects a middle candidate when it is in the middle candidate set', () => {
    let s = preloadFirstLocked();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'middle', id: 'candidate_02' });
    expect(s.selected.middle).toBe('candidate_02');
    // Selecting in middle does not disturb the first stage's selection.
    expect(s.selected.first).toBe('candidate_00');
  });

  it('locks a middle candidate and advances the stage to last', () => {
    let s = preloadFirstLocked();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01'],
    });
    const midRecipe: Recipe = extractRecipe(gridWithPixels());
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'middle',
      id: 'candidate_01',
      recipe: midRecipe,
    });
    expect(s.stage).toBe('last');
    expect(s.locked.middle).toEqual({ id: 'candidate_01', recipe: midRecipe });
    // Locked first-stage data is untouched — both keyframes are now frozen.
    expect(s.locked.first).toEqual({ id: 'candidate_00', recipe: firstRecipe });
    // Candidate set stays browsable after the lock (PRD: nothing discarded).
    expect(s.candidates.middle).toEqual(['candidate_00', 'candidate_01']);
  });

  it('rejects a select on the middle stage when no middle candidates are loaded', () => {
    const s = preloadFirstLocked();
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'middle', id: 'candidate_00' }),
    ).toThrow(/not in candidate set/i);
  });

  it('rejects locking a middle candidate that is not in the middle candidate set', () => {
    let s = preloadFirstLocked();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00'],
    });
    const midRecipe: Recipe = extractRecipe(gridWithPixels());
    expect(() =>
      reduceWorkflow(s, {
        type: 'lock',
        stage: 'middle',
        id: 'candidate_99',
        recipe: midRecipe,
      }),
    ).toThrow(/not in candidate set/i);
  });

  it('rejects a second lock on the middle stage', () => {
    let s = preloadFirstLocked();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01'],
    });
    const midRecipe: Recipe = extractRecipe(gridWithPixels());
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'middle',
      id: 'candidate_00',
      recipe: midRecipe,
    });
    expect(() =>
      reduceWorkflow(s, {
        type: 'lock',
        stage: 'middle',
        id: 'candidate_01',
        recipe: midRecipe,
      }),
    ).toThrow(/already locked/i);
  });

  it('rejects further middle-stage select transitions once locked', () => {
    let s = preloadFirstLocked();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01'],
    });
    const midRecipe: Recipe = extractRecipe(gridWithPixels());
    s = reduceWorkflow(s, {
      type: 'lock',
      stage: 'middle',
      id: 'candidate_00',
      recipe: midRecipe,
    });
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'middle', id: 'candidate_01' }),
    ).toThrow(/locked/i);
  });

  it('rehydrates a middle-stage lock from disk and advances to last', () => {
    // Both stages already locked on disk — the reducer should land on `last`
    // after replaying the two candidates-loaded events.
    let s = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
      locked: { id: 'candidate_00', recipe: firstRecipe },
    });
    const midRecipe: Recipe = extractRecipe(gridWithPixels());
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'middle',
      ids: ['candidate_00', 'candidate_01'],
      locked: { id: 'candidate_01', recipe: midRecipe },
    });
    expect(s.stage).toBe('last');
    expect(s.locked.first).toEqual({ id: 'candidate_00', recipe: firstRecipe });
    expect(s.locked.middle).toEqual({ id: 'candidate_01', recipe: midRecipe });
    // Auto-selection on rehydration picks the locked id so the gallery
    // opens on the frozen frame.
    expect(s.selected.middle).toBe('candidate_01');
  });
});
