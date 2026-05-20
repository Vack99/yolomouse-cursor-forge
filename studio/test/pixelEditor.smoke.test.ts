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

// End-to-end smoke for issue #13 — the in-canvas pixel editor.
//
// Models the full path a UI edit takes:
//   1. The editor reducer produces a new grid from a click.
//   2. The frontend PUTs that grid to the server.
//   3. The project store writes it to disk.
//   4. The file watcher emits a 'frame' (or 'candidate') reload event.
//   5. A subsequent GET reflects the edit.
//
// The reducer itself is covered by editReducer.test.ts; the project store
// writers are covered by projectStore.test.ts; the route handlers are
// covered by server.smoke.test.ts. This file ties the four together — if
// any one of them drifts, the round-trip breaks and this test fails.
//
// Also covers acceptance criterion 6: manual edits to a locked frame stick.
// Once a stage is locked, lock-state metadata + the recipe live in
// candidates/<stage>/. An edit to either the frame or the candidate goes
// through PUT and lands on disk verbatim — the lock does not retro-edit.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-editor-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-editor-dist-'));
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
        { index: 2, rgba: '00FF00FF' },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify({
      version: 1,
      width: 2,
      height: 2,
      hotspot: { x: 1, y: 1 },
      pixels: [
        [0, 0],
        [0, 0],
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_00.json'),
    JSON.stringify({
      version: 1,
      width: 2,
      height: 2,
      hotspot: { x: 1, y: 1 },
      pixels: [
        [1, 1],
        [1, 1],
      ],
    }),
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

function waitForMessage(
  messages: IncomingFrame[],
  predicate: (m: IncomingFrame) => boolean,
  timeoutMs = 2000,
): Promise<IncomingFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const hit = messages.find(predicate);
      if (hit) {
        resolve(hit);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`waitForMessage: timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function bootServer(initial: string): Promise<{ wsUrl: string }> {
  const store = createProjectStore({ repoRoot: tmpRoot });
  session = createActiveProjectSession({
    repoRoot: tmpRoot,
    store,
    initial,
    createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
  });
  server = await startServer({ store, session, distDir });
  bridge = createReloadBridge({ server: server.server, watcher: session });
  return { wsUrl: server.url.replace(/^http/, 'ws') + 'ws' };
}

describe('pixel editor (smoke)', () => {
  it('PUT to frames/* persists an edit and broadcasts a frame reload', async () => {
    writeProject('Editor');
    const { wsUrl } = await bootServer('Editor');

    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    // Simulate the editor handing a fully-painted grid to the server.
    const edited = {
      version: 1,
      width: 2,
      height: 2,
      hotspot: { x: 1, y: 1 },
      pixels: [
        [2, 0],
        [0, 2],
      ],
    };
    const put = await fetch(`${server!.url}api/projects/Editor/frames/frame_00.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: edited }),
    });
    expect(put.status).toBe(200);

    // The watcher fires a frame reload — the rest of the SPA refetches.
    await waitForMessage(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'frame' && m.event?.fileName === 'frame_00.json',
    );

    // Disk has the edited grid.
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'projects', 'Editor', 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(raw.pixels).toEqual(edited.pixels);

    // GET shows the edit back to a fresh page-load.
    const get = await fetch(`${server!.url}api/projects/Editor`);
    const body = (await get.json()) as { frames: Array<{ grid: { pixels: number[][] } }> };
    expect(body.frames[0]!.grid.pixels).toEqual(edited.pixels);

    ws.close();
  });

  it('manual edits to a locked candidate stick — lock state never overwrites them', async () => {
    writeProject('Sticky');
    const { wsUrl } = await bootServer('Sticky');

    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    // Lock the only candidate as the canonical first frame.
    const lockRes = await fetch(`${server!.url}api/projects/Sticky/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_00' }),
    });
    expect(lockRes.status).toBe(200);

    // Now make a manual pixel edit to the locked candidate (the file under
    // candidates/first/candidate_00.json that the editor surfaces in the
    // gallery). The lock does NOT re-fire on this edit — there is no
    // recipe-re-derivation step. PRD acceptance criterion 6.
    const handEdit = {
      version: 1,
      width: 2,
      height: 2,
      hotspot: { x: 1, y: 1 },
      pixels: [
        [2, 2],
        [0, 0],
      ],
    };
    const put = await fetch(
      `${server!.url}api/projects/Sticky/candidates/first/candidate_00`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grid: handEdit }),
      },
    );
    expect(put.status).toBe(200);
    await waitForMessage(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'candidate' &&
        m.event?.fileName === 'candidate_00.json',
    );

    // The manual edit is on disk verbatim.
    const candRaw = JSON.parse(
      fs.readFileSync(
        path.join(tmpRoot, 'projects', 'Sticky', 'candidates', 'first', 'candidate_00.json'),
        'utf8',
      ),
    );
    expect(candRaw.pixels).toEqual(handEdit.pixels);

    // GET candidates surfaces the edit + the existing lock marker.
    const candRes = await fetch(`${server!.url}api/projects/Sticky/candidates/first`);
    const candBody = (await candRes.json()) as {
      candidates: Array<{ id: string; grid: { pixels: number[][] } }>;
      lock?: { candidateId: string };
    };
    expect(candBody.candidates[0]!.grid.pixels).toEqual(handEdit.pixels);
    expect(candBody.lock?.candidateId).toBe('candidate_00');

    ws.close();
  });
});
