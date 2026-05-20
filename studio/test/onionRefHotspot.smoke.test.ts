import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProjectStore } from '../src/server/projectStore.js';
import { startServer, type StartedServer } from '../src/server/httpServer.js';
import {
  createActiveProjectSession,
  type ActiveProjectSession,
} from '../src/server/activeProjectSession.js';
import type { ProjectWatcher, ReloadListener } from '../src/server/projectWatcher.js';
import {
  createPixelGrid,
  serializePixelGrid,
  setHotspot,
  setPixel,
} from '../src/lib/pixelGrid.js';
import { extractRecipe } from '../src/lib/workflowMachine.js';

// End-to-end smoke check tying the three #16 deliverables together:
//   1. The reference panel sees images listed under projects/<Name>/source/
//      and can fetch their bytes through the HTTP surface.
//   2. The onion-skin overlay has data to draw — the locked candidate grid
//      from a prior stage is fetchable so the canvas can ghost it under
//      the working frame.
//   3. The draggable hotspot crosshair round-trips through the same frames
//      PUT endpoint the pixel editor already uses — the hotspot move is
//      simply a grid write with a new hotspot field.
//
// One real HTTP server, one real temp project; nothing mocked beyond the
// file watcher (we don't want fs.watch noise here — that's covered by
// projectWatcher.test).

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

let tmpRoot: string;
let distDir: string;
let server: StartedServer | undefined;
let session: ActiveProjectSession | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-onion-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-onion-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
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

describe('onion-skin + reference panel + hotspot (smoke)', () => {
  it('serves source images, exposes locked keyframe for onion, and persists a hotspot drag', async () => {
    const projDir = path.join(tmpRoot, 'projects', 'Studio');
    fs.mkdirSync(path.join(projDir, 'frames'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'source'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'candidates', 'first'), { recursive: true });

    const palette = {
      version: 1,
      colors: [
        { index: 0, rgba: '00000000' },
        { index: 1, rgba: 'FF0000FF' },
      ],
    };
    fs.writeFileSync(path.join(projDir, 'palette.json'), JSON.stringify(palette), 'utf8');

    // The frame the editor is working on right now.
    const frame = setPixel(createPixelGrid({ width: 4, height: 4, hotspot: { x: 2, y: 2 } }), 0, 0, 1);
    fs.writeFileSync(
      path.join(projDir, 'frames', 'frame_00.json'),
      JSON.stringify(serializePixelGrid(frame)),
      'utf8',
    );

    // A locked first-stage candidate — this is what the onion-skin overlay
    // ghosts under the current frame in later stages.
    const lockedGrid = setPixel(createPixelGrid({ width: 4, height: 4 }), 3, 3, 1);
    fs.writeFileSync(
      path.join(projDir, 'candidates', 'first', 'candidate_00.json'),
      JSON.stringify(serializePixelGrid(lockedGrid)),
      'utf8',
    );
    const recipe = extractRecipe(lockedGrid);
    fs.writeFileSync(
      path.join(projDir, 'candidates', 'first', 'lock.json'),
      JSON.stringify({ candidateId: 'candidate_00', recipe }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(projDir, 'candidates', 'first', 'recipe.json'),
      JSON.stringify(recipe),
      'utf8',
    );

    // Two reference images for the panel — the byte payload is content the
    // server pipes straight through; nothing decodes it.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(projDir, 'source', 'beta.png'), pngBytes);
    fs.writeFileSync(path.join(projDir, 'source', 'alpha.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const store = createProjectStore({ repoRoot: tmpRoot });
    session = createActiveProjectSession({
      repoRoot: tmpRoot,
      store,
      initial: 'Studio',
      createWatcher: nullWatcherFactory(),
    });
    server = await startServer({ store, session, distDir });

    // 1) Reference panel listing — sorted, both images visible.
    const list = await fetch(`${server.url}api/projects/Studio/source`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ images: ['alpha.jpg', 'beta.png'] });

    // 1b) Reference panel byte fetch — content-type matches extension.
    const pic = await fetch(`${server.url}api/projects/Studio/source/beta.png`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get('content-type')).toBe('image/png');
    const got = Buffer.from(await pic.arrayBuffer());
    expect(got.equals(pngBytes)).toBe(true);

    // 2) Onion-skin data — the candidates endpoint exposes both the grid
    // and the lock marker. The frontend filters lock.id → candidate grid;
    // we replicate that here to confirm the shape is usable.
    const cand = await fetch(`${server.url}api/projects/Studio/candidates/first`);
    expect(cand.status).toBe(200);
    const candBody = (await cand.json()) as {
      lock?: { candidateId: string };
      candidates: Array<{ id: string; grid: { pixels: number[][] } }>;
    };
    expect(candBody.lock?.candidateId).toBe('candidate_00');
    const ghost = candBody.candidates.find((c) => c.id === candBody.lock!.candidateId);
    expect(ghost).toBeDefined();
    expect(ghost!.grid.pixels).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ]);

    // 3) Hotspot drag — the editor sends the same grid back with a new
    // hotspot field. Verify the persisted JSON ends up with the new
    // hotspot and the pixel data survives untouched.
    const moved = setHotspot(frame, { x: 0, y: 0 });
    const put = await fetch(`${server.url}api/projects/Studio/frames/frame_00.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(moved) }),
    });
    expect(put.status).toBe(200);

    const raw = JSON.parse(fs.readFileSync(path.join(projDir, 'frames', 'frame_00.json'), 'utf8'));
    expect(raw.hotspot).toEqual({ x: 0, y: 0 });
    // Pixel at (0,0) was painted before the drag; it is still there.
    expect(raw.pixels[0]![0]).toBe(1);
  });
});
