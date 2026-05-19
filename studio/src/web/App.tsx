import { useCallback, useEffect, useState } from 'react';
import { parsePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import { PixelCanvas } from './PixelCanvas.js';
import { useReloadChannel } from './useReloadChannel.js';

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

async function loadProjects(): Promise<string[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error(`projects: HTTP ${res.status}`);
  const body = (await res.json()) as { projects: string[] };
  return body.projects;
}

async function postActiveProject(name: string): Promise<void> {
  const res = await fetch('/api/active-project', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [projects, setProjects] = useState<string[]>([]);

  const refresh = useCallback((): void => {
    // Always re-read the project list at the same time as the active
    // project — a switch implies the list might also have changed
    // (e.g. a new project was just scaffolded on disk).
    Promise.all([loadActiveProject(), loadProjects()])
      .then(([project, list]) => {
        setProjects(list);
        setState({ status: 'ready', project });
      })
      .catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadActiveProject(), loadProjects()])
      .then(([project, list]) => {
        if (cancelled) return;
        setProjects(list);
        setState({ status: 'ready', project });
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

  // Live filesystem sync: server pushes a `reload` frame whenever a JSON
  // frame, palette.json, or the active project itself changes. We refetch —
  // the server is the single source of truth (PRD: "the filesystem is the
  // single source of truth"), so a fresh read is the right thing every
  // time. This is also how a programmatic switch from Claude's terminal
  // shows up here without a manual UI action.
  useReloadChannel({ onReload: refresh });

  const onPickProject = useCallback(
    (name: string): void => {
      if (state.status === 'ready' && state.project.name === name) return;
      postActiveProject(name).catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      // The server emits a `project` reload event on success, which fires
      // refresh() via useReloadChannel. We deliberately do NOT call refresh()
      // here — letting the WebSocket round-trip drive the UI keeps the
      // picker behaviour identical whether the switch came from the UI or
      // from Claude in the terminal.
    },
    [state],
  );

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
          <ProjectPicker projects={projects} active={undefined} onPick={onPickProject} />
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
        <h1 className="studio__title">Cursor Studio</h1>
        <ProjectPicker projects={projects} active={project.name} onPick={onPickProject} />
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

interface ProjectPickerProps {
  projects: string[];
  active: string | undefined;
  onPick: (name: string) => void;
}

function ProjectPicker({ projects, active, onPick }: ProjectPickerProps): JSX.Element {
  // When the server only knows about one project there is nothing to pick
  // between, but we still surface the project name so the header reads
  // consistently with the multi-project case.
  if (projects.length === 0) {
    return <span className="studio__project">{active ?? '(no projects)'}</span>;
  }
  return (
    <label className="studio__picker">
      <span className="studio__picker-label">Project</span>
      <select
        className="studio__picker-select"
        value={active ?? ''}
        onChange={(e) => onPick(e.currentTarget.value)}
      >
        {active !== undefined && !projects.includes(active) ? (
          <option value={active}>{active}</option>
        ) : null}
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}
