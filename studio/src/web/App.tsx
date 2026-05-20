import { useCallback, useEffect, useReducer, useState, type Reducer } from 'react';
import { parsePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import {
  createWorkflowState,
  reduceWorkflow,
  type WorkflowAction,
  type WorkflowState,
} from '../lib/workflowMachine.js';
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

interface FramePayload {
  fileName: string;
  grid: unknown;
}

interface ProjectResponse {
  name: string;
  palette: Palette;
  frames: FramePayload[];
}

interface CandidatePayload {
  id: string;
  fileName: string;
  grid: unknown;
}

interface CandidatesResponse {
  stage: 'first';
  candidates: CandidatePayload[];
}

interface LoadedCandidate {
  id: string;
  fileName: string;
  grid: PixelGrid;
}

interface LoadedProject {
  name: string;
  palette: Palette;
  frames: Array<{ fileName: string; grid: PixelGrid }>;
  /**
   * First-frame stage candidates loaded from disk. Empty when the project
   * has not yet had any candidate JSON generated.
   */
  firstCandidates: LoadedCandidate[];
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

  const candRes = await fetch(`/api/projects/${encodeURIComponent(name)}/candidates/first`);
  if (!candRes.ok) {
    const body = (await candRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${candRes.status}`);
  }
  const candPayload = (await candRes.json()) as CandidatesResponse;

  return {
    name: payload.name,
    palette: payload.palette,
    frames: payload.frames.map((f) => ({ fileName: f.fileName, grid: parsePixelGrid(f.grid) })),
    firstCandidates: candPayload.candidates.map((c) => ({
      id: c.id,
      fileName: c.fileName,
      grid: parsePixelGrid(c.grid),
    })),
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
  // The workflow reducer holds candidate selection state. Lives alongside
  // `state` rather than inside it because selection survives across project
  // reloads (the reducer preserves a still-valid selection on
  // candidates-loaded), and we want React to re-render on a selection click
  // without a network round-trip.
  // useReducer's React-18 generic typings are fiddly with strict mode; the
  // simplest no-cast spelling is to give the reducer fn an explicit pair of
  // type parameters via a local alias.
  const workflowReducer: Reducer<WorkflowState, WorkflowAction> = reduceWorkflow;
  const [workflow, dispatchWorkflow] = useReducer(workflowReducer, createWorkflowState());

  const refresh = useCallback((): void => {
    // Always re-read the project list at the same time as the active
    // project — a switch implies the list might also have changed
    // (e.g. a new project was just scaffolded on disk).
    Promise.all([loadActiveProject(), loadProjects()])
      .then(([project, list]) => {
        setProjects(list);
        setState({ status: 'ready', project });
        dispatchWorkflow({
          type: 'candidates-loaded',
          stage: 'first',
          ids: project.firstCandidates.map((c) => c.id),
        });
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
        dispatchWorkflow({
          type: 'candidates-loaded',
          stage: 'first',
          ids: project.firstCandidates.map((c) => c.id),
        });
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
  // frame, candidate, palette.json, or the active project itself changes.
  // We refetch — the server is the single source of truth (PRD: "the
  // filesystem is the single source of truth"), so a fresh read is the
  // right thing every time.
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

  const onPickCandidate = useCallback((id: string): void => {
    dispatchWorkflow({ type: 'select', stage: 'first', id });
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
  // When the first-frame stage has candidates, the gallery is the main
  // surface. Otherwise we fall back to the first frame — useful for the
  // tracer slice and for inspecting already-tweened animations.
  const selectedCandidate =
    project.firstCandidates.find((c) => c.id === workflow.selected.first) ??
    project.firstCandidates[0];

  const showCandidates = project.firstCandidates.length > 0 && selectedCandidate !== undefined;
  const mainGrid = showCandidates ? selectedCandidate!.grid : project.frames[0]!.grid;
  const mainLabel = showCandidates ? selectedCandidate!.fileName : project.frames[0]!.fileName;

  return (
    <div className="studio">
      <header className="studio__header">
        <h1 className="studio__title">Cursor Studio</h1>
        <ProjectPicker projects={projects} active={project.name} onPick={onPickProject} />
        <span className="studio__meta">
          {mainGrid.width}×{mainGrid.height} · hotspot ({mainGrid.hotspot.x},{mainGrid.hotspot.y}) ·{' '}
          {mainLabel}
        </span>
      </header>
      <main className="studio__stage">
        <div className="studio__canvas-wrap">
          <PixelCanvas grid={mainGrid} palette={project.palette} pixelSize={16} />
        </div>
      </main>
      {showCandidates ? (
        <CandidateStrip
          candidates={project.firstCandidates}
          palette={project.palette}
          selectedId={selectedCandidate!.id}
          onPick={onPickCandidate}
        />
      ) : null}
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

interface CandidateStripProps {
  candidates: LoadedCandidate[];
  palette: Palette;
  selectedId: string;
  onPick: (id: string) => void;
}

/**
 * Bottom thumbnail strip — one button per candidate. The selected one is
 * highlighted so the user always knows which thumbnail the main view is
 * mirroring. Each thumbnail is the same PixelCanvas component the main view
 * uses, just shrunk; that keeps the pixel-grid overlay and hotspot
 * crosshair visible at thumbnail scale.
 */
function CandidateStrip({ candidates, palette, selectedId, onPick }: CandidateStripProps): JSX.Element {
  return (
    <footer className="studio__strip" role="tablist" aria-label="First-frame candidates">
      {candidates.map((c) => {
        const isActive = c.id === selectedId;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`studio__thumb${isActive ? ' studio__thumb--active' : ''}`}
            onClick={() => onPick(c.id)}
            title={c.fileName}
          >
            <PixelCanvas grid={c.grid} palette={palette} pixelSize={2} />
            <span className="studio__thumb-label">{c.id}</span>
          </button>
        );
      })}
    </footer>
  );
}
