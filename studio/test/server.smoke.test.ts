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

    // `last` is the stage not yet wired through the HTTP surface (#17). Once
    // that lands this test moves to a synthetic unknown stage instead.
    const res = await fetch(`${server.url}api/projects/Hello/candidates/last`);
    expect(res.status).toBe(400);
  });

  it('GET /api/projects/:name/candidates/middle returns the middle-stage candidates', async () => {
    // Middle-stage candidates land in candidates/middle/ (issue #15). The
    // endpoint accepts the stage the same way it accepts first; the project
    // store decides what to read.
    writeProject('MidGet');
    const projDir = path.join(tmpRoot, 'projects', 'MidGet');
    fs.mkdirSync(path.join(projDir, 'candidates', 'middle'), { recursive: true });
    const g = setPixel(createPixelGrid({ width: 1, height: 1 }), 0, 0, 1);
    fs.writeFileSync(
      path.join(projDir, 'candidates', 'middle', 'candidate_00.json'),
      JSON.stringify(serializePixelGrid(g)),
      'utf8',
    );
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'MidGet');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/MidGet/candidates/middle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string; candidates: Array<{ id: string }> };
    expect(body.stage).toBe('middle');
    expect(body.candidates.map((c) => c.id)).toEqual(['candidate_00']);
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

  // Issue #13 — PUT endpoints persist pixel-editor edits back to disk.
  // Body shape mirrors the GET payload so the frontend can round-trip
  // grid → edit → grid through the same parser.

  it('PUT /api/projects/:name/frames/:fileName overwrites the frame on disk', async () => {
    writeProject('Editable');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Editable');
    server = await startServer({ store, session, distDir });

    const edited = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 0, y: 1 } }), 0, 1, 1);
    const put = await fetch(`${server.url}api/projects/Editable/frames/frame_00.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(edited) }),
    });
    expect(put.status).toBe(200);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'projects', 'Editable', 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(raw).toEqual(serializePixelGrid(edited));
  });

  it('PUT /api/projects/:name/frames/:fileName rejects a non-frame filename', async () => {
    writeProject('Editable');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Editable');
    server = await startServer({ store, session, distDir });

    const g = createPixelGrid({ width: 1, height: 1 });
    const put = await fetch(`${server.url}api/projects/Editable/frames/notes.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(g) }),
    });
    expect(put.status).toBe(400);
  });

  it('PUT /api/projects/:name/frames/:fileName rejects a malformed grid body', async () => {
    writeProject('Editable');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Editable');
    server = await startServer({ store, session, distDir });

    const put = await fetch(`${server.url}api/projects/Editable/frames/frame_00.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: { width: 'not a number' } }),
    });
    expect(put.status).toBe(400);
  });

  it('PUT /api/projects/:name/candidates/:stage/:id overwrites the candidate on disk', async () => {
    writeProject('CandEdit');
    writeCandidates('CandEdit', ['candidate_00']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'CandEdit');
    server = await startServer({ store, session, distDir });

    const edited = setPixel(createPixelGrid({ width: 1, height: 1 }), 0, 0, 2);
    const put = await fetch(`${server.url}api/projects/CandEdit/candidates/first/candidate_00`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(edited) }),
    });
    expect(put.status).toBe(200);

    const raw = JSON.parse(
      fs.readFileSync(
        path.join(tmpRoot, 'projects', 'CandEdit', 'candidates', 'first', 'candidate_00.json'),
        'utf8',
      ),
    );
    expect(raw.pixels).toEqual([[2]]);
  });

  it('PUT /api/projects/:name/candidates/:stage/:id rejects an unknown stage', async () => {
    writeProject('CandStage');
    writeCandidates('CandStage', ['candidate_00']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'CandStage');
    server = await startServer({ store, session, distDir });

    const g = createPixelGrid({ width: 1, height: 1 });
    // `last` is the not-yet-wired stage at this point in the workflow (#17).
    const put = await fetch(`${server.url}api/projects/CandStage/candidates/last/candidate_00`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(g) }),
    });
    expect(put.status).toBe(400);
  });

  it('PUT /api/projects/:name/candidates/:stage/:id rejects the reserved lock / recipe ids', async () => {
    writeProject('Reserved');
    writeCandidates('Reserved', ['candidate_00']);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Reserved');
    server = await startServer({ store, session, distDir });

    const g = createPixelGrid({ width: 1, height: 1 });
    const put = await fetch(`${server.url}api/projects/Reserved/candidates/first/lock`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(g) }),
    });
    expect(put.status).toBe(400);
  });

  // Reference panel — issue #16.
  //
  // The panel needs (a) a listing endpoint so the frontend can enumerate
  // what to render, and (b) a static-bytes endpoint so the browser can
  // <img src> each image. Both delegate to projectStore so the route is
  // pure URL routing + content-type negotiation.

  it('GET /api/projects/:name/source lists every reference image in source/', async () => {
    writeProject('Refs');
    const sourceDir = path.join(tmpRoot, 'projects', 'Refs', 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'beta.png'), 'png-bytes', 'utf8');
    fs.writeFileSync(path.join(sourceDir, 'alpha.jpg'), 'jpg-bytes', 'utf8');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Refs');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/Refs/source`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: string[] };
    expect(body.images).toEqual(['alpha.jpg', 'beta.png']);
  });

  it('GET /api/projects/:name/source returns an empty list when source/ is absent', async () => {
    writeProject('NoRefs');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'NoRefs');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/NoRefs/source`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ images: [] });
  });

  it('GET /api/projects/:name/source/:fileName streams the image bytes with a content-type header', async () => {
    writeProject('RefBytes');
    const sourceDir = path.join(tmpRoot, 'projects', 'RefBytes', 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    // A handful of bytes is enough — the route just pipes whatever fs reads.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(sourceDir, 'pic.png'), png);
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'RefBytes');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/RefBytes/source/pic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(png)).toBe(true);
  });

  it('GET /api/projects/:name/source/:fileName rejects path-traversal', async () => {
    writeProject('RefTraversal');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'RefTraversal');
    server = await startServer({ store, session, distDir });

    // `..%2F` would otherwise climb out of source/; the routing must refuse.
    const res = await fetch(`${server.url}api/projects/RefTraversal/source/${encodeURIComponent('../escape.png')}`);
    expect(res.status).toBe(400);
  });

  it('GET /api/projects/:name/source/:fileName 404s for an unknown image', async () => {
    writeProject('RefMissing');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'RefMissing');
    server = await startServer({ store, session, distDir });

    const res = await fetch(`${server.url}api/projects/RefMissing/source/missing.png`);
    expect(res.status).toBe(404);
  });

  // Hotspot persistence — issue #16.
  //
  // Dragging the crosshair updates the hotspot only; the pixel data does
  // not change. The frame and candidate PUT routes already accept a full
  // grid payload, so the simplest write path is to send the same grid back
  // with a new hotspot. This smoke check exercises that round-trip end to
  // end so we know the JSON serialised by setHotspot survives parsePixelGrid
  // on the way in and stays put on disk.

  it('PUT /api/projects/:name/frames/:fileName persists a hotspot change', async () => {
    writeProject('Hotspot');
    const store = createProjectStore({ repoRoot: tmpRoot });
    session = mkSession(tmpRoot, 'Hotspot');
    server = await startServer({ store, session, distDir });

    const original = setPixel(createPixelGrid({ width: 2, height: 2, hotspot: { x: 0, y: 1 } }), 1, 0, 2);
    const moved = { ...serializePixelGrid(original), hotspot: { x: 1, y: 1 } };
    const put = await fetch(`${server.url}api/projects/Hotspot/frames/frame_00.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: moved }),
    });
    expect(put.status).toBe(200);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'projects', 'Hotspot', 'frames', 'frame_00.json'), 'utf8'),
    );
    expect(raw.hotspot).toEqual({ x: 1, y: 1 });
    // Pixel data was preserved on the wire — the editor sends the whole grid
    // so the hotspot move never silently wipes art.
    expect(raw.pixels).toEqual([
      [0, 2],
      [0, 0],
    ]);
  });
});
