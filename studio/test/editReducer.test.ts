import { describe, it, expect } from 'vitest';
import {
  createEditorState,
  reduceEditor,
  type EditorState,
} from '../src/lib/editReducer.js';
import { createPixelGrid, getPixel, setPixel } from '../src/lib/pixelGrid.js';

// Edit/undo reducer — pure module riding on the pixel-grid model.
//
// Issue #13 scope: pencil, eraser, eyedropper, undo/redo. The reducer holds:
//   - the working PixelGrid (the live edit surface);
//   - the active tool ('pencil' | 'eraser' | 'eyedropper');
//   - the active palette index (the pencil paints with this);
//   - an undo stack and a redo stack of prior grids, bounded by `historyLimit`.
//
// Selecting a tool deselects the others (single-active model — acceptance
// criterion 1). The eyedropper changes `activeIndex` rather than the grid —
// it is a sampling tool, not a paint stroke.
//
// Pencil/eraser actions push the previous grid onto the undo stack and clear
// the redo stack. Undo moves the current grid onto the redo stack and pops the
// undo stack; redo is its mirror. Both no-op (rather than throw) when the
// relevant stack is empty so the UI can wire them to keys without guarding.
//
// `historyLimit` defaults to 50 entries — enough to undo a typical run of
// small fixes without hoarding memory on 256×256 grids.

function blank(width = 4, height = 4): EditorState {
  return createEditorState({
    grid: createPixelGrid({ width, height }),
    activeIndex: 1,
  });
}

describe('editReducer — initial state', () => {
  it('starts with the supplied grid, pencil tool, and the supplied palette index', () => {
    const s = blank();
    expect(s.tool).toBe('pencil');
    expect(s.activeIndex).toBe(1);
    expect(s.grid.width).toBe(4);
    expect(s.history.past).toEqual([]);
    expect(s.history.future).toEqual([]);
  });

  it('defaults activeIndex to 1 (the first non-transparent palette slot) when omitted', () => {
    const s = createEditorState({ grid: createPixelGrid({ width: 2, height: 2 }) });
    expect(s.activeIndex).toBe(1);
  });
});

describe('editReducer — tool selection (single-active)', () => {
  it('select-tool replaces the active tool; only one tool is ever active', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'select-tool', tool: 'eraser' });
    expect(s.tool).toBe('eraser');
    s = reduceEditor(s, { type: 'select-tool', tool: 'eyedropper' });
    expect(s.tool).toBe('eyedropper');
    s = reduceEditor(s, { type: 'select-tool', tool: 'pencil' });
    expect(s.tool).toBe('pencil');
  });

  it('selecting the same tool again is a no-op', () => {
    const s0 = blank();
    const s1 = reduceEditor(s0, { type: 'select-tool', tool: 'pencil' });
    // Identity-equal so React skips re-renders for noop tool clicks.
    expect(s1).toBe(s0);
  });
});

describe('editReducer — palette index', () => {
  it('select-index sets the active palette slot the pencil paints with', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'select-index', index: 5 });
    expect(s.activeIndex).toBe(5);
  });

  it('rejects a negative palette index', () => {
    const s = blank();
    expect(() => reduceEditor(s, { type: 'select-index', index: -1 })).toThrow(/index/);
  });
});

describe('editReducer — paint (pencil)', () => {
  it('writes activeIndex to the grid at the clicked pixel', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 1, y: 2 });
    expect(getPixel(s.grid, 1, 2)).toBe(1);
    // Other pixels untouched.
    expect(getPixel(s.grid, 0, 0)).toBe(0);
  });

  it('pushes the prior grid onto the undo stack and clears the redo stack', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    expect(s.history.past).toHaveLength(1);
    expect(s.history.future).toEqual([]);
  });

  it('paint with eraser tool selected writes transparent (0) instead of activeIndex', () => {
    // Start with a pixel already painted so the eraser has something to clear.
    let s = createEditorState({
      grid: setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 1, 4),
      activeIndex: 4,
    });
    s = reduceEditor(s, { type: 'select-tool', tool: 'eraser' });
    s = reduceEditor(s, { type: 'paint', x: 1, y: 1 });
    expect(getPixel(s.grid, 1, 1)).toBe(0);
  });

  it('paint with eyedropper tool selected sets activeIndex to the sampled pixel and does not touch the grid', () => {
    const grid = setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 7);
    let s = createEditorState({ grid, activeIndex: 1 });
    s = reduceEditor(s, { type: 'select-tool', tool: 'eyedropper' });
    s = reduceEditor(s, { type: 'paint', x: 1, y: 0 });
    expect(s.activeIndex).toBe(7);
    // Grid is unchanged — eyedropper never mutates pixels.
    expect(getPixel(s.grid, 1, 0)).toBe(7);
    // Eyedropper sampling does NOT consume undo history — there is no edit
    // to undo.
    expect(s.history.past).toEqual([]);
  });

  it('paint that does not change the pixel value is a no-op (no history entry)', () => {
    // Painting transparent into a transparent cell with the eraser, or
    // re-painting the same palette index with the pencil, should not push a
    // history entry — repeated clicks on the same cell would otherwise blow
    // the undo stack.
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    const s1 = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    // Identity-equal: nothing changed.
    expect(s1).toBe(s);
  });

  it('rejects out-of-bounds paint coordinates by surfacing the pixel-grid error', () => {
    const s = blank();
    expect(() => reduceEditor(s, { type: 'paint', x: 99, y: 0 })).toThrow(/bounds/);
  });
});

describe('editReducer — undo / redo', () => {
  it('undo restores the previous grid and moves the current grid to the redo stack', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    s = reduceEditor(s, { type: 'paint', x: 1, y: 0 });
    expect(getPixel(s.grid, 0, 0)).toBe(1);
    expect(getPixel(s.grid, 1, 0)).toBe(1);

    s = reduceEditor(s, { type: 'undo' });
    expect(getPixel(s.grid, 0, 0)).toBe(1);
    expect(getPixel(s.grid, 1, 0)).toBe(0);
    expect(s.history.future).toHaveLength(1);
  });

  it('redo replays an undone edit', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    s = reduceEditor(s, { type: 'undo' });
    expect(getPixel(s.grid, 0, 0)).toBe(0);

    s = reduceEditor(s, { type: 'redo' });
    expect(getPixel(s.grid, 0, 0)).toBe(1);
    expect(s.history.future).toEqual([]);
  });

  it('undo with an empty undo stack is a no-op', () => {
    const s0 = blank();
    const s1 = reduceEditor(s0, { type: 'undo' });
    expect(s1).toBe(s0);
  });

  it('redo with an empty redo stack is a no-op', () => {
    const s0 = blank();
    const s1 = reduceEditor(s0, { type: 'redo' });
    expect(s1).toBe(s0);
  });

  it('a new paint after an undo clears the redo stack', () => {
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    s = reduceEditor(s, { type: 'undo' });
    expect(s.history.future).toHaveLength(1);

    s = reduceEditor(s, { type: 'paint', x: 1, y: 1 });
    // A divergent edit invalidates the redo history.
    expect(s.history.future).toEqual([]);
  });

  it('caps the undo stack at historyLimit (oldest entries drop)', () => {
    let s = createEditorState({
      grid: createPixelGrid({ width: 4, height: 4 }),
      activeIndex: 1,
      historyLimit: 3,
    });
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    s = reduceEditor(s, { type: 'paint', x: 1, y: 0 });
    s = reduceEditor(s, { type: 'paint', x: 2, y: 0 });
    s = reduceEditor(s, { type: 'paint', x: 3, y: 0 });
    // Limit is 3 — oldest entry dropped.
    expect(s.history.past).toHaveLength(3);
  });

  it('does not mutate the input state (purity)', () => {
    const s0 = blank();
    const before = JSON.stringify(s0);
    reduceEditor(s0, { type: 'paint', x: 0, y: 0 });
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('editReducer — grid replacement (external sync)', () => {
  it('grid-replaced swaps the working grid without consuming history', () => {
    // When the file watcher pushes a fresh grid from disk (e.g. Claude
    // generated a new candidate), the editor must adopt it without dropping
    // pending undo history — the user might still want to undo their own
    // local edits. Acceptance criterion #6: manual edits stick — the recipe
    // does not silently overwrite them. The reducer leaves history intact so
    // a subsequent edit + undo behaves correctly.
    let s = blank();
    s = reduceEditor(s, { type: 'paint', x: 0, y: 0 });
    const replacement = setPixel(createPixelGrid({ width: 4, height: 4 }), 3, 3, 9);
    s = reduceEditor(s, { type: 'grid-replaced', grid: replacement });
    expect(getPixel(s.grid, 3, 3)).toBe(9);
    // Past history is preserved so the user does not lose their undo stack.
    expect(s.history.past).toHaveLength(1);
  });
});
