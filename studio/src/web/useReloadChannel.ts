// useReloadChannel — opens a WebSocket to the studio server's /ws endpoint
// and fires the supplied callback whenever the server pushes a `reload`
// frame. Auto-reconnects on close so a server restart during development
// does not require a manual page refresh.
//
// Glue module: no business decisions live here. Callers (App.tsx) react to
// the events by refetching the project payload.

import { useEffect, useRef } from 'react';

export type ReloadKind = 'frame' | 'palette';

export interface ReloadEventPayload {
  kind: ReloadKind;
  fileName?: string;
}

interface ServerMessage {
  type: 'hello' | 'reload' | string;
  event?: ReloadEventPayload;
}

export interface ReloadChannelOptions {
  /** WebSocket URL — defaults to /ws on the page origin. */
  url?: string;
  /** Reconnect delay in ms. Default 1000. */
  reconnectMs?: number;
  /** Called once per `reload` frame received from the server. */
  onReload: (event: ReloadEventPayload) => void;
}

function resolveUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof window === 'undefined') return 'ws://localhost/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function useReloadChannel(opts: ReloadChannelOptions): void {
  // Keep the latest callback in a ref so the effect doesn't re-open the
  // socket every render — the WebSocket connection is the expensive thing.
  const cbRef = useRef(opts.onReload);
  cbRef.current = opts.onReload;

  const url = opts.url;
  const reconnectMs = opts.reconnectMs ?? 1000;

  useEffect(() => {
    const target = resolveUrl(url);
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;
      socket = new WebSocket(target);
      socket.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as ServerMessage;
          if (msg.type === 'reload' && msg.event) {
            cbRef.current(msg.event);
          }
        } catch {
          // Ignore malformed frames — the server only ever sends JSON.
        }
      });
      socket.addEventListener('close', () => {
        if (cancelled) return;
        retry = setTimeout(connect, reconnectMs);
      });
      socket.addEventListener('error', () => {
        // 'error' is followed by 'close', which handles the retry.
      });
    };
    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [url, reconnectMs]);
}
