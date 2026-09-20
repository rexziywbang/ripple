import { describe, expect, it } from 'vitest';
import type { Activity, ProjectState } from '../shared/types';
import { recentPlanningActivity } from '../web/src/recent-activity';
const failure: Activity = { id: 'failure', at: '2026-09-20T00:00:00Z', title: 'Extra detail checking paused', detail: 'Temporary failure', status: 'attention' };
const workflow: NonNullable<ProjectState['workflow']> = { id: 'check', status: 'review', stages: [], summary: 'Ready', canRetry: false };

describe('compact recent changes', () => {
  it('stops surfacing a resolved planning failure while preserving unrelated delivery attention', () => {
    const mail = { ...failure, id: 'mail', title: 'Email delivery needs attention' };
    const activity = [failure, mail];
    expect(recentPlanningActivity({ activity, workflow })).toEqual([mail]);
    expect(activity).toEqual([failure, mail]);
  });
  it('keeps failed checks visible while retrying or while retry remains available', () => {
    expect(recentPlanningActivity({ activity: [failure], workflow: { ...workflow, status: 'planning' } })).toEqual([failure]);
    expect(recentPlanningActivity({ activity: [failure], workflow: { ...workflow, canRetry: true } })).toEqual([failure]);
    expect(recentPlanningActivity({ activity: [failure], workflow: { ...workflow, error: 'Still failing' } })).toEqual([failure]);
  });
  it('keeps the undoable staffing change instead of its adjacent duplicate receipt', () => {
    const receipt: Activity = { id: 'receipt', at: '2026-09-20T00:00:01Z', title: 'Adjust staffing to 5 people', detail: 'Applied', status: 'complete' };
    const fact: Activity = { ...receipt, id: 'fact', at: '2026-09-20T00:00:00Z', canUndo: true, changeId: 'staff-change' };
    expect(recentPlanningActivity({ activity: [receipt, fact], workflow })).toEqual([fact]);
    expect(recentPlanningActivity({ activity: [fact, receipt], workflow })).toEqual([fact]);
    expect(recentPlanningActivity({ activity: [receipt, { ...fact, at: '2026-09-19T23:55:00Z' }], workflow })).toHaveLength(2);
  });
});
