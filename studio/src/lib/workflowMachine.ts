// Workflow state machine — pure reducer driving the candidate-gallery flow.
//
// Deep module. The Cursor Studio workflow is "first frame → middle frame →
// last frame → tween" (see PRD #5). This slice (issue #11) implements the
// `first` stage's candidate set and selection pointer. Later slices add
// lock + recipe (#12), middle/last candidates (#15/#17), and tween
// transitions (#18). The shape is deliberately built so those additions only
// add new action types and new stage entries — never reshape what already
// exists.
//
// The reducer is total and pure: invalid transitions throw, no internal
// mutation, no IO. The project store decides which candidate ids exist on
// disk and dispatches `candidates-loaded`; the UI dispatches `select`.

export type Stage = 'first';

export interface WorkflowState {
  /** Which stage of the workflow is currently active. */
  readonly stage: Stage;
  /** Ordered candidate ids per stage. Order matches the on-disk read order. */
  readonly candidates: { readonly [S in Stage]: ReadonlyArray<string> };
  /**
   * Selected candidate id per stage, if any. The selection is what the main
   * view renders large; the rest of the stage's candidates render as
   * thumbnails. Undefined when the stage has no candidates yet.
   */
  readonly selected: { readonly [S in Stage]: string | undefined };
}

export type WorkflowAction =
  | { type: 'candidates-loaded'; stage: Stage; ids: ReadonlyArray<string> }
  | { type: 'select'; stage: Stage; id: string };

export function createWorkflowState(): WorkflowState {
  return {
    stage: 'first',
    candidates: { first: [] },
    selected: { first: undefined },
  };
}

export function reduceWorkflow(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case 'candidates-loaded': {
      const ids: ReadonlyArray<string> = [...action.ids];
      const prior = state.selected[action.stage];
      // Preserve the user's current selection if it survived the refresh.
      // Otherwise fall back to the first candidate, or undefined when empty.
      // This keeps the UI from jumping around on every file-watcher push.
      const nextSelected = prior !== undefined && ids.includes(prior) ? prior : ids[0];
      return {
        ...state,
        candidates: { ...state.candidates, [action.stage]: ids },
        selected: { ...state.selected, [action.stage]: nextSelected },
      };
    }
    case 'select': {
      const set = state.candidates[action.stage];
      if (!set.includes(action.id)) {
        throw new Error(
          `workflowMachine: '${action.id}' is not in candidate set for stage '${action.stage}'`,
        );
      }
      return {
        ...state,
        selected: { ...state.selected, [action.stage]: action.id },
      };
    }
  }
}
