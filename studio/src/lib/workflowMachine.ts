// Workflow state machine — pure reducer driving the candidate-gallery flow.
//
// Deep module. The Cursor Studio workflow is "first frame → middle frame →
// last frame → tween" (see PRD #5). This slice (issues #11, #12) implements
// the `first` stage's candidate set + selection pointer plus the `lock`
// transition that ends the first stage. Later slices add middle/last
// candidates (#15/#17) and tween transitions (#18). The shape is
// deliberately built so those additions only add new action types and new
// stage entries — never reshape what already exists.
//
// The reducer is total and pure: invalid transitions throw, no internal
// mutation, no IO. The project store decides which candidate ids exist on
// disk and dispatches `candidates-loaded`; the UI dispatches `select` and
// `lock`.

import type { PixelGrid } from './pixelGrid.js';

export type Stage = 'first' | 'middle' | 'last';

/**
 * Composition recipe — metadata captured at lock time so later stages can
 * generate candidates that share the locked frame's silhouette and palette.
 * Derived from the grid by `extractRecipe`; never mutated.
 *
 * S5 captures the minimum needed for #15 to seed candidate generation
 * deterministically: which palette indices the locked frame uses, the
 * grid's proportions and hotspot, and how much of the canvas is filled.
 * Richer "shapes" data (e.g. component analysis) can layer on later
 * without changing the action shape — recipe is treated as opaque metadata
 * by the reducer.
 */
export interface Recipe {
  readonly width: number;
  readonly height: number;
  readonly hotspot: { readonly x: number; readonly y: number };
  /** Palette indices used in the grid, ascending, excluding 0 (transparent). */
  readonly paletteIndices: ReadonlyArray<number>;
  /** Number of non-transparent cells. */
  readonly filledCells: number;
}

export interface LockedFrame {
  readonly id: string;
  readonly recipe: Recipe;
}

export interface WorkflowState {
  /** Which stage of the workflow is currently active. */
  readonly stage: Stage;
  /** Ordered candidate ids per stage. Order matches the on-disk read order. */
  readonly candidates: { readonly [S in Stage]: ReadonlyArray<string> };
  /**
   * Selected candidate id per stage, if any. The selection is what the main
   * view renders large; the rest of the stage's candidates render as
   * thumbnails. Undefined when the stage has no candidates yet.
   */
  readonly selected: { readonly [S in Stage]: string | undefined };
  /**
   * Locked candidate per stage, if any. Locking a stage advances the
   * workflow into the next stage and freezes the candidate's grid as the
   * canonical frame for the locked stage. A locked stage refuses further
   * `select` / `candidates-loaded` / `lock` actions — its grid is the
   * truth from that point on.
   */
  readonly locked: { readonly [S in Stage]: LockedFrame | undefined };
}

export type WorkflowAction =
  | {
      type: 'candidates-loaded';
      stage: Stage;
      ids: ReadonlyArray<string>;
      /**
       * Optional lock metadata from disk — present iff the stage's
       * lock.json exists. Lets the reducer rehydrate the locked state
       * after a page reload so the workflow does not silently roll back
       * to `first` on reconnect.
       */
      locked?: LockedFrame;
    }
  | { type: 'select'; stage: Stage; id: string }
  | { type: 'lock'; stage: Stage; id: string; recipe: Recipe };

/**
 * Stage ordering — single source of truth for "which stage follows which".
 * Re-exported so filesystem adapters (project store's active-stage
 * computation, project watcher's stage list) can read the order without
 * re-encoding it; if the workflow ever gains a new stage (e.g. #18 tween),
 * adding it here propagates everywhere.
 */
export const STAGES: ReadonlyArray<Stage> = ['first', 'middle', 'last'];

const STAGE_AFTER: { readonly [S in Stage]: Stage | undefined } = {
  first: 'middle',
  middle: 'last',
  last: undefined,
};

export function createWorkflowState(): WorkflowState {
  return {
    stage: 'first',
    candidates: { first: [], middle: [], last: [] },
    selected: { first: undefined, middle: undefined, last: undefined },
    locked: { first: undefined, middle: undefined, last: undefined },
  };
}

/**
 * Derive a composition recipe from a pixel grid. Pure — same input,
 * same output. Glue code calls this when dispatching `lock` so the
 * reducer stays IO-free.
 */
export function extractRecipe(grid: PixelGrid): Recipe {
  const used = new Set<number>();
  let filledCells = 0;
  for (const row of grid.pixels) {
    for (const idx of row) {
      if (idx !== 0) {
        used.add(idx);
        filledCells++;
      }
    }
  }
  return {
    width: grid.width,
    height: grid.height,
    hotspot: { x: grid.hotspot.x, y: grid.hotspot.y },
    paletteIndices: [...used].sort((a, b) => a - b),
    filledCells,
  };
}

export function reduceWorkflow(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case 'candidates-loaded': {
      // A locked stage's candidate list is frozen — the on-disk truth is the
      // locked candidate file; later candidate writes must not mutate the
      // reducer's view of the stage.
      const existingLock = state.locked[action.stage];
      if (existingLock !== undefined) {
        // Idempotent rehydration: the UI replays candidates-loaded for every
        // wired stage after each filesystem reload. When the replay matches
        // what the reducer already knows (same lock id, with a `locked`
        // payload carrying the same id), treat it as a no-op so the replay
        // is safe. A replay without a `locked` payload, or with a different
        // locked id, is a real conflict — reject it so a stale event cannot
        // silently erase the lock.
        if (action.locked !== undefined && action.locked.id === existingLock.id) {
          return state;
        }
        throw new Error(
          `workflowMachine: stage '${action.stage}' is locked; further candidates-loaded transitions are rejected`,
        );
      }
      const ids: ReadonlyArray<string> = [...action.ids];
      if (action.locked !== undefined && !ids.includes(action.locked.id)) {
        throw new Error(
          `workflowMachine: locked id '${action.locked.id}' is not in candidate set for stage '${action.stage}'`,
        );
      }
      const prior = state.selected[action.stage];
      // Preserve the user's current selection if it survived the refresh.
      // Otherwise fall back to the locked id (if rehydrating a lock) or the
      // first candidate, or undefined when empty. This keeps the UI from
      // jumping around on every file-watcher push.
      const nextSelected =
        prior !== undefined && ids.includes(prior)
          ? prior
          : action.locked?.id ?? ids[0];
      const advancedStage =
        action.locked !== undefined ? STAGE_AFTER[action.stage] ?? state.stage : state.stage;
      return {
        ...state,
        stage: advancedStage,
        candidates: { ...state.candidates, [action.stage]: ids },
        selected: { ...state.selected, [action.stage]: nextSelected },
        locked: { ...state.locked, [action.stage]: action.locked },
      };
    }
    case 'select': {
      if (state.locked[action.stage] !== undefined) {
        throw new Error(
          `workflowMachine: stage '${action.stage}' is locked; further select transitions are rejected`,
        );
      }
      const set = state.candidates[action.stage];
      if (!set.includes(action.id)) {
        throw new Error(
          `workflowMachine: '${action.id}' is not in candidate set for stage '${action.stage}'`,
        );
      }
      return {
        ...state,
        selected: { ...state.selected, [action.stage]: action.id },
      };
    }
    case 'lock': {
      if (state.locked[action.stage] !== undefined) {
        throw new Error(`workflowMachine: stage '${action.stage}' is already locked`);
      }
      const set = state.candidates[action.stage];
      if (!set.includes(action.id)) {
        throw new Error(
          `workflowMachine: '${action.id}' is not in candidate set for stage '${action.stage}'`,
        );
      }
      const next = STAGE_AFTER[action.stage];
      return {
        ...state,
        // Final stage locks leave `stage` where it is — there is no "after"
        // to advance into. Until #18 adds the tween stage, only `first`
        // has a successor.
        stage: next ?? state.stage,
        locked: {
          ...state.locked,
          [action.stage]: { id: action.id, recipe: action.recipe },
        },
      };
    }
  }
}
