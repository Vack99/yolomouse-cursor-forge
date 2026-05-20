import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProjectStore } from '../src/server/projectStore.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import { createActiveProjectSession, type ActiveProjectSession } from '../src/server/activeProjectSession.js';
import type { ProjectWatcher, ReloadListener } from '../src/server/projectWatcher.js';
import { createPixelGrid, serializePixelGrid, setPixel } from '../src/lib/pixelGrid.js';

// In-test fake watcher — the real one uses fs.watch, which we don't want
// firing under the API smoke tests. The session API is what matters here.
function nullWatcherFactory(): (projectDir: string) => ProjectWatcher {
  return (_projectDir: string): ProjectWatcher => {
    const listeners = new Set<ReloadListener>();
    return {
      onChange(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      close() {
        listeners.clear();
      },
    };
  };
}

function mkSession(repoRoot: string, initial: string): ActiveProjectSession {
  return createActiveProjectSession({
    repoRoot,
    store: createProjectStore({ repoRoot }),
    initial,
    createWatcher: nullWatcherFactory(),
  });
}

// Smoke check: stand up the real HTTP server against a real temp project, hit
// the API endpoint, and assert the JSON payload round-trips.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-server-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dist-'));
  // Minimal index.html so the static fallback works.
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>studio</title>', 'utf8');
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  session?.close();
  session = undefined;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
});

function writeProject(name: string): { grid: ReturnType<typeof createPixelGrid> } {
  const g = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 0, y: 1 } }), 1, 0, 2);
  const palette = { version: 1, colors: [
    { index: 0, rgba: '00000000' },
    { index: 1, rgba: 'FF0000FF' },
    { index: 2, rgba: '00FF00FF' },
  ] };
  const dir = path.join(tmpRoot, 'projects', name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frames', 'frame_00.json'), JSON.stringify(serializePixelGrid(g)), 'utf8');
  fs.writeFileSync(path.join(dir, 'palette.json'), JSON.stringify(palette), 'utf8');
  return { grid: g };
}

describe('http server (smoke)', () => {
  it('serves /api/projects/:name with the on-disk frame and palette', async () => {
    const { grid } = writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Hello`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Hello');
    expect(body.palette.colors).toHaveLength(3);
    expect(body.frames).toHaveLength(1);
    expect(body.frames[0].fileName).toBe('frame_00.json');
    expect(body.frames[0].grid.width).toBe(grid.width);
    expect(body.frames[0].grid.height).toBe(grid.height);
    expect(body.frames[0].grid.hotspot).toEqual(grid.hotspot);
    expect(body.frames[0].grid.pixels).toEqual([
      [0, 2],
      [0, 0],
    ]);
  });

  it('returns 404 for an unknown project', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Ghost`);
    expect(res.status).toBe(404);
  });

  it('serves /api/active-project with the active project name', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/active-project`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Hello' });
  });

  it('falls back to index.html for unknown paths (SPA)', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}`);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('<title>studio</title>');
  });

  it('GET /api/projects lists every studio project on disk', async () => {
    writeProject('Hello');
    writeProject('World');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: ['Hello', 'World'] });
  });

  it('POST /api/active-project switches the session to the requested project', async () => {
    writeProject('Hello');
    writeProject('World');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/active-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'World' }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ name: 'World' });

    // Now the GET endpoint reflects the switch.
    const get = await fetch(`${server.url}api/active-project`);
    expect(await get.json()).toEqual({ name: 'World' });
    expect(session.getActiveProject()).toBe('World');
  });

  it('POST /api/active-project returns 404 for a project that does not exist', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/active-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost' }),
    });
    expect(post.status).toBe(404);
    // Active project is unchanged.
    expect(session.getActiveProject()).toBe('Hello');
  });

  it('GET /api/projects/:name/candidates/first returns every candidate grid', async () => {
    writeProject('Hello');
    // Drop two candidate grids into the first-stage directory.
    const projDir = path.join(tmpRoot, 'projects', 'Hello');
    fs.mkdirSync(path.join(projDir, 'candidates', 'first'), { recursive: true });
    const g0 = serializePixelGrid(createPixelGrid({ width: 1, height: 1 }));
    const g1 = serializePixelGrid(setPixel(createPixelGrid({ width: 1, height: 1 }), 0, 0, 1));
    fs.writeFileSync(path.join(projDir, 'candidates', 'first', 'candidate_00.json'), JSON.stringify(g0), 'utf8');
    fs.writeFileSync(path.join(projDir, 'candidates', 'first', 'candidate_01.json'), JSON.stringify(g1), 'utf8');

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Hello/candidates/first`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe('first');
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].id).toBe('candidate_00');
    expect(body.candidates[0].fileName).toBe('candidate_00.json');
    expect(body.candidates[0].grid.pixels).toEqual([[0]]);
    expect(body.candidates[1].id).toBe('candidate_01');
    expect(body.candidates[1].grid.pixels).toEqual([[1]]);
  });

  it('GET /api/projects/:name/candidates/first returns an empty array when no candidates exist', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Hello/candidates/first`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stage: 'first', candidates: [] });
  });

  it('GET /api/projects/:name/candidates/unknown returns 400 for an unknown stage', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Hello/candidates/middle`);
    expect(res.status).toBe(400);
  });

  it('POST /api/active-project rejects a malformed body', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hello');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/active-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(post.status).toBe(400);
  });

  // Issue #12 — POST /api/projects/:name/lock locks a candidate as the
  // canonical frame for a stage. The corresponding GET endpoint surfaces
  // the lock so the workflow reducer can rehydrate stage state on reload.

  function writeCandidates(name: string, ids: string[]): void {
    const projDir = path.join(tmpRoot, 'projects', name);
    fs.mkdirSync(path.join(projDir, 'candidates', 'first'), { recursive: true });
    for (const id of ids) {
      const g = setPixel(createPixelGrid({ width: 1, height: 1 }), 0, 0, 1);
      fs.writeFileSync(
        path.join(projDir, 'candidates', 'first', `${id}.json`),
        JSON.stringify(serializePixelGrid(g)),
        'utf8',
      );
    }
  }

  it('POST /api/projects/:name/lock freezes the candidate as the canonical frame', async () => {
    writeProject('Lockable');
    writeCandidates('Lockable', ['candidate_00', 'candidate_01']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Lockable');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/projects/Lockable/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_00' }),
    });
    expect(post.status).toBe(200);
    const body = await post.json();
    expect(body.stage).toBe('first');
    expect(body.lock.candidateId).toBe('candidate_00');
    expect(body.lock.recipe.width).toBe(1);
    expect(body.lock.recipe.paletteIndices).toEqual([1]);

    // The frame file was overwritten with the locked candidate's grid.
    const frame = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'projects', 'Lockable', 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(frame.pixels).toEqual([[1]]);
    // Marker + recipe files are on disk.
    expect(
      fs.existsSync(path.join(tmpRoot, 'projects', 'Lockable', 'candidates', 'first', 'lock.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpRoot, 'projects', 'Lockable', 'candidates', 'first', 'recipe.json')),
    ).toBe(true);
  });

  it('GET /api/projects/:name/candidates/first reports the lock once written', async () => {
    writeProject('LockEcho');
    writeCandidates('LockEcho', ['candidate_00']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'LockEcho');
    server = await startServer({ store, session, distDir });

    // Sanity — lock starts unset.
    const before = (await (await fetch(`${server.url}api/projects/LockEcho/candidates/first`)).json()) as {
      lock?: unknown;
    };
    expect(before.lock).toBeUndefined();

    await fetch(`${server.url}api/projects/LockEcho/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_00' }),
    });

    const after = (await (await fetch(`${server.url}api/projects/LockEcho/candidates/first`)).json()) as {
      stage: string;
      lock?: { candidateId: string };
    };
    expect(after.lock?.candidateId).toBe('candidate_00');
  });

  it('POST /api/projects/:name/lock returns 400 when the candidate does not exist', async () => {
    writeProject('NoCand');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'NoCand');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/projects/NoCand/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'ghost' }),
    });
    expect(post.status).toBe(400);
  });

  it('POST /api/projects/:name/lock returns 409 when the stage is already locked', async () => {
    writeProject('Twice');
    writeCandidates('Twice', ['candidate_00', 'candidate_01']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Twice');
    server = await startServer({ store, session, distDir });

    const first = await fetch(`${server.url}api/projects/Twice/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_00' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${server.url}api/projects/Twice/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first', candidateId: 'candidate_01' }),
    });
    expect(second.status).toBe(409);
  });

  it('POST /api/projects/:name/lock rejects a malformed body', async () => {
    writeProject('BadBody');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'BadBody');
    server = await startServer({ store, session, distDir });

    const post = await fetch(`${server.url}api/projects/BadBody/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'first' }),
    });
    expect(post.status).toBe(400);
  });
});
