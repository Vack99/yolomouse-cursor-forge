// PixelEditor — glue between the edit/undo reducer and the React canvas.
//
// Owns the editor reducer state, draws the tool palette + swatch picker, and
// streams writes back to the project store over the PUT endpoints added in
// #13. The reducer (src/lib/editReducer) is the deep module — this is purely
// orchestration: click → dispatch → render → debounced fetch.
//
// Persistence model: every grid mutation schedules a write to the supplied
// `onPersist(grid)` callback after a short idle window. We don't write
// every keystroke because a click-drag fires many small edits in quick
// succession; one write at the end of the gesture is enough and keeps the
// watcher quiet. Undo/redo also persist — the disk is the single source of
// truth and the next page-load reads from disk, not from React state.

import { useCallback, useEffect, useMemo, useReducer, useRef, type Reducer } from 'react';
import { PixelCanvas } from './PixelCanvas.js';
import { serializePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import {
  createEditorState,
  reduceEditor,
  type EditorAction,
  type EditorState,
  type Tool,
} from '../lib/editReducer.js';

interface PaletteEntry {
  index: number;
  rgba: string;
}

interface Palette {
  colors: PaletteEntry[];
}

interface Props {
  /** Starting grid — refreshed via the `grid-replaced` action when it changes. */
  grid: PixelGrid;
  palette: Palette;
  /** Screen pixels per cell of the main canvas. */
  pixelSize: number;
  /**
   * Onion-skin grids — locked keyframes ghosted faintly under the working
   * grid. Issue #16. Pass an empty array (or undefined) to render no onion.
   */
  onion?: ReadonlyArray<PixelGrid>;
  /**
   * Optional persistence sink. Called with the new grid after every mutating
   * action; the editor schedules the call on a short debounce so a drag is
   * one write, not many. Pass `undefined` to disable persistence (e.g. for
   * read-only previews).
   */
  onPersist?: (grid: PixelGrid) => Promise<void> | void;
}

const TOOLS: ReadonlyArray<{ id: Tool; label: string; hotkey: string }> = [
  { id: 'pencil', label: 'Pencil', hotkey: 'P' },
  { id: 'eraser', label: 'Eraser', hotkey: 'E' },
  { id: 'eyedropper', label: 'Eyedropper', hotkey: 'I' },
  // Issue #16 — draggable hotspot crosshair.
  { id: 'hotspot', label: 'Hotspot', hotkey: 'H' },
];

const PERSIST_DEBOUNCE_MS = 120;

export function PixelEditor({ grid, palette, pixelSize, onion, onPersist }: Props): JSX.Element {
  const editorReducer: Reducer<EditorState, EditorAction> = reduceEditor;
  // The reducer is seeded once on first mount with the initial grid; later
  // grid changes from disk arrive via the `grid-replaced` effect below.
  const [editor, dispatch] = useReducer(
    editorReducer,
    grid,
    (g) => createEditorState({ grid: g }),
  );

  // When the caller swaps in a new grid (file watcher push, project switch,
  // candidate select), adopt it without dropping the user's undo history.
  // editor.grid stays referentially stable until the next dispatch, so
  // skipping the no-op replacement keeps the dependency chain quiet.
  useEffect(() => {
    if (editor.grid !== grid) {
      dispatch({ type: 'grid-replaced', grid });
    }
    // editor.grid is intentionally omitted — we only want to react to the
    // external `grid` prop changing, not to our own dispatches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);

  // Debounced persistence. Tracks the latest grid the user produced and
  // fires `onPersist` once the user pauses. A pending timer is cleared on
  // unmount so we don't write a stale grid back after navigating away.
  const persistRef = useRef<{ grid: PixelGrid | null; timer: ReturnType<typeof setTimeout> | null }>(
    { grid: null, timer: null },
  );
  useEffect(() => {
    if (!onPersist) return;
    // Skip the initial mount — we only persist user-driven changes, not the
    // grid the caller handed us.
    if (persistRef.current.grid === null) {
      persistRef.current.grid = editor.grid;
      return;
    }
    if (persistRef.current.grid === editor.grid) return;
    persistRef.current.grid = editor.grid;
    if (persistRef.current.timer) clearTimeout(persistRef.current.timer);
    const next = editor.grid;
    persistRef.current.timer = setTimeout(() => {
      persistRef.current.timer = null;
      void Promise.resolve(onPersist(next));
    }, PERSIST_DEBOUNCE_MS);
  }, [editor.grid, onPersist]);
  useEffect(() => {
    return () => {
      if (persistRef.current.timer) clearTimeout(persistRef.current.timer);
    };
  }, []);

  const onPixel = useCallback(
    (x: number, y: number): void => {
      dispatch({ type: 'paint', x, y });
    },
    [],
  );

  const onHotspot = useCallback(
    (x: number, y: number): void => {
      dispatch({ type: 'set-hotspot', x, y });
    },
    [],
  );

  // Keyboard shortcuts — P/E/I to switch tools, Ctrl+Z / Ctrl+Y for undo /
  // redo. Listen on the window so the user does not have to focus the
  // canvas first; ignore the shortcut when an input/textarea has focus so
  // we don't fight typing in form fields (none today, but future-proof).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: 'undo' });
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const tool = TOOLS.find((t) => t.hotkey.toLowerCase() === k);
      if (tool) {
        e.preventDefault();
        dispatch({ type: 'select-tool', tool: tool.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const paletteEntries = useMemo(
    () => palette.colors.slice().sort((a, b) => a.index - b.index),
    [palette],
  );

  const canUndo = editor.history.past.length > 0;
  const canRedo = editor.history.future.length > 0;

  return (
    <div className="studio__editor">
      <div className="studio__editor-toolbar" role="toolbar" aria-label="Pixel editor tools">
        <div className="studio__editor-tools" role="radiogroup" aria-label="Drawing tool">
          {TOOLS.map((t) => {
            const active = editor.tool === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`studio__tool ${active ? 'studio__tool--active' : ''}`}
                onClick={() => dispatch({ type: 'select-tool', tool: t.id })}
                title={`${t.label} (${t.hotkey})`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="studio__editor-history">
          <button
            type="button"
            className="studio__tool"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            className="studio__tool"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
          >
            Redo
          </button>
        </div>
        <div className="studio__editor-swatches" role="radiogroup" aria-label="Palette swatches">
          {paletteEntries.map((entry) => {
            const active = editor.activeIndex === entry.index;
            const isTransparent = entry.index === 0;
            return (
              <button
                key={entry.index}
                type="button"
                role="radio"
                aria-checked={active}
                className={`studio__swatch ${active ? 'studio__swatch--active' : ''} ${
                  isTransparent ? 'studio__swatch--transparent' : ''
                }`}
                onClick={() => dispatch({ type: 'select-index', index: entry.index })}
                title={isTransparent ? `Transparent (index 0)` : `Index ${entry.index} — #${entry.rgba}`}
                style={isTransparent ? undefined : { backgroundColor: rgbaCss(entry.rgba) }}
              >
                <span className="studio__swatch-label">{entry.index}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="studio__canvas-wrap">
        <PixelCanvas
          grid={editor.grid}
          palette={palette}
          pixelSize={pixelSize}
          onion={onion}
          // Tool dictates which gesture sink the canvas drives — never both
          // at once, so a pencil drag cannot accidentally relocate the
          // crosshair, and a hotspot drag cannot accidentally paint pixels.
          {...(editor.tool === 'hotspot' ? { onHotspot } : { onPixel })}
        />
      </div>
    </div>
  );
}

function rgbaCss(hex: string): string {
  const h = hex.trim();
  if (h.length !== 6 && h.length !== 8) return '#000';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${a})`;
}
