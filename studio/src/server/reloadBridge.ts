// reloadBridge — glues the projectWatcher to the browser over WebSocket.
//
// Attaches a WebSocketServer at /ws on the supplied http.Server, forwards
// every reload event from the watcher to every connected client as a JSON
// frame, and tears both ends down on close().
//
// Glue module: no business logic here. The watcher decides what changed;
// this module decides how to broadcast it.

import type * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ProjectWatcher, ReloadEvent } from './projectWatcher.js';

export interface ReloadBridgeOptions {
  server: http.Server;
  watcher: ProjectWatcher;
  /** WebSocket path. Default '/ws'. */
  path?: string;
}

export interface ReloadBridge {
  /** Number of currently connected clients — useful for tests. */
  clientCount(): number;
  close(): void;
}

export function createReloadBridge(opts: ReloadBridgeOptions): ReloadBridge {
  const wss = new WebSocketServer({ server: opts.server, path: opts.path ?? '/ws' });

  const clients = new Set<WebSocket>();
  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    // Greet the client so it knows the channel is live.
    try {
      ws.send(JSON.stringify({ type: 'hello' }));
    } catch {
      // ignore — connection died between accept and first send
    }
  });

  const unsubscribe = opts.watcher.onChange((event: ReloadEvent) => {
    const payload = JSON.stringify({ type: 'reload', event });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload);
        } catch {
          // Best-effort: drop on send failure, the 'close'/'error' handlers
          // will prune the client.
        }
      }
    }
  });

  return {
    clientCount: () => clients.size,
    close(): void {
      unsubscribe();
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      wss.close();
    },
  };
}
