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
import { createPixelGrid, serializePixelGrid, setPixel } from '../src/lib/pixelGrid.js';

// End-to-end smoke check for the "generate 4 more" command surface (#14).
//
// What we are exercising:
//   - GET /api/active-stage returns { project, stage } so Claude in the
//     terminal can ask "where would the next batch of candidates land?".
//   - POST /api/projects/<name>/candidates/<stage> { grids: [...] } appends
//     N new candidates without overwriting any existing one, returns the
//     allocated ids, and triggers a 'candidate' reload per file so the
//     gallery refetches the same way it does for any other on-disk change.
//   - A second POST keeps appending — no cap, no collision.
//   - The active-stage query advances to 'middle' once 'first' is locked,
//     so a follow-up "generate more" call could target the right stage.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen4-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen4-dist-'));
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

function writeProject(name: string): string {
  const dir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'candidates', 'first'), { recursive: true });
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
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify({ version: 1, width: 2, height: 2, hotspot: { x: 1, y: 1 }, pixels: [[0, 0], [0, 0]] }),
    'utf8',
  );
  // One pre-existing candidate so the next batch must start at _01.
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_00.json'),
    JSON.stringify({ version: 1, width: 2, height: 2, hotspot: { x: 1, y: 1 }, pixels: [[0, 0], [0, 0]] }),
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

describe('generate 4 more (smoke)', () => {
  it('queries active stage, appends 4 candidates without replacing existing, and broadcasts reloads', async () => {
    const projectDir = writeProject('More');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'More',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);

    // Active stage query — Claude reads this before authoring more.
    const stageRes = await fetch(`${server.url}api/active-stage`);
    expect(stageRes.status).toBe(200);
    expect(await stageRes.json()).toEqual({ project: 'More', stage: 'first' });

    // Build four candidate grids to drop. Each one paints a different
    // pixel so the test can prove every grid actually round-tripped to
    // its own file.
    const grids = [
      setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 0, 1),
      setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 0, 1),
      setPixel(createPixelGrid({ width: 2, height: 2 }), 0, 1, 1),
      setPixel(createPixelGrid({ width: 2, height: 2 }), 1, 1, 1),
    ].map((g) => serializePixelGrid(g));

    const post = await fetch(`${server.url}api/projects/More/candidates/first`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grids }),
    });
    expect(post.status).toBe(200);
    const body = (await post.json()) as { stage: string; ids: string[] };
    expect(body.stage).toBe('first');
    expect(body.ids).toEqual([
      'candidate_01',
      'candidate_02',
      'candidate_03',
      'candidate_04',
    ]);

    // Watcher pushed one reload event per appended candidate.
    const evts = await waitForMessages(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'candidate' && m.event?.stage === 'first',
      4,
    );
    expect(new Set(evts.map((e) => e.event?.fileName))).toEqual(
      new Set([
        'candidate_01.json',
        'candidate_02.json',
        'candidate_03.json',
        'candidate_04.json',
      ]),
    );

    // The pre-existing candidate is still on disk (acceptance: "none replaced").
    expect(
      fs.existsSync(path.join(projectDir, 'candidates', 'first', 'candidate_00.json')),
    ).toBe(true);

    // GET candidates now lists all five.
    const list = await fetch(`${server.url}api/projects/More/candidates/first`);
    const listBody = (await list.json()) as { candidates: Array<{ id: string }> };
    expect(listBody.candidates.map((c) => c.id)).toEqual([
      'candidate_00',
      'candidate_01',
      'candidate_02',
      'candidate_03',
      'candidate_04',
    ]);

    // A second batch keeps appending — no upper cap.
    const post2 = await fetch(`${server.url}api/projects/More/candidates/first`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grids: [serializePixelGrid(createPixelGrid({ width: 2, height: 2 }))],
      }),
    });
    expect(post2.status).toBe(200);
    expect((await post2.json()).ids).toEqual(['candidate_05']);

    ws.close();
  });

  it('rejects unknown stage, malformed body, and missing grids', async () => {
    writeProject('Bad');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Bad',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    // Unknown stage (the only wired one today is 'first').
    const stage = await fetch(`${server.url}api/projects/Bad/candidates/last`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grids: [] }),
    });
    expect(stage.status).toBe(400);

    // Body without `grids`.
    const noGrids = await fetch(`${server.url}api/projects/Bad/candidates/first`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noGrids.status).toBe(400);

    // Empty grids array.
    const empty = await fetch(`${server.url}api/projects/Bad/candidates/first`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grids: [] }),
    });
    expect(empty.status).toBe(400);
  });

  it('reports the active stage as middle once the first stage is locked', async () => {
    const dir = writeProject('Advanced');
    // Pre-create a lock so the active stage has already advanced when the
    // server boots. computeActiveStage is pure; this is the easiest setup.
    fs.writeFileSync(
      path.join(dir, 'candidates', 'first', 'lock.json'),
      JSON.stringify({ candidateId: 'candidate_00', recipe: {} }),
      'utf8',
    );

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Advanced',
      createWatcher: (d) => createProjectWatcher({ projectDir: d, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const stageRes = await fetch(`${server.url}api/active-stage`);
    expect(stageRes.status).toBe(200);
    expect(await stageRes.json()).toEqual({ project: 'Advanced', stage: 'middle' });
  });
});
