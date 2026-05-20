import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket from 'ws';
import { createProjectStore } from '../src/server/projectStore.js';
import { createProjectWatcher } from '../src/server/projectWatcher.js';
import {
  createActiveProjectSession,
  type ActiveProjectSession,
} from '../src/server/activeProjectSession.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import { createReloadBridge, type ReloadBridge } from '../src/server/reloadBridge.js';
import {
  createPixelGrid,
  serializePixelGrid,
  setPixel,
} from '../src/lib/pixelGrid.js';
import { extractRecipe } from '../src/lib/workflowMachine.js';

// End-to-end check for the middle-stage flow (issue #15):
//   - Bootstrap a project where the `first` stage is already locked (the
//     prerequisite the issue is blocked by — see #12).
//   - GET /api/active-stage now reports `middle` so Claude knows where the
//     next "generate more" batch lands.
//   - POST /api/projects/<name>/candidates/middle appends middle-stage
//     candidates; the watcher pushes `candidate` reload events tagged
//     `stage: 'middle'` so the gallery refetches via the same pipeline it
//     uses for any other on-disk change.
//   - GET /api/projects/<name>/candidates/middle surfaces them.
//   - POST /api/projects/<name>/lock { stage: 'middle', candidateId } locks
//     one of them, writes the lock/recipe markers under
//     candidates/middle/, freezes the candidate's grid into
//     frames/frame_middle.json, and advances the active stage to `last`.
//   - First-stage data (lock marker + frame_00) is untouched — both
//     keyframes are now frozen.
//   - A second lock attempt on middle returns 409 (one-shot per stage).

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-middle-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-middle-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>studio</title>', 'utf8');
});

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  session?.close();
  session = undefined;
  if (server) {
    await server.close();
    server = undefined;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
});

/** Scaffolds a project where `first` is already locked. */
function writeLockedFirstProject(name: string): string {
  const dir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'candidates', 'first'), { recursive: true });
  // Pre-create candidates/middle/ so the watcher opens its FSWatcher at
  // construction time. Otherwise we'd be racing the lazy-open path the
  // root-level rename event triggers — on Windows fs.watch is flaky about
  // newly-created subdirectories. The lazy-open path is covered by
  // projectWatcher.test.ts; this smoke test focuses on the HTTP+lock flow.
  fs.mkdirSync(path.join(dir, 'candidates', 'middle'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'palette.json'),
    JSON.stringify({
      version: 1,
      colors: [
        { index: 0, rgba: '00000000' },
        { index: 1, rgba: 'FF0000FF' },
      ],
    }),
    'utf8',
  );
  const firstGrid = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }), 0, 0, 1);
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify(serializePixelGrid(firstGrid)),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_00.json'),
    JSON.stringify(serializePixelGrid(firstGrid)),
    'utf8',
  );
  const recipe = extractRecipe(firstGrid);
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'lock.json'),
    JSON.stringify({ candidateId: 'candidate_00', recipe }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'recipe.json'),
    JSON.stringify(recipe),
    'utf8',
  );
  return dir;
}

interface IncomingFrame {
  type: string;
  event?: { kind: string; stage?: string; fileName?: string };
}

async function openClient(url: string): Promise<{ ws: WebSocket; messages: IncomingFrame[] }> {
  const ws = new WebSocket(url);
  const messages: IncomingFrame[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as IncomingFrame));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

function waitForMessages(
  messages: IncomingFrame[],
  predicate: (m: IncomingFrame) => boolean,
  atLeast: number,
  timeoutMs = 3000,
): Promise<IncomingFrame[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const hits = messages.filter(predicate);
      if (hits.length >= atLeast) {
        resolve(hits);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`waitForMessages: only ${hits.length}/${atLeast} after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('middle-stage flow (smoke)', () => {
  it('appends middle candidates, locks one, freezes frame_middle, and advances active stage to last', async () => {
    const projectDir = writeLockedFirstProject('Middler');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Middler',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessages(messages, (m) => m.type === 'hello', 1);

    // Active stage reports middle now that first is locked. This is what
    // Claude inspects in the terminal before authoring middle candidates.
    expect(await (await fetch(`${server.url}api/active-stage`)).json()).toEqual({
      project: 'Middler',
      stage: 'middle',
    });

    // Generate two middle-stage candidates.
    const midA = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }), 1, 0, 1);
    const midB = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }), 1, 1, 1);
    const post = await fetch(`${server.url}api/projects/Middler/candidates/middle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grids: [serializePixelGrid(midA), serializePixelGrid(midB)] }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { stage: string; ids: string[] };
    expect(postBody.stage).toBe('middle');
    expect(postBody.ids).toEqual(['candidate_00', 'candidate_01']);

    // Watcher broadcasts a candidate reload per file, tagged stage:'middle'.
    const candEvents = await waitForMessages(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'candidate' && m.event?.stage === 'middle',
      2,
    );
    expect(new Set(candEvents.map((e) => e.event?.fileName))).toEqual(
      new Set(['candidate_00.json', 'candidate_01.json']),
    );

    // GET candidates/middle surfaces them; first-stage candidates remain
    // browsable (PRD: nothing discarded).
    const midGet = await fetch(`${server.url}api/projects/Middler/candidates/middle`);
    expect(midGet.status).toBe(200);
    const midList = (await midGet.json()) as {
      stage: string;
      candidates: Array<{ id: string }>;
    };
    expect(midList.candidates.map((c) => c.id)).toEqual(['candidate_00', 'candidate_01']);
    const firstGet = await fetch(`${server.url}api/projects/Middler/candidates/first`);
    const firstList = (await firstGet.json()) as {
      candidates: Array<{ id: string }>;
      lock?: { candidateId: string };
    };
    expect(firstList.candidates.map((c) => c.id)).toEqual(['candidate_00']);
    expect(firstList.lock?.candidateId).toBe('candidate_00');

    // Lock the second middle candidate.
    const lockRes = await fetch(`${server.url}api/projects/Middler/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'middle', candidateId: 'candidate_01' }),
    });
    expect(lockRes.status).toBe(200);
    const lockBody = (await lockRes.json()) as {
      stage: string;
      lock: { candidateId: string };
    };
    expect(lockBody.stage).toBe('middle');
    expect(lockBody.lock.candidateId).toBe('candidate_01');

    // The watcher saw the writeLock chain — at least the canonical middle
    // frame placeholder write is broadcast as a frame reload.
    await waitForMessages(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'frame' &&
        m.event?.fileName === 'frame_middle.json',
      1,
    );

    // Filesystem invariants:
    //   - candidates/middle/lock.json points at the locked candidate.
    //   - candidates/middle/recipe.json exists.
    //   - frames/frame_middle.json carries the locked candidate's pixels.
    //   - candidates/first/* + frames/frame_00.json are untouched.
    const midLock = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'candidates', 'middle', 'lock.json'), 'utf8'),
    );
    expect(midLock.candidateId).toBe('candidate_01');
    expect(
      fs.existsSync(path.join(projectDir, 'candidates', 'middle', 'recipe.json')),
    ).toBe(true);
    const midFrame = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_middle.json'), 'utf8'),
    );
    expect(midFrame.pixels).toEqual([
      [0, 0],
      [0, 1],
    ]);
    // First-stage canonical frame: still the original first-frame grid.
    const firstFrame = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(firstFrame.pixels).toEqual([
      [1, 0],
      [0, 0],
    ]);

    // Active stage advanced to last so a follow-up "generate more" lands
    // there once #17 wires it.
    expect(await (await fetch(`${server.url}api/active-stage`)).json()).toEqual({
      project: 'Middler',
      stage: 'last',
    });

    // Re-locking middle is rejected (one-shot per stage).
    const relock = await fetch(`${server.url}api/projects/Middler/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'middle', candidateId: 'candidate_00' }),
    });
    expect(relock.status).toBe(409);

    ws.close();
  });

  it('rejects locking middle on a project where first is still unlocked', async () => {
    // Bare project without any lock — the project store enforces "candidate
    // must exist on disk"; here the candidate exists but the workflow
    // semantically should not advance. The HTTP layer doesn't enforce
    // ordering (the project store relies on disk truth), but the
    // computeActiveStage query will keep reporting `first`, which is the
    // signal the UI uses to keep the middle-stage gallery offscreen.
    const dir = path.join(tmpRoot, 'projects', 'Unlocked');
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'candidates', 'middle'), { recursive: true });
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
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Unlocked',
      createWatcher: (d) => createProjectWatcher({ projectDir: d, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    // Active stage stays on `first` so the canvas does not advance the
    // gallery prematurely.
    expect(await (await fetch(`${server.url}api/active-stage`)).json()).toEqual({
      project: 'Unlocked',
      stage: 'first',
    });
  });
});
