import { describe, it, expect } from 'vitest';
import {
  createWorkflowState,
  reduceWorkflow,
  type WorkflowState,
} from '../src/lib/workflowMachine.js';

// Workflow state machine — pure reducer for the candidate-gallery workflow.
//
// Issue #11 scope: the `first` stage. The reducer holds the set of candidate
// ids known for the stage plus a "selected candidate" pointer. Later issues
// (#12 lock, #15 middle, #17 last, #14 generate-more) layer extra transitions
// onto the same reducer without changing the shape this slice introduces.
//
// A candidate id is a stable identifier — for the project-store backed
// implementation it is the basename of the JSON file (e.g. 'candidate_03'),
// but the reducer treats ids as opaque strings.

describe('workflowMachine — initial state', () => {
  it('starts on the first stage with no candidates and no selection', () => {
    const s = createWorkflowState();
    expect(s.stage).toBe('first');
    expect(s.candidates.first).toEqual([]);
    expect(s.selected.first).toBeUndefined();
  });
});

describe('workflowMachine — candidates-loaded', () => {
  it('records every candidate id from disk and auto-selects the first one when nothing is selected', () => {
    const s0 = createWorkflowState();
    const s1 = reduceWorkflow(s0, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    expect(s1.candidates.first).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
    expect(s1.selected.first).toBe('candidate_00');
  });

  it('preserves the current selection when it still exists in the new id list', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' });
    expect(s.selected.first).toBe('candidate_01');

    // A new file lands on disk — the existing selection must survive.
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    expect(s.candidates.first).toEqual(['candidate_00', 'candidate_01', 'candidate_02']);
    expect(s.selected.first).toBe('candidate_01');
  });

  it('falls back to the first id when the prior selection no longer exists', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_01' });

    // The selected candidate disappears from disk.
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_02'],
    });
    expect(s.selected.first).toBe('candidate_00');
  });

  it('clears the selection when no candidates remain', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(s.selected.first).toBe('candidate_00');
    s = reduceWorkflow(s, { type: 'candidates-loaded', stage: 'first', ids: [] });
    expect(s.candidates.first).toEqual([]);
    expect(s.selected.first).toBeUndefined();
  });

  it('does not mutate the input state (purity)', () => {
    const s0 = createWorkflowState();
    const before = JSON.stringify(s0);
    reduceWorkflow(s0, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('workflowMachine — select', () => {
  it('updates the selected candidate when the id is in the candidate set', () => {
    let s: WorkflowState = createWorkflowState();
    s = reduceWorkflow(s, {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00', 'candidate_01', 'candidate_02'],
    });
    s = reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_02' });
    expect(s.selected.first).toBe('candidate_02');
  });

  it('rejects selection of an id that is not in the candidate set', () => {
    const s = reduceWorkflow(createWorkflowState(), {
      type: 'candidates-loaded',
      stage: 'first',
      ids: ['candidate_00'],
    });
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_99' }),
    ).toThrow(/not in candidate set/i);
  });

  it('rejects selecting on a stage that has no candidates loaded', () => {
    const s = createWorkflowState();
    expect(() =>
      reduceWorkflow(s, { type: 'select', stage: 'first', id: 'candidate_00' }),
    ).toThrow(/not in candidate set/i);
  });
});
