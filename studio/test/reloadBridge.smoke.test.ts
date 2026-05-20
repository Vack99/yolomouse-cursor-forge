import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket from 'ws';
import { createProjectStore } from '../src/server/projectStore.js';
import { createProjectWatcher, type ProjectWatcher } from '../src/server/projectWatcher.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import { createReloadBridge, type ReloadBridge } from '../src/server/reloadBridge.js';
import { createActiveProjectSession, type ActiveProjectSession } from '../src/server/activeProjectSession.js';

// Smoke check: stand up the real server + watcher + bridge against a real
// temp project, open a real WebSocket from the test, write to disk, and
// assert the client receives a `reload` frame within a second.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let watcher: ProjectWatcher | undefined;
let bridge: ReloadBridge | undefined;
let session: ActiveProjectSession | undefined;

/**
 * The reload bridge smoke tests assert the watcher -> bridge -> WebSocket
 * plumbing end-to-end against the real file system. They predate the
 * activeProjectSession refactor. The server now requires a session, so we
 * build one with a no-op watcher factory — the bridge gets the *real*
 * watcher directly, which is the integration the smoke tests care about.
 */
function buildSession(initial: string): ActiveProjectSession {
  const store = createProjectStore({ repoRoot: tmpRoot });
  return createActiveProjectSession({
    repoRoot: tmpRoot,
    store,
    initial,
    createWatcher: () => ({
      onChange: () => () => {},
      close: () => {},
    }),
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bridge-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>studio</title>', 'utf8');
});

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  watcher?.close();
  watcher = undefined;
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
  fs.writeFileSync(path.join(dir, 'palette.json'), JSON.stringify({ version: 1, colors: [{ index: 0, rgba: '00000000' }] }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'frames', 'frame_00.json'),
    JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[0]] }),
    'utf8',
  );
  return dir;
}

interface IncomingFrame {
  type: string;
  event?: { kind: string; fileName?: string };
}

async function openClient(url: string): Promise<{ ws: WebSocket; messages: IncomingFrame[] }> {
  const ws = new WebSocket(url);
  const messages: IncomingFrame[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as IncomingFrame);
  });
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

describe('reload bridge (smoke)', () => {
  it('pushes a frame-reload event to a connected WebSocket client when a frame file changes', async () => {
    const projectDir = writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = buildSession('Hello');
    server = await startServer({ store, session, distDir });
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    bridge = createReloadBridge({ server: server.server, watcher });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);

    // Expect a 'hello' greeting right after connect.
    await waitForMessage(messages, (m) => m.type === 'hello');
    expect(bridge.clientCount()).toBe(1);

    // Trigger a frame change.
    fs.writeFileSync(
      path.join(projectDir, 'frames', 'frame_00.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[1]] }),
      'utf8',
    );

    const reloadMsg = await waitForMessage(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'frame',
    );
    expect(reloadMsg.event?.fileName).toBe('frame_00.json');

    ws.close();
  });

  it('pushes a palette-reload event when palette.json changes', async () => {
    const projectDir = writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = buildSession('Hello');
    server = await startServer({ store, session, distDir });
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    bridge = createReloadBridge({ server: server.server, watcher });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const { ws, messages } = await openClient(wsUrl);
    await waitForMessage(messages, (m) => m.type === 'hello');

    fs.writeFileSync(
      path.join(projectDir, 'palette.json'),
      JSON.stringify({ version: 1, colors: [{ index: 0, rgba: 'AABBCCDD' }] }),
      'utf8',
    );

    const reloadMsg = await waitForMessage(
      messages,
      (m) => m.type === 'reload' && m.event?.kind === 'palette',
    );
    expect(reloadMsg.event?.kind).toBe('palette');

    ws.close();
  });

  it('broadcasts to multiple connected clients', async () => {
    const projectDir = writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = buildSession('Hello');
    server = await startServer({ store, session, distDir });
    watcher = createProjectWatcher({ projectDir, debounceMs: 30 });
    bridge = createReloadBridge({ server: server.server, watcher });

    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const a = await openClient(wsUrl);
    const b = await openClient(wsUrl);
    await waitForMessage(a.messages, (m) => m.type === 'hello');
    await waitForMessage(b.messages, (m) => m.type === 'hello');
    expect(bridge.clientCount()).toBe(2);

    fs.writeFileSync(
      path.join(projectDir, 'frames', 'frame_00.json'),
      JSON.stringify({ version: 1, width: 1, height: 1, hotspot: { x: 0, y: 0 }, pixels: [[7]] }),
      'utf8',
    );

    await waitForMessage(a.messages, (m) => m.type === 'reload');
    await waitForMessage(b.messages, (m) => m.type === 'reload');

    a.ws.close();
    b.ws.close();
  });
});
