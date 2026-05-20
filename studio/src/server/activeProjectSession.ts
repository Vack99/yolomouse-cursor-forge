// activeProjectSession — the single source of truth for "which project is
// the studio currently looking at?" plus the lifecycle of the per-project
// file watcher.
//
// Deep module. The whole rest of the studio (HTTP API, WebSocket bridge,
// browser SPA) treats one project as the active one at any given moment;
// this module is the one place that mutable state and its consequences are
// allowed to live. Public contract:
//
//   - getActiveProject() returns the current name.
//   - setActiveProject(name) validates against the store, tears down the old
//     watcher, opens a new one against the new directory, and emits a
//     `{ kind: 'project', name }` event so subscribers (the bridge) can
//     push the switch to connected browsers.
//   - onChange(listener) fans out events from whichever watcher is currently
//     active, so the reload bridge can be constructed once and stay valid
//     across switches.
//   - close() shuts the active watcher down.
//
// The session exposes the same onChange/close shape as ProjectWatcher so the
// existing reloadBridge module accepts it without modification.

import * as path from 'node:path';
import type {
  ProjectWatcher,
  ReloadEvent,
  ReloadListener,
} from './projectWatcher.js';
import type { ProjectStore } from './projectStore.js';

export interface ActiveProjectSession {
  getActiveProject(): string;
  /** Switch to a different project. No-op if `name` is already active. */
  setActiveProject(name: string): void;
  /** Subscribe to reload events from the currently active project. */
  onChange(listener: ReloadListener): () => void;
  close(): void;
}

export type WatcherFactory = (projectDir: string) => ProjectWatcher;

export interface ActiveProjectSessionOptions {
  repoRoot: string;
  /** Used to validate that a requested project exists on disk. */
  store: ProjectStore;
  /** Project name to activate at construction time. */
  initial: string;
  /**
   * Watcher factory — injectable so tests can stub fs.watch out. Production
   * callers pass `createProjectWatcher`-bound-to-options.
   */
  createWatcher: WatcherFactory;
}

export function createActiveProjectSession(
  opts: ActiveProjectSessionOptions,
): ActiveProjectSession {
  const { repoRoot, store, createWatcher } = opts;

  // Validate the initial project the same way a switch would — caller gets a
  // loud error instead of a silently empty session.
  store.readProject(opts.initial);

  const listeners = new Set<ReloadListener>();
  let active = opts.initial;
  let watcher: ProjectWatcher = createWatcher(projectDirFor(active));
  let unsubscribeFromWatcher = subscribe(watcher);
  let closed = false;

  function projectDirFor(name: string): string {
    return path.join(repoRoot, 'projects', name);
  }

  function subscribe(w: ProjectWatcher): () => void {
    return w.onChange((event: ReloadEvent) => {
      if (closed) return;
      fanout(event);
    });
  }

  function fanout(event: ReloadEvent): void {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        // A faulty subscriber must not take the session down.
      }
    }
  }

  return {
    getActiveProject(): string {
      return active;
    },

    setActiveProject(name: string): void {
      if (closed) throw new Error('activeProjectSession: session is closed');
      if (name === active) return;
      // Validate via the store — throws if the project is missing or invalid.
      // Done BEFORE tearing the old watcher down so a bad request doesn't
      // leave us in a half-switched state.
      store.readProject(name);

      unsubscribeFromWatcher();
      watcher.close();

      active = name;
      watcher = createWatcher(projectDirFor(name));
      unsubscribeFromWatcher = subscribe(watcher);

      fanout({ kind: 'project', name });
    },

    onChange(listener: ReloadListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close(): void {
      if (closed) return;
      closed = true;
      unsubscribeFromWatcher();
      watcher.close();
      listeners.clear();
    },
  };
}
