import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createActiveProjectSession,
  type ActiveProjectSession,
} from '../src/server/activeProjectSession.js';
import type { ProjectWatcher, ReloadEvent, ReloadListener } from '../src/server/projectWatcher.js';
import { createProjectStore } from '../src/server/projectStore.js';
import {
  createPixelGrid,
  serializePixelGrid,
} from '../src/lib/pixelGrid.js';

// activeProjectSession is the deep module that holds the studio's single piece
// of mutable state — which project is currently active — and the lifecycle of
// the per-project file watcher. Switching project closes the old watcher,
// opens one against the new directory, and emits a 'project' reload event so
// the bridge can push it to clients. The session itself exposes the same
// onChange()/close() shape the reload bridge already consumes, so the bridge
// stays watcher-agnostic.

interface FakeWatcher extends ProjectWatcher {
  emit(event: ReloadEvent): void;
  isClosed(): boolean;
  projectDir: string;
}

interface FakeBuilder {
  create: (projectDir: string) => FakeWatcher;
  built: FakeWatcher[];
}

function fakeWatcherBuilder(): FakeBuilder {
  const built: FakeWatcher[] = [];
  const create = (projectDir: string): FakeWatcher => {
    const listeners = new Set<ReloadListener>();
    let closed = false;
    const w: FakeWatcher = {
      projectDir,
      onChange(listener: ReloadListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        closed = true;
        listeners.clear();
      },
      emit(event: ReloadEvent) {
        if (closed) return;
        for (const l of listeners) l(event);
      },
      isClosed: () => closed,
    };
    built.push(w);
    return w;
  };
  return { create, built };
}

let tmpRoot: string;
let session: ActiveProjectSession | undefined;

function blankProject(name: string): void {
  const dir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'palette.json'),
    JSON.stringify({ version: 1, colors: [{ index: 0, rgba: '00000000' }] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify(serializePixelGrid(createPixelGrid({ width: 1, height: 1 }))),
    'utf8',
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-session-'));
});

afterEach(() => {
  session?.close();
  session = undefined;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('activeProjectSession', () => {
  it('exposes the initial active project name', () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    expect(session.getActiveProject()).toBe('Alpha');
  });

  it('opens a watcher against the active project on construction', () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    expect(builder.built).toHaveLength(1);
    expect(builder.built[0]!.projectDir).toBe(path.join(tmpRoot, 'projects', 'Alpha'));
  });

  it('forwards events from the active watcher to onChange listeners', () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    const events: ReloadEvent[] = [];
    session.onChange((e) => events.push(e));
    builder.built[0]!.emit({ kind: 'frame', fileName: 'frame_00.json' });
    expect(events).toEqual([{ kind: 'frame', fileName: 'frame_00.json' }]);
  });

  it('switches active project: closes old watcher, opens new one against new dir', () => {
    blankProject('Alpha');
    blankProject('Beta');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });

    session.setActiveProject('Beta');

    expect(session.getActiveProject()).toBe('Beta');
    expect(builder.built).toHaveLength(2);
    expect(builder.built[0]!.isClosed()).toBe(true);
    expect(builder.built[1]!.projectDir).toBe(path.join(tmpRoot, 'projects', 'Beta'));
    expect(builder.built[1]!.isClosed()).toBe(false);
  });

  it("emits a 'project' reload event when active project changes", () => {
    blankProject('Alpha');
    blankProject('Beta');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    const events: ReloadEvent[] = [];
    session.onChange((e) => events.push(e));

    session.setActiveProject('Beta');

    expect(events).toContainEqual({ kind: 'project', name: 'Beta' });
  });

  it('forwards events from the NEW watcher after a switch, not the old one', () => {
    blankProject('Alpha');
    blankProject('Beta');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    const events: ReloadEvent[] = [];
    session.onChange((e) => events.push(e));

    session.setActiveProject('Beta');
    // Clear the 'project' event so we just see file events.
    const before = events.length;

    builder.built[1]!.emit({ kind: 'frame', fileName: 'frame_00.json' });
    // Old watcher events must NOT leak through — it's closed and unsubscribed.
    // (No-op in our fake, but a sanity check.)
    expect(events.slice(before)).toEqual([{ kind: 'frame', fileName: 'frame_00.json' }]);
  });

  it("rejects switching to a project that does not exist on disk", () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    expect(() => session!.setActiveProject('Ghost')).toThrow(/not found/i);
    // Active project unchanged, no new watcher built.
    expect(session.getActiveProject()).toBe('Alpha');
    expect(builder.built).toHaveLength(1);
    expect(builder.built[0]!.isClosed()).toBe(false);
  });

  it('is a no-op when switching to the project that is already active', () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    const events: ReloadEvent[] = [];
    session.onChange((e) => events.push(e));

    session.setActiveProject('Alpha');

    expect(builder.built).toHaveLength(1);
    expect(builder.built[0]!.isClosed()).toBe(false);
    // No 'project' event for a no-op switch.
    expect(events).toEqual([]);
  });

  it('closes the active watcher when the session itself is closed', () => {
    blankProject('Alpha');
    const store = createProjectStore({ repoRoot: tmpRoot });
    const builder = fakeWatcherBuilder();
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: builder.create,
    });
    session.close();
    session = undefined;
    expect(builder.built[0]!.isClosed()).toBe(true);
  });
});
