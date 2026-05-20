import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProjectWatcher, type ReloadEvent } from '../src/server/projectWatcher.js';

// projectWatcher is a deep module: given a project directory, it emits
// debounced reload events whenever a frame JSON or palette.json changes on
// disk. The HTTP/WebSocket glue subscribes to these events; the watcher
// itself knows nothing about networking.

let tmpRoot: string;
let watcher: ReturnType<typeof createProjectWatcher> | undefined;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-watch-'));
}

function writeFrame(projectDir: string, name: string, body: string = '{}'): void {
  fs.writeFileSync(path.join(projectDir, 'frames', name), body, 'utf8');
}

function scaffold(name: string): string {
  const projectDir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(projectDir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'palette.json'), '{"version":1,"colors":[]}', 'utf8');
  writeFrame(projectDir, 'frame_00.json', '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[0]]}');
  return projectDir;
}

function waitFor<T>(getter: () => T, predicate: (v: T) => boolean, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = getter();
      if (predicate(value)) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeEach(() => {
  tmpRoot = mkTmp();
});

afterEach(() => {
  if (watcher) {
    watcher.close();
    watcher = undefined;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('projectWatcher', () => {
  it('emits a frame-changed event when a JSON frame is rewritten', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    // Rewrite frame_00.json — should trigger a reload event.
    writeFrame(projectDir, 'frame_00.json', '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[1]]}');

    const got = await waitFor(() => events, (es) => es.length >= 1);
    expect(got[0]).toMatchObject({ kind: 'frame', fileName: 'frame_00.json' });
  });

  it('emits a palette-changed event when palette.json is rewritten', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    fs.writeFileSync(
      path.join(projectDir, 'palette.json'),
      '{"version":1,"colors":[{"index":0,"rgba":"112233FF"}]}',
      'utf8',
    );

    const got = await waitFor(() => events, (es) => es.length >= 1);
    expect(got[0]).toMatchObject({ kind: 'palette' });
  });

  it('emits a frame-changed event when a new JSON frame is added', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    writeFrame(projectDir, 'frame_01.json', '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[0]]}');

    const got = await waitFor(() => events, (es) => es.length >= 1);
    expect(got[0]).toMatchObject({ kind: 'frame', fileName: 'frame_01.json' });
  });

  it('ignores non-JSON files in the frames directory', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    // Drop a stray text file — should NOT produce an event.
    fs.writeFileSync(path.join(projectDir, 'frames', 'notes.txt'), 'hello', 'utf8');
    // Then trigger a real change so we have something to wait on.
    writeFrame(projectDir, 'frame_00.json', '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[2]]}');

    const got = await waitFor(() => events, (es) => es.length >= 1);
    // The .txt file must not have produced an event; the frame change is the only one we see.
    expect(got.every((e) => e.kind !== 'frame' || e.fileName.endsWith('.json'))).toBe(true);
    expect(got[got.length - 1]).toMatchObject({ kind: 'frame', fileName: 'frame_00.json' });
  });

  it('coalesces rapid successive writes into a single event (debounce)', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 60 });
    watcher.onChange((e) => events.push(e));

    // Burst of 5 writes inside the debounce window.
    for (let i = 0; i < 5; i++) {
      writeFrame(
        projectDir,
        'frame_00.json',
        `{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[${i}]]}`,
      );
    }

    // Wait past the debounce window plus a margin, then assert.
    await new Promise((r) => setTimeout(r, 200));
    const frameEvents = events.filter((e) => e.kind === 'frame' && e.fileName === 'frame_00.json');
    expect(frameEvents.length).toBe(1);
  });

  it('emits a candidate-changed event when a JSON file lands under candidates/first/', async () => {
    const projectDir = scaffold('Hello');
    // The candidates/first/ directory does not exist at scaffold time — the
    // watcher must still notice files that appear there later.
    fs.mkdirSync(path.join(projectDir, 'candidates', 'first'), { recursive: true });

    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    fs.writeFileSync(
      path.join(projectDir, 'candidates', 'first', 'candidate_00.json'),
      '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[1]]}',
      'utf8',
    );

    const got = await waitFor(
      () => events,
      (es) => es.some((e) => e.kind === 'candidate'),
    );
    const candidateEvent = got.find((e) => e.kind === 'candidate');
    expect(candidateEvent).toMatchObject({
      kind: 'candidate',
      stage: 'first',
      fileName: 'candidate_00.json',
    });
  });

  it('stops emitting after close()', async () => {
    const projectDir = scaffold('Hello');
    const events: ReloadEvent[] = [];
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    watcher.onChange((e) => events.push(e));

    watcher.close();
    watcher = undefined;

    writeFrame(projectDir, 'frame_00.json', '{"version":1,"width":1,"height":1,"hotspot":{"x":0,"y":0},"pixels":[[9]]}');
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toHaveLength(0);
  });
});
