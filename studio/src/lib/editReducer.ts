// Edit/undo reducer — pure module driving the in-canvas pixel editor.
//
// Deep module. Rides on the pixel-grid model. The reducer owns:
//   - `grid`           — the working PixelGrid (the live edit surface).
//   - `tool`           — currently active tool, single-active.
//   - `activeIndex`    — palette index the pencil paints with.
//   - `history.past`   — stack of prior grids for undo, bounded by historyLimit.
//   - `history.future` — stack of redoable grids.
//
// Why a reducer:
//   - Acceptance criterion 5 (#13): "edit/undo reducer is isolation-tested
//     against the pixel-grid model (no DOM)". A pure reducer is the only
//     shape that makes that test trivial.
//   - Acceptance criterion 6: "manual edits to a locked frame stick — the
//     recipe never overwrites them." We persist `grid` to disk on every
//     mutating action; a fresh server-pushed `grid-replaced` keeps `past`
//     intact so the user's undo history survives concurrent recipe writes.
//
// Tool semantics:
//   - pencil    → paint sets pixel(x,y) := activeIndex.
//   - eraser    → paint sets pixel(x,y) := 0 (transparent).
//   - eyedropper → paint reads pixel(x,y) into activeIndex, leaves grid alone.
//   - hotspot   → set-hotspot relocates the hotspot crosshair to (x,y).
// Eyedropper is non-mutating so it does not consume an undo slot.
// Hotspot moves are undoable so a stray drag is reversible the same way a
// stray pixel paint is — Ctrl+Z covers both gestures (issue #16).
//
// History limit defaults to 50: large enough that a run of small fixes
// stays reversible, small enough that the memory footprint on a 256×256
// grid stays well under a megabyte (~64KB per snapshot × 50).

import { getPixel, setHotspot, setPixel, type PixelGrid } from './pixelGrid.js';

export type Tool = 'pencil' | 'eraser' | 'eyedropper' | 'hotspot';

export interface EditorHistory {
  readonly past: ReadonlyArray<PixelGrid>;
  readonly future: ReadonlyArray<PixelGrid>;
}

export interface EditorState {
  readonly grid: PixelGrid;
  readonly tool: Tool;
  readonly activeIndex: number;
  readonly history: EditorHistory;
  /** Maximum size of `history.past`. The redo stack inherits this bound. */
  readonly historyLimit: number;
}

export type EditorAction =
  | { type: 'select-tool'; tool: Tool }
  | { type: 'select-index'; index: number }
  | { type: 'paint'; x: number; y: number }
  | { type: 'set-hotspot'; x: number; y: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'grid-replaced'; grid: PixelGrid };

export interface CreateEditorOptions {
  grid: PixelGrid;
  /** Defaults to 1 — the first non-transparent palette slot. */
  activeIndex?: number;
  /** Defaults to 50. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 50;

export function createEditorState(opts: CreateEditorOptions): EditorState {
  return {
    grid: opts.grid,
    tool: 'pencil',
    activeIndex: opts.activeIndex ?? 1,
    history: { past: [], future: [] },
    historyLimit: opts.historyLimit ?? DEFAULT_HISTORY_LIMIT,
  };
}

function pushPast(history: EditorHistory, grid: PixelGrid, limit: number): EditorHistory {
  // `past` is treated as a queue capped at `limit` — the oldest entry drops
  // when full. The redo stack is always cleared on a fresh edit.
  const next = [...history.past, grid];
  if (next.length > limit) next.shift();
  return { past: next, future: [] };
}

export function reduceEditor(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'select-tool': {
      // Identity-preserving no-op so React skips re-renders for redundant clicks.
      if (state.tool === action.tool) return state;
      return { ...state, tool: action.tool };
    }

    case 'select-index': {
      if (!Number.isInteger(action.index) || action.index < 0) {
        throw new Error(`editReducer: palette index must be a non-negative integer, got ${action.index}`);
      }
      if (state.activeIndex === action.index) return state;
      return { ...state, activeIndex: action.index };
    }

    case 'paint': {
      if (state.tool === 'eyedropper') {
        // Sampling — no grid mutation, no history consumed.
        const sampled = getPixel(state.grid, action.x, action.y);
        if (sampled === state.activeIndex) return state;
        return { ...state, activeIndex: sampled };
      }
      const value = state.tool === 'eraser' ? 0 : state.activeIndex;
      const before = getPixel(state.grid, action.x, action.y);
      if (before === value) {
        // No-op paint: same value already there. Returning the prior state
        // keeps the undo stack from filling with redundant entries when the
        // user clicks-and-drags over a region they already painted.
        return state;
      }
      const nextGrid = setPixel(state.grid, action.x, action.y, value);
      return {
        ...state,
        grid: nextGrid,
        history: pushPast(state.history, state.grid, state.historyLimit),
      };
    }

    case 'set-hotspot': {
      // Idempotent on a same-position drag — the canvas fires moves for
      // every cell crossed during a drag, and most are no-ops.
      if (state.grid.hotspot.x === action.x && state.grid.hotspot.y === action.y) {
        return state;
      }
      const nextGrid = setHotspot(state.grid, { x: action.x, y: action.y });
      return {
        ...state,
        grid: nextGrid,
        history: pushPast(state.history, state.grid, state.historyLimit),
      };
    }

    case 'undo': {
      const past = state.history.past;
      if (past.length === 0) return state;
      const previous = past[past.length - 1]!;
      return {
        ...state,
        grid: previous,
        history: {
          past: past.slice(0, -1),
          future: [...state.history.future, state.grid],
        },
      };
    }

    case 'redo': {
      const future = state.history.future;
      if (future.length === 0) return state;
      const next = future[future.length - 1]!;
      return {
        ...state,
        grid: next,
        history: {
          past: [...state.history.past, state.grid],
          future: future.slice(0, -1),
        },
      };
    }

    case 'grid-replaced': {
      // External replacement (file watcher / programmatic refresh).
      // History is preserved so the user does not lose their undo trail
      // when an unrelated reload event fires. The replacement itself is
      // not an undoable action — the disk is the source of truth.
      if (state.grid === action.grid) return state;
      return { ...state, grid: action.grid };
    }
  }
}
