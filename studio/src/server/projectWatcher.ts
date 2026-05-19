// projectWatcher — watches one project directory for design-asset changes.
//
// Deep module. Public contract:
//   - emit { kind: 'frame', fileName } when any *.json file under frames/
//     is created or modified.
//   - emit { kind: 'palette' } when palette.json is created or modified.
//   - debounce a burst of writes into a single event per (kind, fileName).
//   - never throw to subscribers; never emit after close().
//
// Networking, broadcasting, and reading file contents are NOT this module's
// job — the HTTP/WebSocket glue subscribes to events and decides what to do.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ReloadEvent =
  | { kind: 'frame'; fileName: string }
  | { kind: 'palette' };

export type ReloadListener = (event: ReloadEvent) => void;

export interface ProjectWatcher {
  onChange(listener: ReloadListener): () => void;
  close(): void;
}

export interface ProjectWatcherOptions {
  /** Absolute path to the project directory (the one containing palette.json + frames/). */
  projectDir: string;
  /** Coalesce events that arrive inside this window. Default 80ms. */
  debounceMs?: number;
}

const FRAME_EXT = '.json';
const PALETTE_FILE = 'palette.json';

export function createProjectWatcher(opts: ProjectWatcherOptions): ProjectWatcher {
  const { projectDir } = opts;
  const debounceMs = opts.debounceMs ?? 80;

  const framesDir = path.join(projectDir, 'frames');
  const listeners = new Set<ReloadListener>();
  // One timer per (kind, fileName) so unrelated changes do not coalesce.
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  const schedule = (key: string, event: ReloadEvent): void => {
    if (closed) return;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(key);
      if (closed) return;
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          // Subscriber faults must not take down the watcher.
        }
      }
    }, debounceMs);
    timers.set(key, t);
  };

  const onFramesEvent = (_evt: fs.WatchEventType, fileName: string | Buffer | null): void => {
    if (closed || fileName == null) return;
    const name = fileName.toString();
    if (!name.toLowerCase().endsWith(FRAME_EXT)) return;
    schedule(`frame:${name}`, { kind: 'frame', fileName: name });
  };

  const onProjectEvent = (_evt: fs.WatchEventType, fileName: string | Buffer | null): void => {
    if (closed || fileName == null) return;
    const name = fileName.toString();
    if (name !== PALETTE_FILE) return;
    schedule('palette', { kind: 'palette' });
  };

  // Watch both the frames/ directory (for individual frame writes) and the
  // project root (for palette.json). Using two narrow watchers lets us
  // classify events without re-reading directory listings.
  let framesWatcher: fs.FSWatcher | undefined;
  if (fs.existsSync(framesDir)) {
    framesWatcher = fs.watch(framesDir, { persistent: false }, onFramesEvent);
  }
  const rootWatcher = fs.watch(projectDir, { persistent: false }, onProjectEvent);

  return {
    onChange(listener: ReloadListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      listeners.clear();
      try {
        framesWatcher?.close();
      } catch {
        // ignore
      }
      try {
        rootWatcher.close();
      } catch {
        // ignore
      }
    },
  };
}
