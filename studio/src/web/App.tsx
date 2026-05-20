import { useCallback, useEffect, useReducer, useState, type Reducer } from 'react';
import { parsePixelGrid, serializePixelGrid, type PixelGrid } from '../lib/pixelGrid.js';
import {
  createWorkflowState,
  reduceWorkflow,
  type LockedFrame,
  type Phase,
  type Recipe,
  type Stage,
  type WorkflowAction,
  type WorkflowState,
} from '../lib/workflowMachine.js';
import { PixelCanvas } from './PixelCanvas.js';
import { PixelEditor } from './PixelEditor.js';
import { useReloadChannel } from './useReloadChannel.js';

/**
 * Workflow stages currently wired through the HTTP surface. Mirrors the
 * server's WIRED_STAGES — kept in lock-step manually because the frontend
 * bundle does not import server code. All three keyframe stages are wired
 * as of #17; the post-keyframes `'tween-ready'` phase is not a UI stage
 * (no candidate gallery to render), only a reducer phase value.
 */
const UI_STAGES: ReadonlyArray<Stage> = ['first', 'middle', 'last'];

/**
 * Narrow a workflow phase to one of the keyframe stages. Returns false for
 * the post-keyframes `'tween-ready'` sentinel — that phase has no gallery
 * surface, so callers fall back to the last keyframe stage when clamping.
 */
function isStage(p: Phase): p is Stage {
  return UI_STAGES.includes(p as Stage);
}

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
  stage: Stage;
  candidates: CandidatePayload[];
  /** Lock marker — present iff the stage has been locked on disk. */
  lock?: { candidateId: string; recipe: Recipe };
}

interface LoadedCandidate {
  id: string;
  fileName: string;
  grid: PixelGrid;
}

interface LoadedStage {
  /** Candidate grids loaded from candidates/<stage>/. */
  candidates: LoadedCandidate[];
  /** Lock marker, if the stage has been locked on disk. */
  lock: LockedFrame | undefined;
}

interface LoadedProject {
  name: string;
  palette: Palette;
  frames: Array<{ fileName: string; grid: PixelGrid }>;
  /**
   * Per-stage view of disk state. The reducer drives which stage's
   * candidates the gallery currently shows; this struct keeps the loaded
   * data for every wired stage so a stage switch is purely local.
   */
  stages: { readonly [S in Stage]: LoadedStage };
  /** Reference images (filenames only) from projects/<Name>/source/. */
  sourceImages: ReadonlyArray<string>;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; project: LoadedProject };

async function loadCandidates(projectName: string, stage: Stage): Promise<LoadedStage> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/candidates/${encodeURIComponent(stage)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const payload = (await res.json()) as CandidatesResponse;
  return {
    candidates: payload.candidates.map((c) => ({
      id: c.id,
      fileName: c.fileName,
      grid: parsePixelGrid(c.grid),
    })),
    lock:
      payload.lock !== undefined
        ? { id: payload.lock.candidateId, recipe: payload.lock.recipe }
        : undefined,
  };
}

async function loadSourceImages(projectName: string): Promise<string[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/source`);
  if (!res.ok) {
    // A missing source/ directory is reported as an empty list by the
    // server; any other status means we should surface the problem.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { images: string[] };
  return payload.images;
}

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

  // Load every wired stage + the reference-image listing in parallel — the
  // gallery switches between stages locally based on workflow.stage, and
  // the reference panel renders alongside, so paying the network cost once
  // up front keeps stage / tool switches local.
  const [stageResults, sourceImages] = await Promise.all([
    Promise.all(UI_STAGES.map(async (s) => [s, await loadCandidates(name, s)] as const)),
    loadSourceImages(name),
  ]);
  const stages = Object.fromEntries(stageResults) as { [S in Stage]: LoadedStage };

  return {
    name: payload.name,
    palette: payload.palette,
    frames: payload.frames.map((f) => ({ fileName: f.fileName, grid: parsePixelGrid(f.grid) })),
    stages,
    sourceImages,
  };
}

async function postLock(projectName: string, stage: Stage, candidateId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, candidateId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

async function putFrame(projectName: string, fileName: string, grid: PixelGrid): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/frames/${encodeURIComponent(fileName)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(grid) }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

async function putCandidate(
  projectName: string,
  stage: Stage,
  id: string,
  grid: PixelGrid,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/candidates/${encodeURIComponent(stage)}/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grid: serializePixelGrid(grid) }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
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
  // Onion-skin defaults on once at least one keyframe is locked — there is
  // nothing to ghost until then. The user can flip it off when the overlay
  // gets in the way (acceptance criterion: "a toggle controls onion-skin
  // visibility"). Persisted in component state, not in disk metadata —
  // it's a viewing preference, not part of the design.
  const [onionOn, setOnionOn] = useState<boolean>(true);
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

  /**
   * Dispatch candidates-loaded for every wired stage. The order matters:
   * locking `first` advances the reducer's stage from `first` to `middle`,
   * so we must replay `first` before `middle` to land on the right stage
   * after a page reload. UI_STAGES is already in workflow order.
   */
  const replayStages = useCallback((project: LoadedProject): void => {
    // The reducer rejects further actions on a locked stage. Construct a
    // fresh state each refresh by re-keying the project (see PixelEditor
    // re-key below); here we lean on the reducer's idempotent rehydration —
    // each candidates-loaded with a `locked` payload restores the same
    // stage state regardless of how many times it fires.
    for (const stage of UI_STAGES) {
      const data = project.stages[stage];
      dispatchWorkflow({
        type: 'candidates-loaded',
        stage,
        ids: data.candidates.map((c) => c.id),
        ...(data.lock !== undefined ? { locked: data.lock } : {}),
      });
    }
  }, []);

  const refresh = useCallback((): void => {
    // Always re-read the project list at the same time as the active
    // project — a switch implies the list might also have changed
    // (e.g. a new project was just scaffolded on disk).
    Promise.all([loadActiveProject(), loadProjects()])
      .then(([project, list]) => {
        setProjects(list);
        setState({ status: 'ready', project });
        replayStages(project);
      })
      .catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [replayStages]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadActiveProject(), loadProjects()])
      .then(([project, list]) => {
        if (cancelled) return;
        setProjects(list);
        setState({ status: 'ready', project });
        replayStages(project);
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
  }, [replayStages]);

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

  // The "active" stage for UI purposes is the reducer's current stage when
  // it is one of the keyframe stages. Once the reducer enters the
  // post-keyframes `'tween-ready'` phase (after #17's last-stage lock),
  // the gallery clamps to the last keyframe stage so the user keeps seeing
  // the frozen last-frame candidate they just approved — no blank screen.
  const activeStage: Stage = isStage(workflow.stage)
    ? workflow.stage
    : UI_STAGES[UI_STAGES.length - 1]!;

  const onPickCandidate = useCallback(
    (id: string): void => {
      // The reducer rejects selects on a locked stage; mirror that here so
      // a stray click cannot put the UI in an error state.
      if (workflow.locked[activeStage] !== undefined) return;
      dispatchWorkflow({ type: 'select', stage: activeStage, id });
    },
    [workflow.locked, activeStage],
  );

  const onLock = useCallback(
    (stage: Stage, candidateId: string): void => {
      if (state.status !== 'ready') return;
      postLock(state.project.name, stage, candidateId).catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      // The watcher fires reload events for the stage's lock.json,
      // recipe.json, and the canonical-frame placeholder. Those trigger
      // refresh() over the WebSocket; refresh re-dispatches
      // candidates-loaded (with the locked payload) so the reducer's view
      // matches disk. No optimistic update — the filesystem stays the
      // single source of truth (PRD #5).
    },
    [state],
  );

  // Editing-target persistence sink. Declared here (before any early
  // returns) so the hook count is stable across loading / error / ready
  // renders — React's rules-of-hooks crashes the tree otherwise (manifests
  // as a black screen on the first ready-state transition). The callback
  // computes its captures from `state` at call time, so it no-ops cleanly
  // when the project isn't loaded yet.
  const onPersist = useCallback(
    (next: PixelGrid): void => {
      if (state.status !== 'ready') return;
      const project = state.project;
      const stageData = project.stages[activeStage];
      const stageCandidates = stageData.candidates;
      const selectedCandidate =
        stageCandidates.find((c) => c.id === workflow.selected[activeStage]) ??
        stageCandidates[0];
      const showCandidates = stageCandidates.length > 0 && selectedCandidate !== undefined;
      const writer = showCandidates
        ? putCandidate(project.name, activeStage, selectedCandidate!.id, next)
        : putFrame(project.name, project.frames[0]!.fileName, next);
      writer.catch((err: unknown) => {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [state, activeStage, workflow.selected],
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
  const activeStageData = project.stages[activeStage];
  const stageCandidates = activeStageData.candidates;
  const stageLock = activeStageData.lock;

  // The gallery shows the active stage's candidates. When the stage has no
  // candidates yet, fall back to the first frame so the editor still has
  // something to draw — useful for the tracer slice and for inspecting an
  // already-tweened animation.
  const selectedCandidate =
    stageCandidates.find((c) => c.id === workflow.selected[activeStage]) ??
    stageCandidates[0];

  // Onion-skin grids — every prior wired stage's locked candidate grid,
  // filtered by canvas dimensions so a stage with a different size never
  // misaligns under the working grid. Empty list (or onionOn=false) means
  // the canvas renders the working grid only.
  const onionGrids: PixelGrid[] = onionOn
    ? UI_STAGES.filter((s) => s !== activeStage)
        .map((s) => {
          const lock = project.stages[s].lock;
          if (lock === undefined) return undefined;
          const cand = project.stages[s].candidates.find((c) => c.id === lock.id);
          return cand?.grid;
        })
        .filter((g): g is PixelGrid => g !== undefined)
    : [];

  const showCandidates = stageCandidates.length > 0 && selectedCandidate !== undefined;
  const mainGrid = showCandidates ? selectedCandidate!.grid : project.frames[0]!.grid;
  const mainLabel = showCandidates ? selectedCandidate!.fileName : project.frames[0]!.fileName;
  const mainFrameFile = project.frames[0]!.fileName;
  // Editing target: the candidate when we're browsing the gallery, otherwise
  // the underlying frame. Locking already froze the selected candidate into
  // a canonical frame slot, so editing the candidate after that point still
  // writes to candidates/<stage>/<id>.json — that is the manual edit
  // surface; the recipe never overwrites it (PRD acceptance criterion 6).
  // The `onPersist` callback itself is declared above the early returns so
  // hook order stays stable across loading / error / ready renders.
  // The Lock action appears on the active stage when a candidate is
  // selected and the stage is unlocked. Past stages' lock indicators stay
  // visible alongside so the user sees the full chain of approved
  // keyframes building up (PRD acceptance criterion: "the locked first
  // frame remains indicated somewhere in context" for #15).
  const canLock = stageLock === undefined && showCandidates && selectedCandidate !== undefined;

  return (
    <div className="studio">
      <header className="studio__header">
        <h1 className="studio__title">Cursor Studio</h1>
        <ProjectPicker projects={projects} active={project.name} onPick={onPickProject} />
        <span className="studio__meta">
          {mainGrid.width}×{mainGrid.height} · hotspot ({mainGrid.hotspot.x},{mainGrid.hotspot.y}) ·{' '}
          {mainLabel}
        </span>
        <span className="studio__stage-badge" aria-label={`Workflow stage: ${workflow.stage}`}>
          Stage: {workflow.stage}
        </span>
        <LockChain stages={UI_STAGES} project={project} activeStage={activeStage} />
        {canLock ? (
          <button
            type="button"
            className="studio__lock"
            onClick={() => onLock(activeStage, selectedCandidate!.id)}
          >
            Lock this candidate
          </button>
        ) : null}
        {hasAnyLock(project) ? (
          <label className="studio__toggle" title="Show locked keyframes ghosted under the current frame">
            <input
              type="checkbox"
              checked={onionOn}
              onChange={(e) => setOnionOn(e.currentTarget.checked)}
            />
            <span>Onion-skin</span>
          </label>
        ) : null}
      </header>
      <main className="studio__stage">
        <PixelEditor
          // Re-key on the editing target so a candidate switch resets the
          // editor's local undo history — undo should not cross frame
          // boundaries. The stage is part of the key so the editor also
          // resets when the workflow advances to a new stage's gallery.
          key={`${project.name}:${activeStage}:${showCandidates ? `cand:${selectedCandidate!.id}` : `frame:${mainFrameFile}`}`}
          grid={mainGrid}
          palette={project.palette}
          pixelSize={16}
          onion={onionGrids}
          onPersist={onPersist}
        />
        <ReferencePanel projectName={project.name} images={project.sourceImages} />
      </main>
      {showCandidates ? (
        <CandidateStrip
          stage={activeStage}
          candidates={stageCandidates}
          palette={project.palette}
          selectedId={selectedCandidate!.id}
          lockedId={stageLock?.id}
          onPick={onPickCandidate}
        />
      ) : null}
    </div>
  );
}

interface LockChainProps {
  stages: ReadonlyArray<Stage>;
  project: LoadedProject;
  activeStage: Stage;
}

/**
 * Read-only chain of "Locked: <id>" badges, one per wired stage that has
 * a lock marker on disk. Shows the user the chain of approved keyframes
 * that have built up — PRD acceptance criterion for #15: "the locked
 * first frame remains indicated somewhere in context" when the middle
 * stage is active. Stays trivial — no interactivity beyond the badge.
 */
function LockChain({ stages, project, activeStage }: LockChainProps): JSX.Element | null {
  const locked = stages.filter((s) => s !== activeStage && project.stages[s].lock !== undefined);
  if (locked.length === 0) return null;
  return (
    <span className="studio__lock-chain" aria-label="Previously locked stages">
      {locked.map((s) => {
        const lock = project.stages[s].lock!;
        return (
          <span key={s} className="studio__lock studio__lock--locked">
            {s}: {lock.id}
          </span>
        );
      })}
    </span>
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

interface ReferencePanelProps {
  projectName: string;
  images: ReadonlyArray<string>;
}

/**
 * Side panel showing every reference image from `projects/<Name>/source/`.
 * Issue #16's "reference panel" acceptance criterion. Renders the bytes
 * straight from the static endpoint — the browser handles JPEG/PNG/WebP
 * decoding for free. Hidden entirely when the project has no source/
 * images, so a fresh project gets the full canvas.
 */
function ReferencePanel({ projectName, images }: ReferencePanelProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <aside className="studio__refs" aria-label="Reference images">
      <h2 className="studio__refs-title">Reference</h2>
      <ul className="studio__refs-list">
        {images.map((name) => (
          <li key={name} className="studio__refs-item">
            <img
              className="studio__refs-img"
              src={`/api/projects/${encodeURIComponent(projectName)}/source/${encodeURIComponent(name)}`}
              alt={name}
              title={name}
              loading="lazy"
            />
            <span className="studio__refs-label">{name}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function hasAnyLock(project: LoadedProject): boolean {
  for (const s of UI_STAGES) {
    if (project.stages[s].lock !== undefined) return true;
  }
  return false;
}

interface CandidateStripProps {
  stage: Stage;
  candidates: LoadedCandidate[];
  palette: Palette;
  selectedId: string;
  /** Id of the locked candidate, if any. Renders a lock indicator on that thumbnail. */
  lockedId: string | undefined;
  onPick: (id: string) => void;
}

/**
 * Bottom thumbnail strip — one button per candidate. The selected one is
 * highlighted so the user always knows which thumbnail the main view is
 * mirroring. The locked one (if any) gets a visible lock indicator so it
 * stays distinguishable even when another candidate is selected for
 * browsing. Each thumbnail is the same PixelCanvas component the main view
 * uses, just shrunk; that keeps the pixel-grid overlay and hotspot
 * crosshair visible at thumbnail scale.
 */
function CandidateStrip({
  stage,
  candidates,
  palette,
  selectedId,
  lockedId,
  onPick,
}: CandidateStripProps): JSX.Element {
  return (
    <footer className="studio__strip" role="tablist" aria-label={`${stage}-frame candidates`}>
      {candidates.map((c) => {
        const isActive = c.id === selectedId;
        const isLocked = c.id === lockedId;
        const classes = [
          'studio__thumb',
          isActive ? 'studio__thumb--active' : '',
          isLocked ? 'studio__thumb--locked' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={classes}
            onClick={() => onPick(c.id)}
            title={isLocked ? `${c.fileName} (locked)` : c.fileName}
          >
            <PixelCanvas grid={c.grid} palette={palette} pixelSize={2} />
            <span className="studio__thumb-label">
              {isLocked ? '\u{1F512} ' : ''}
              {c.id}
            </span>
          </button>
        );
      })}
    </footer>
  );
}
