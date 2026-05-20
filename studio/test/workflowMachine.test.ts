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
