// HTTP server — serves the built Vite bundle and a handful of API routes.
// Glue module: no business logic lives here. Project reads delegate to
// projectStore; active-project changes delegate to activeProjectSession.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectStore } from './projectStore.js';
import type { ActiveProjectSession } from './activeProjectSession.js';
import { extractRecipe } from '../lib/workflowMachine.js';
import type { Stage } from '../lib/workflowMachine.js';
import { parsePixelGrid } from '../lib/pixelGrid.js';

/**
 * Workflow stages currently exposed through the HTTP surface. The reducer
 * and filesystem layer know about every stage in `STAGES`; this set tracks
 * which stages the UI has wired through the API at the present commit. New
 * stages join here when their slice lands (`last` arrives with #17).
 */
const WIRED_STAGES = new Set<Stage>(['first', 'middle']);

function asWiredStage(s: string): Stage | undefined {
  return WIRED_STAGES.has(s as Stage) ? (s as Stage) : undefined;
}

export interface ServerOptions {
  store: ProjectStore;
  /** Holds the currently active project; mutated by POST /api/active-project. */
  session: ActiveProjectSession;
  /** Directory containing the built Vite assets (index.html + assets/). */
  distDir: string;
  port?: number;
  /** Bind address — default 127.0.0.1 (localhost-only by design). */
  host?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Reference-image extensions served by /api/projects/:name/source/:file.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function sendStatic(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'content-type': mime, 'content-length': data.length });
  res.end(data);
}

/** Read an entire request body up to a cap; reject if oversized. */
function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(opts: ServerOptions): http.RequestListener {
  const { store, session, distDir } = opts;

  return (req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        // GET /api/projects -> { projects: [name, ...] }
        if (pathname === '/api/projects' && req.method === 'GET') {
          sendJson(res, 200, { projects: store.listProjects() });
          return;
        }

        // GET /api/active-stage -> { project, stage }
        // The "where would the next 'generate 4 more' batch land?" query
        // (#14). Stage is derived purely from disk so the answer is the
        // same whether the caller is the canvas, forge.ps1, or Claude.
        if (pathname === '/api/active-stage' && req.method === 'GET') {
          try {
            const project = session.getActiveProject();
            const stage = store.computeActiveStage(project);
            sendJson(res, 200, { project, stage });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendError(res, 500, msg);
          }
          return;
        }

        // POST /api/projects/:name/candidates/:stage { grids: [...] } -> { stage, ids }
        // The "generate N more" command surface (#14). The body carries one
        // or more pixel-grid payloads (same shape parsePixelGrid accepts);
        // the server allocates fresh sequential candidate ids that do not
        // collide with anything on disk and writes each grid. Returns the
        // assigned ids in order so callers know which file they got. The
        // file watcher emits one 'candidate' reload event per write so the
        // gallery refreshes via the same path it uses for any other change.
        const candAppendMatch = /^\/api\/projects\/([^/]+)\/candidates\/([^/]+)$/.exec(pathname);
        if (candAppendMatch && req.method === 'POST') {
          const requested = decodeURIComponent(candAppendMatch[1]!);
          const stageStr = decodeURIComponent(candAppendMatch[2]!);
          const stage = asWiredStage(stageStr);
          if (stage === undefined) {
            sendError(res, 400, `unknown stage '${stageStr}'`);
            return;
          }
          let body: { grids?: unknown };
          try {
            // Allow larger bodies — four 64×64 grids serialised JSON adds up.
            const raw = await readBody(req, 4 * 1024 * 1024);
            body = JSON.parse(raw) as { grids?: unknown };
          } catch {
            sendError(res, 400, 'body must be valid JSON');
            return;
          }
          if (!Array.isArray(body.grids)) {
            sendError(res, 400, "body must include a 'grids' array");
            return;
          }
          if (body.grids.length === 0) {
            sendError(res, 400, "body.grids must contain at least one grid");
            return;
          }
          try {
            const grids = body.grids.map((g) => parsePixelGrid(g));
            const ids = store.appendCandidates(requested, stage, grids);
            sendJson(res, 200, { stage, ids });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // GET /api/projects/:name/candidates/:stage -> { stage, candidates, lock? }
        // Returns every candidate grid for the requested workflow stage of
        // the named project, plus the lock marker when the stage has been
        // locked. Matches before the bare /api/projects/:name route so the
        // longer path wins on the regex order.
        const candMatch = /^\/api\/projects\/([^/]+)\/candidates\/([^/]+)$/.exec(pathname);
        if (candMatch && req.method === 'GET') {
          const requested = decodeURIComponent(candMatch[1]!);
          const stageStr = decodeURIComponent(candMatch[2]!);
          const stage = asWiredStage(stageStr);
          if (stage === undefined) {
            // `last` joins WIRED_STAGES with #17.
            sendError(res, 400, `unknown stage '${stageStr}'`);
            return;
          }
          try {
            const candidates = store.readCandidates(requested, stage);
            const lock = store.readLock(requested, stage);
            sendJson(res, 200, {
              stage,
              candidates: candidates.map((c) => ({
                id: c.id,
                fileName: c.fileName,
                grid: {
                  version: 1 as const,
                  width: c.grid.width,
                  height: c.grid.height,
                  hotspot: c.grid.hotspot,
                  pixels: c.grid.pixels.map((row) => [...row]),
                },
              })),
              ...(lock !== undefined ? { lock } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // POST /api/projects/:name/lock { stage, candidateId } -> { stage, lock }
        // Freezes the named candidate as the canonical frame for the stage
        // and persists the recipe. One-shot per stage — the project store
        // refuses to overwrite. Delegates recipe extraction so the HTTP
        // layer never builds Recipe by hand.
        const lockMatch = /^\/api\/projects\/([^/]+)\/lock$/.exec(pathname);
        if (lockMatch && req.method === 'POST') {
          const requested = decodeURIComponent(lockMatch[1]!);
          let body: { stage?: unknown; candidateId?: unknown };
          try {
            const raw = await readBody(req);
            body = JSON.parse(raw) as { stage?: unknown; candidateId?: unknown };
          } catch {
            sendError(res, 400, 'body must be valid JSON');
            return;
          }
          const stage = typeof body.stage === 'string' ? asWiredStage(body.stage) : undefined;
          if (stage === undefined) {
            sendError(
              res,
              400,
              `body.stage must be one of: ${[...WIRED_STAGES].join(', ')}`,
            );
            return;
          }
          if (typeof body.candidateId !== 'string' || body.candidateId.length === 0) {
            sendError(res, 400, "body.candidateId must be a non-empty string");
            return;
          }
          const candidateId = body.candidateId;
          try {
            const candidates = store.readCandidates(requested, stage);
            const chosen = candidates.find((c) => c.id === candidateId);
            if (chosen === undefined) {
              sendError(res, 400, `candidate '${candidateId}' not found in stage '${stage}'`);
              return;
            }
            const recipe = extractRecipe(chosen.grid);
            store.writeLock(requested, stage, { candidateId, grid: chosen.grid, recipe });
            const lock = store.readLock(requested, stage);
            sendJson(res, 200, { stage, lock });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status =
              /already locked/i.test(msg) ? 409
                : /not found/i.test(msg) ? 404
                  : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // PUT /api/projects/:name/frames/:fileName { grid } -> { ok: true }
        // Persists an in-canvas pixel-editor edit (issue #13). The body's
        // `grid` payload is the same shape `parsePixelGrid` accepts so the
        // editor can round-trip exactly what it reads from GET. Filename and
        // project-name validation live in the project store — the route just
        // unwraps the body and forwards.
        const frameWriteMatch = /^\/api\/projects\/([^/]+)\/frames\/([^/]+)$/.exec(pathname);
        if (frameWriteMatch && req.method === 'PUT') {
          const requested = decodeURIComponent(frameWriteMatch[1]!);
          const fileName = decodeURIComponent(frameWriteMatch[2]!);
          let body: { grid?: unknown };
          try {
            const raw = await readBody(req, 1024 * 1024);
            body = JSON.parse(raw) as { grid?: unknown };
          } catch {
            sendError(res, 400, 'body must be valid JSON');
            return;
          }
          if (body.grid === undefined || body.grid === null) {
            sendError(res, 400, "body must include a 'grid' object");
            return;
          }
          try {
            const grid = parsePixelGrid(body.grid);
            store.writeFrame(requested, fileName, grid);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // PUT /api/projects/:name/candidates/:stage/:id { grid } -> { ok: true }
        // Sister route to the frames PUT for editing candidate grids.
        const candWriteMatch = /^\/api\/projects\/([^/]+)\/candidates\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (candWriteMatch && req.method === 'PUT') {
          const requested = decodeURIComponent(candWriteMatch[1]!);
          const stageStr = decodeURIComponent(candWriteMatch[2]!);
          const id = decodeURIComponent(candWriteMatch[3]!);
          const stage = asWiredStage(stageStr);
          if (stage === undefined) {
            sendError(res, 400, `unknown stage '${stageStr}'`);
            return;
          }
          let body: { grid?: unknown };
          try {
            const raw = await readBody(req, 1024 * 1024);
            body = JSON.parse(raw) as { grid?: unknown };
          } catch {
            sendError(res, 400, 'body must be valid JSON');
            return;
          }
          if (body.grid === undefined || body.grid === null) {
            sendError(res, 400, "body must include a 'grid' object");
            return;
          }
          try {
            const grid = parsePixelGrid(body.grid);
            store.writeCandidate(requested, stage, id, grid);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // GET /api/projects/:name/source -> { images: [name, ...] }
        // Reference panel (issue #16) listing endpoint. Empty array when the
        // project has no source/ directory — `source/` is optional.
        const sourceListMatch = /^\/api\/projects\/([^/]+)\/source$/.exec(pathname);
        if (sourceListMatch && req.method === 'GET') {
          const requested = decodeURIComponent(sourceListMatch[1]!);
          try {
            sendJson(res, 200, { images: store.listSourceImages(requested) });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // GET /api/projects/:name/source/:fileName -> raw image bytes
        // Static-bytes endpoint for the reference panel. Delegates path
        // validation + lookup to projectStore so the route only adds MIME
        // negotiation and byte streaming.
        const sourceFileMatch = /^\/api\/projects\/([^/]+)\/source\/([^/]+)$/.exec(pathname);
        if (sourceFileMatch && req.method === 'GET') {
          const requested = decodeURIComponent(sourceFileMatch[1]!);
          const fileName = decodeURIComponent(sourceFileMatch[2]!);
          try {
            const full = store.resolveSourceImagePath(requested, fileName);
            sendStatic(res, full);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // GET /api/projects/:name -> { project }
        const apiMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
        if (apiMatch && req.method === 'GET') {
          const requested = decodeURIComponent(apiMatch[1]!);
          try {
            const project = store.readProject(requested);
            // Re-serialise PixelGrid via plain JSON; the frontend re-parses
            // with parsePixelGrid for type-narrowed access.
            const payload = {
              name: project.name,
              palette: project.palette,
              frames: project.frames.map((f) => ({
                fileName: f.fileName,
                grid: {
                  version: 1 as const,
                  width: f.grid.width,
                  height: f.grid.height,
                  hotspot: f.grid.hotspot,
                  pixels: f.grid.pixels.map((row) => [...row]),
                },
              })),
            };
            sendJson(res, 200, payload);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // GET /api/active-project -> { name }
        if (pathname === '/api/active-project' && req.method === 'GET') {
          sendJson(res, 200, { name: session.getActiveProject() });
          return;
        }

        // POST /api/active-project { name } -> { name }
        // Used by both the in-canvas project picker and `forge` from the
        // terminal so Claude can switch the canvas without restarting the
        // server.
        if (pathname === '/api/active-project' && req.method === 'POST') {
          let body: { name?: unknown };
          try {
            const raw = await readBody(req);
            body = JSON.parse(raw) as { name?: unknown };
          } catch {
            sendError(res, 400, 'body must be valid JSON');
            return;
          }
          const name = body.name;
          if (typeof name !== 'string' || name.length === 0) {
            sendError(res, 400, "body must include a non-empty 'name' string");
            return;
          }
          try {
            session.setActiveProject(name);
            sendJson(res, 200, { name: session.getActiveProject() });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = /not found/i.test(msg) ? 404 : 400;
            sendError(res, status, msg);
          }
          return;
        }

        // Static: anything else falls through to the Vite-built bundle.
        if (req.method === 'GET' || req.method === 'HEAD') {
          const safe = pathname === '/' ? '/index.html' : pathname;
          // Strip the leading slash so path.join treats it relative to distDir.
          const candidate = path.normalize(path.join(distDir, safe));
          // Make sure the resolved path stays inside distDir.
          const rel = path.relative(distDir, candidate);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            sendError(res, 400, 'invalid path');
            return;
          }
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            sendStatic(res, candidate);
            return;
          }
          // SPA fallback: serve index.html for unknown paths so client-side
          // routing works if we ever add it.
          const indexHtml = path.join(distDir, 'index.html');
          if (fs.existsSync(indexHtml)) {
            sendStatic(res, indexHtml);
            return;
          }
          sendError(res, 404, `not found: ${pathname}`);
          return;
        }

        sendError(res, 405, `method not allowed: ${req.method}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, msg);
      }
    })();
  };
}

export interface StartedServer {
  port: number;
  url: string;
  /** Underlying Node http.Server, exposed so callers can attach WebSockets. */
  server: http.Server;
  close(): Promise<void>;
}

export function startServer(opts: ServerOptions): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(createApp(opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server.address() did not return an AddressInfo'));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        url: `http://${host}:${port}/`,
        server,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}

// Resolve the directory of this file so callers can compute distDir relative
// to it. Useful when this module is run via tsx from arbitrary cwd.
export function moduleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}
