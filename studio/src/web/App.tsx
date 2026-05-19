import { useEffect, useState } from 'react';
import { parsePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import { PixelCanvas } from './PixelCanvas.js';

interface PaletteEntry {
  index: number;
  rgba: string;
}

interface Palette {
  version: number;
  colors: PaletteEntry[];
}

interface ProjectResponse {
  name: string;
  palette: Palette;
  frames: Array<{ fileName: string; grid: unknown }>;
}

interface LoadedProject {
  name: string;
  palette: Palette;
  frames: Array<{ fileName: string; grid: PixelGrid }>;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: LoadedProject };

async function loadActiveProject(): Promise<LoadedProject> {
  const activeRes = await fetch('/api/active-project');
  if (!activeRes.ok) throw new Error(`active-project: HTTP ${activeRes.status}`);
  const { name } = (await activeRes.json()) as { name: string };

  const projRes = await fetch(`/api/projects/${encodeURIComponent(name)}`);
  if (!projRes.ok) {
    const body = (await projRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${projRes.status}`);
  }
  const payload = (await projRes.json()) as ProjectResponse;
  return {
    name: payload.name,
    palette: payload.palette,
    frames: payload.frames.map((f) => ({ fileName: f.fileName, grid: parsePixelGrid(f.grid) })),
  };
}

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadActiveProject()
      .then((project) => {
        if (!cancelled) setState({ status: 'ready', project });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="studio">
        <header className="studio__header">
          <h1 className="studio__title">Cursor Studio</h1>
        </header>
        <main className="studio__stage">
          <div className="studio__status">Loading…</div>
        </main>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="studio">
        <header className="studio__header">
          <h1 className="studio__title">Cursor Studio</h1>
        </header>
        <main className="studio__stage">
          <div className="studio__status">
            <div className="studio__error">{state.message}</div>
          </div>
        </main>
      </div>
    );
  }

  const { project } = state;
  const frame = project.frames[0]!;
  return (
    <div className="studio">
      <header className="studio__header">
        <h1 className="studio__title">
          Cursor Studio · <span className="studio__project">{project.name}</span>
        </h1>
        <span className="studio__meta">
          {frame.grid.width}×{frame.grid.height} · hotspot ({frame.grid.hotspot.x},{frame.grid.hotspot.y}) ·{' '}
          {frame.fileName}
        </span>
      </header>
      <main className="studio__stage">
        <div className="studio__canvas-wrap">
          <PixelCanvas grid={frame.grid} palette={project.palette} pixelSize={16} />
        </div>
      </main>
    </div>
  );
}
