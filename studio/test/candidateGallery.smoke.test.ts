import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket from 'ws';
import { createProjectStore } from '../src/server/projectStore.js';
import { createProjectWatcher } from '../src/server/projectWatcher.js';
import { createActiveProjectSession, type ActiveProjectSession } from '../src/server/activeProjectSession.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import { createReloadBridge, type ReloadBridge } from '../src/server/reloadBridge.js';

// End-to-end check for the candidate-gallery slice (issue #11):
//   - A studio project lives on disk; the candidates/first/ directory
//     starts empty (the "no candidates generated yet" baseline).
//   - The server is launched, a WS client connects.
//   - Two candidate JSON files are written to candidates/first/.
//   - For each, the server pushes a 'candidate' reload event with stage='first'
//     and the right filename — this is the signal the React app uses to
//     refetch and show the new thumbnail.
//   - GET /api/projects/<name>/candidates/first then returns both candidates.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gallery-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gallery-dist-'));
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
  // Pre-create candidates/first/ so the watcher picks it up at construction
  // — exercises the "stage directory already exists" path. The lazy-open
  // path is covered by projectWatcher.test.ts.
  fs.mkdirSync(path.join(dir, 'candidates', 'first'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'palette.json'),
    JSON.stringify({ version: 1, colors: [{ index: 0, rgba: '00000000' }, { index: 1, rgba: 'FF0000FF' }] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[0]] }),
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

describe('candidate gallery (smoke)', () => {
  it('pushes candidate reload events and serves new candidate grids via /api', async () => {
    const projectDir = writeProject('Gallery');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Gallery',
      createWatcher: (dir) => createProjectWatcher({ projectDir: dir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    // Sanity: candidates start empty.
    const empty = await fetch(`${server.url}api/projects/Gallery/candidates/first`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ stage: 'first', candidates: [] });

    // Drop the first candidate — server should push a 'candidate' reload.
    fs.writeFileSync(
      path.join(projectDir, 'candidates', 'first', 'candidate_00.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[1]] }),
      'utf8',
    );
    const evt0 = await waitForMessage(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'candidate' &&
        m.event?.fileName === 'candidate_00.json',
    );
    expect(evt0.event?.stage).toBe('first');

    // Drop a second candidate — same event shape with the new filename.
    fs.writeFileSync(
      path.join(projectDir, 'candidates', 'first', 'candidate_01.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[0]] }),
      'utf8',
    );
    await waitForMessage(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'candidate' &&
        m.event?.fileName === 'candidate_01.json',
    );

    // Both files are now visible via the HTTP endpoint the SPA uses on
    // reload — this is what the gallery sees once it refetches.
    const after = await fetch(`${server.url}api/projects/Gallery/candidates/first`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as {
      stage: string;
      candidates: Array<{ id: string; fileName: string }>;
    };
    expect(body.stage).toBe('first');
    expect(body.candidates.map((c) => c.id)).toEqual(['candidate_00', 'candidate_01']);

    ws.close();
  });
});
