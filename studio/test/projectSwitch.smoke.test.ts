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

// End-to-end check of the multi-project session feature (issue #10):
//   - Two studio projects exist on disk.
//   - The server is launched with project A active.
//   - A WebSocket client connects.
//   - The client POSTs /api/active-project { name: 'B' } via fetch.
//   - The server emits a 'project' reload event over the same socket.
//   - Writing to project B's frames now triggers a frame reload event.
//   - Writing to project A's frames does NOT (the watcher has rebound).

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;
let bridge: ReloadBridge | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-switch-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-switch-dist-'));
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
  fs.writeFileSync(
    path.join(dir, 'palette.json'),
    JSON.stringify({ version: 1, colors: [{ index: 0, rgba: '00000000' }] }),
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
  event?: { kind: string; fileName?: string; name?: string };
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

describe('project switching (smoke)', () => {
  it('rebinds the file watcher to the new project after POST /api/active-project', async () => {
    const projectA = writeProject('Alpha');
    const projectB = writeProject('Beta');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Alpha',
      createWatcher: (projectDir) => createProjectWatcher({ projectDir, debounceMs: 30 }),
    });
    server = await startServer({ store, session, distDir });
    bridge = createReloadBridge({ server: server.server, watcher: session });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    // Switch to Beta via the public API the picker / forge canvas-select use.
    const switchRes = await fetch(`${server.url}api/active-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Beta' }),
    });
    expect(switchRes.status).toBe(200);

    // Server pushes a 'project' reload event over the same socket.
    const projectEvt = await waitForMessage(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'project',
    );
    expect(projectEvt.event?.name).toBe('Beta');

    // A change in Beta's frames is now seen.
    fs.writeFileSync(
      path.join(projectB, 'frames', 'frame_00.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[2]] }),
      'utf8',
    );
    const betaEvt = await waitForMessage(
      messages,
      (m) =>
        m.type === 'reload' &&
        m.event?.kind === 'frame' &&
        m.event?.fileName === 'frame_00.json',
    );
    expect(betaEvt.event?.fileName).toBe('frame_00.json');

    // A change in Alpha must NOT generate a frame event — the watcher has
    // rebound to Beta. We let the debounce window pass and then assert
    // nothing new arrived.
    const beforeCount = messages.length;
    fs.writeFileSync(
      path.join(projectA, 'frames', 'frame_00.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[9]] }),
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 200));
    const newFrameEvents = messages.slice(beforeCount).filter((m) => m.event?.kind === 'frame');
    expect(newFrameEvents).toEqual([]);

    ws.close();
  });
});
