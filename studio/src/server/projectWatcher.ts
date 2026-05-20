// projectWatcher — watches one project directory for design-asset changes.
//
// Deep module. Public contract:
//   - emit { kind: 'frame', fileName } when any *.json file under frames/
//     is created or modified.
//   - emit { kind: 'palette' } when palette.json is created or modified.
//   - emit { kind: 'candidate', stage, fileName } when any *.json file
//     under candidates/<stage>/ is created or modified.
//   - debounce a burst of writes into a single event per (kind, fileName).
//   - never throw to subscribers; never emit after close().
//
// Networking, broadcasting, and reading file contents are NOT this module's
// job — the HTTP/WebSocket glue subscribes to events and decides what to do.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Stage } from '../lib/workflowMachine.js';

export type ReloadEvent =
  | { kind: 'frame'; fileName: string }
  | { kind: 'palette' }
  | { kind: 'candidate'; stage: Stage; fileName: string }
  // Emitted by activeProjectSession (not by this watcher itself) when the
  // user switches the studio to a different project. Lives in the same
  // union so the reload bridge can broadcast every reload-shaped signal
  // through one channel.
  | { kind: 'project'; name: string };

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
const CANDIDATES_DIR = 'candidates';
const KNOWN_STAGES: ReadonlyArray<Stage> = ['first'];

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

  // One candidates/<stage>/ watcher per known workflow stage. Created lazily
  // — the stage directory only exists once the first candidate file is
  // written, so we open the watcher on demand from the project-root watcher
  // (which sees `candidates/<stage>` directory creation as a `rename` event
  // on `candidates`). Keeping them indexed by stage lets us emit the right
  // tag without sniffing the filesystem path inside the event handler.
  const candidateWatchers = new Map<Stage, fs.FSWatcher>();

  const onCandidateEvent = (stage: Stage) =>
    (_evt: fs.WatchEventType, fileName: string | Buffer | null): void => {
      if (closed || fileName == null) return;
      const name = fileName.toString();
      if (!name.toLowerCase().endsWith(FRAME_EXT)) return;
      schedule(`candidate:${stage}:${name}`, { kind: 'candidate', stage, fileName: name });
    };

  const openCandidateWatcher = (stage: Stage): void => {
    if (closed || candidateWatchers.has(stage)) return;
    const stageDir = path.join(projectDir, CANDIDATES_DIR, stage);
    if (!fs.existsSync(stageDir)) return;
    const w = fs.watch(stageDir, { persistent: false }, onCandidateEvent(stage));
    candidateWatchers.set(stage, w);
  };

  // Watch the frames/ directory (for individual frame writes), every known
  // candidates/<stage>/ that already exists, and the project root (for
  // palette.json plus candidates/<stage>/ being created later). Using narrow
  // watchers lets us classify events without re-reading directory listings.
  let framesWatcher: fs.FSWatcher | undefined;
  if (fs.existsSync(framesDir)) {
    framesWatcher = fs.watch(framesDir, { persistent: false }, onFramesEvent);
  }
  for (const stage of KNOWN_STAGES) openCandidateWatcher(stage);

  // Project-root events also tell us when a candidates/<stage>/ directory
  // is created so we can open its watcher lazily. Wrap the existing palette
  // handler rather than spawning a second root watcher.
  const onRoot = (evt: fs.WatchEventType, fileName: string | Buffer | null): void => {
    onProjectEvent(evt, fileName);
    if (closed || fileName == null) return;
    const name = fileName.toString();
    // Either `candidates` or `candidates/<stage>` may surface here depending
    // on platform — try every known stage either way.
    if (name === CANDIDATES_DIR || name.startsWith(`${CANDIDATES_DIR}/`) || name.startsWith(`${CANDIDATES_DIR}\\`)) {
      for (const stage of KNOWN_STAGES) openCandidateWatcher(stage);
    }
  };
  const rootWatcher = fs.watch(projectDir, { persistent: false }, onRoot);

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
      for (const w of candidateWatchers.values()) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      candidateWatchers.clear();
      try {
        rootWatcher.close();
      } catch {
        // ignore
      }
    },
  };
}
