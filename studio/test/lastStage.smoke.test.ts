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

// End-to-end check for the last-stage flow (issue #17):
//   - Bootstrap a project where the first AND middle stages are already
//     locked (the prerequisites #17 is blocked by).
//   - GET /api/active-stage reports `last` so Claude knows where the next
//     "generate more" batch lands.
//   - POST /api/projects/<name>/candidates/last appends last-stage
//     candidates; the watcher pushes `candidate` reload events tagged
//     `stage: 'last'`.
//   - GET /api/projects/<name>/candidates/last surfaces them.
//   - POST /api/projects/<name>/lock { stage: 'last', candidateId } locks
//     one of them, writes the lock/recipe markers under candidates/last/,
//     freezes the candidate's grid into frames/frame_last.json, and
//     advances the active stage to `tween-ready` — the post-keyframes
//     sentinel that says "every keyframe is frozen, #18 takes over from
//     here."
//   - Earlier stages (frame_00 + frame_middle + first/middle lock markers)
//     stay untouched — all three keyframes are now frozen.
//   - A second lock attempt on last returns 409 (one-shot per stage).

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-last-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-last-dist-'));
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

/** Scaffolds a project where first + middle are already locked. */
function writeLockedMiddleProject(name: string): string {
  const dir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'candidates', 'first'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'candidates', 'middle'), { recursive: true });
  // Pre-create candidates/last/ so the watcher opens its FSWatcher at
  // construction time. On Windows fs.watch is flaky about newly-created
  // subdirectories — the lazy-open path is covered in projectWatcher.test.ts;
  // this smoke test focuses on the HTTP+lock flow.
  fs.mkdirSync(path.join(dir, 'candidates', 'last'), { recursive: true });
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
  const firstGrid = setPixel(
    createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }),
    0,
    0,
    1,
  );
  const middleGrid = setPixel(
    createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }),
    1,
    0,
    1,
  );
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify(serializePixelGrid(firstGrid)),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_middle.json'),
    JSON.stringify(serializePixelGrid(middleGrid)),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_00.json'),
    JSON.stringify(serializePixelGrid(firstGrid)),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'middle', 'candidate_00.json'),
    JSON.stringify(serializePixelGrid(middleGrid)),
    'utf8',
  );
  const firstRecipe = extractRecipe(firstGrid);
  const middleRecipe = extractRecipe(middleGrid);
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'lock.json'),
    JSON.stringify({ candidateId: 'candidate_00', recipe: firstRecipe }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'recipe.json'),
    JSON.stringify(firstRecipe),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'middle', 'lock.json'),
    JSON.stringify({ candidateId: 'candidate_00', recipe: middleRecipe }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'middle', 'recipe.json'),
    JSON.stringify(middleRecipe),
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

describe('last-stage flow (smoke)', () => {
  it('appends last candidates, locks one, freezes frame_last, and advances active stage to tween-ready', async () => {
    const projectDir = writeLockedMiddleProject('Laster');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Laster',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessages(messages, (m) => m.type === 'hello', 1);

    // Active stage reports `last` now that first + middle are locked.
    // Claude inspects this before authoring last-frame candidates.
    expect(await (await fetch(`${server.url}api/active-stage`)).json()).toEqual({
      project: 'Laster',
      stage: 'last',
    });

    // Generate two last-stage candidates.
    const lastA = setPixel(
      createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }),
      0,
      1,
      1,
    );
    const lastB = setPixel(
      createPixelGrid({ width: 2, height: 2, hotspot: { x: 1, y: 1 } }),
      1,
      1,
      1,
    );
    const post = await fetch(`${server.url}api/projects/Laster/candidates/last`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grids: [serializePixelGrid(lastA), serializePixelGrid(lastB)] }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { stage: string; ids: string[] };
    expect(postBody.stage).toBe('last');
    expect(postBody.ids).toEqual(['candidate_00', 'candidate_01']);

    // Watcher broadcasts a candidate reload per file, tagged stage:'last'.
    const candEvents = await waitForMessages(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'candidate' && m.event?.stage === 'last',
      2,
    );
    expect(new Set(candEvents.map((e) => e.event?.fileName))).toEqual(
      new Set(['candidate_00.json', 'candidate_01.json']),
    );

    // GET candidates/last surfaces them; prior stages remain browsable.
    const lastGet = await fetch(`${server.url}api/projects/Laster/candidates/last`);
    expect(lastGet.status).toBe(200);
    const lastList = (await lastGet.json()) as {
      stage: string;
      candidates: Array<{ id: string }>;
    };
    expect(lastList.candidates.map((c) => c.id)).toEqual(['candidate_00', 'candidate_01']);
    const middleGet = await fetch(`${server.url}api/projects/Laster/candidates/middle`);
    const middleList = (await middleGet.json()) as {
      candidates: Array<{ id: string }>;
      lock?: { candidateId: string };
    };
    expect(middleList.candidates.map((c) => c.id)).toEqual(['candidate_00']);
    expect(middleList.lock?.candidateId).toBe('candidate_00');

    // Lock the second last candidate.
    const lockRes = await fetch(`${server.url}api/projects/Laster/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'last', candidateId: 'candidate_01' }),
    });
    expect(lockRes.status).toBe(200);
    const lockBody = (await lockRes.json()) as {
      stage: string;
      lock: { candidateId: string };
    };
    expect(lockBody.stage).toBe('last');
    expect(lockBody.lock.candidateId).toBe('candidate_01');

    // The watcher saw the writeLock chain — at least the canonical last
    // frame placeholder write is broadcast as a frame reload.
    await waitForMessages(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'frame' &&
        m.event?.fileName === 'frame_last.json',
      1,
    );

    // Filesystem invariants:
    //   - candidates/last/lock.json points at the locked candidate.
    //   - candidates/last/recipe.json exists.
    //   - frames/frame_last.json carries the locked candidate's pixels.
    //   - frames/frame_00.json + frames/frame_middle.json + earlier lock
    //     markers are untouched.
    const lastLock = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'candidates', 'last', 'lock.json'), 'utf8'),
    );
    expect(lastLock.candidateId).toBe('candidate_01');
    expect(
      fs.existsSync(path.join(projectDir, 'candidates', 'last', 'recipe.json')),
    ).toBe(true);
    const lastFrame = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_last.json'), 'utf8'),
    );
    expect(lastFrame.pixels).toEqual([
      [0, 0],
      [0, 1],
    ]);
    const firstFrame = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(firstFrame.pixels).toEqual([
      [1, 0],
      [0, 0],
    ]);
    const middleFrame = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'frames', 'frame_middle.json'), 'utf8'),
    );
    expect(middleFrame.pixels).toEqual([
      [0, 1],
      [0, 0],
    ]);

    // Active stage advanced to tween-ready — every keyframe is now frozen
    // and the candidate-gallery loop has exited. #18's tween step picks up
    // from this signal.
    expect(await (await fetch(`${server.url}api/active-stage`)).json()).toEqual({
      project: 'Laster',
      stage: 'tween-ready',
    });

    // Re-locking last is rejected (one-shot per stage).
    const relock = await fetch(`${server.url}api/projects/Laster/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'last', candidateId: 'candidate_00' }),
    });
    expect(relock.status).toBe(409);

    ws.close();
  });
});
