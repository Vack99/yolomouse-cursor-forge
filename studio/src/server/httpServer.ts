// HTTP server — serves the built Vite bundle and one API route.
// Glue module: exercised by the smoke test in test/server.smoke.test.ts and
// by `forge canvas` in production. No business logic lives here; it shells
// every request out to the project store.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectStore } from './projectStore.js';

export interface ServerOptions {
  store: ProjectStore;
  /** Default project served on `/`. */
  projectName: string;
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

export function createApp(opts: ServerOptions): http.RequestListener {
  const { store, projectName, distDir } = opts;

  return (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // API: GET /api/projects/:name -> { project }
      const apiMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
      if (apiMatch && req.method === 'GET') {
        const requested = decodeURIComponent(apiMatch[1]!);
        try {
          const project = store.readProject(requested);
          // Re-serialise PixelGrid via plain JSON; the frontend re-parses with
          // parsePixelGrid for type-narrowed access.
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

      // API: GET /api/active-project -> { name } (so the SPA knows which
      // project this server was launched against without hard-coding it).
      if (pathname === '/api/active-project' && req.method === 'GET') {
        sendJson(res, 200, { name: projectName });
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
  };
}

export interface StartedServer {
  port: number;
  url: string;
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
