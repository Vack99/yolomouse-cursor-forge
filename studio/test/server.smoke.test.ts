import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProjectStore } from '../src/server/projectStore.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import { createPixelGrid, serializePixelGrid, setPixel } from '../src/lib/pixelGrid.js';

// Smoke check: stand up the real HTTP server against a real temp project, hit
// the API endpoint, and assert the JSON payload round-trips.

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;

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
    server = await startServer({ store, projectName: 'Hello', distDir });

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
    const store = createProjectStore({ repoRoot: tmpRoot });
    server = await startServer({ store, projectName: 'Hello', distDir });

    const res = await fetch(`${server.url}api/projects/Ghost`);
    expect(res.status).toBe(404);
  });

  it('serves /api/active-project with the launched project name', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    server = await startServer({ store, projectName: 'Hello', distDir });

    const res = await fetch(`${server.url}api/active-project`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Hello' });
  });

  it('falls back to index.html for unknown paths (SPA)', async () => {
    writeProject('Hello');
    const store = createProjectStore({ repoRoot: tmpRoot });
    server = await startServer({ store, projectName: 'Hello', distDir });

    const res = await fetch(`${server.url}`);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('<title>studio</title>');
  });
});
