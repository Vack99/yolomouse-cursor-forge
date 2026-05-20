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

// End-to-end smoke check for the S5 lock flow (issue #12):
//   - A studio project with two first-stage candidates lives on disk.
//   - POST /api/projects/<name>/lock { stage: 'first', candidateId } picks
//     one as the canonical first frame.
//   - The watcher fires reload events for lock.json + recipe.json +
//     frames/frame_00.json (the three writes writeLock performs).
//   - The subsequent GET /api/projects/<name>/candidates/first surfaces the
//     lock marker so the SPA's workflow reducer can rehydrate.
//   - A second POST returns 409 — locking is one-shot.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lock-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lock-dist-'));
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
  // Placeholder frame_00 — writeLock will overwrite it with the locked grid.
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify({ version: 1, width: 2, height: 2, hotspot: { x: 1, y: 1 }, pixels: [[0, 0], [0, 0]] }),
    'utf8',
  );
  // Two candidates; the second uses palette index 1 so we can prove the
  // canonical frame really did get rewritten to that candidate's pixels.
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_00.json'),
    JSON.stringify({ version: 1, width: 2, height: 2, hotspot: { x: 1, y: 1 }, pixels: [[0, 0], [0, 0]] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'candidates', 'first', 'candidate_01.json'),
    JSON.stringify({ version: 1, width: 2, height: 2, hotspot: { x: 1, y: 1 }, pixels: [[1, 1], [1, 1]] }),
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

describe('lock first frame (smoke)', () => {
  it('locks a candidate, persists markers, broadcasts reload, and refuses a re-lock', async () => {
    const projectDir = writeProject('Locker');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Locker',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    // Lock candidate_01.
    const post = await fetch(`${server.url}api/projects/Locker/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_01' }),
    });
    expect(post.status).toBe(200);
    const body = (await post.json()) as { stage: string; lock: { candidateId: string } };
    expect(body.lock.candidateId).toBe('candidate_01');

    // The watcher saw the three writes — at least the canonical frame
    // update is visible to the SPA as a frame reload.
    await waitForMessage(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'frame' && m.event?.fileName === 'frame_00.json',
    );

    // The lock + recipe markers exist on disk in the candidates/<stage>/
    // directory; the canonical frame matches candidate_01's pixels.
    const lockOnDisk = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'candidates', 'first', 'lock.json'), 'utf8'),
    );
    expect(lockOnDisk.candidateId).toBe('candidate_01');
    expect(
      fs.existsSync(path.join(projectDir, 'candidates', 'first', 'recipe.json')),
    ).toBe(true);
    const frame = JSON.parse(fs.readFileSync(path.join(projectDir, 'frames', 'frame_00.json'), 'utf8'));
    expect(frame.pixels).toEqual([
      [1, 1],
      [1, 1],
    ]);

    // GET candidates now reports the lock so a fresh page-load round-trip
    // gives the React reducer enough to rehydrate the locked stage.
    const candRes = await fetch(`${server.url}api/projects/Locker/candidates/first`);
    expect(candRes.status).toBe(200);
    const candBody = (await candRes.json()) as {
      candidates: Array<{ id: string }>;
      lock?: { candidateId: string };
    };
    expect(candBody.candidates.map((c) => c.id)).toEqual(['candidate_00', 'candidate_01']);
    expect(candBody.lock?.candidateId).toBe('candidate_01');

    // A second lock attempt is rejected by the store (already locked).
    const repeat = await fetch(`${server.url}api/projects/Locker/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_00' }),
    });
    expect(repeat.status).toBe(409);

    ws.close();
  });
});
