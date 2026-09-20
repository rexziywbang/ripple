import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Stage, Workflow } from "../shared/types";
import WorkflowProgress, { advanceWorkflowFrame, completedWorkflowStages, createWorkflowFrame, WORKFLOW_HANDOFF_MS, WORKFLOW_SEQUENCE_MS, WORKFLOW_STEP_DWELL_MS, workflowHandoffDelay, workflowPath, workflowStepDwellMs } from "../web/src/WorkflowProgress";

const stages: Stage[] = [
  { label: "Read the event details", status: "done" },
  { label: "Understand the change", status: "running" },
  { label: "Check dependent arrangements", status: "pending" },
  { label: "Prepare updates for review", status: "pending" },
];
const workflow: NonNullable<Workflow> = { id: "change-1", status: "planning", summary: "Checking the venue change", stages };

describe("workflow progress", () => {
  it("uses only the actual four checks rather than inventing extra reference nodes", () => {
    const layout = workflowPath(stages);
    expect(layout.points).toHaveLength(4);
    expect(layout.segments).toHaveLength(3);
    expect(layout.points.map(({ x, y }) => [x, y])).toEqual([[96, 27], [624, 27], [624, 114], [96, 114]]);
  });

  it("turns six real checks into a two-row consequence path", () => {
    const layout = workflowPath([...stages, ...stages.slice(0, 2)]);
    expect(layout.points.map(({ x, y }) => [x, y])).toEqual([[96, 27], [360, 27], [624, 27], [624, 114], [360, 114], [96, 114]]);
    expect(layout.segments[2].path).toContain("Q 720");
    expect(layout.segments[3].path).toBe("M 624 114 H 360");
  });

  it("animates only the connection to the actual running stage", () => {
    const layout = workflowPath(stages);
    expect(layout.segments.map(({ active, done }) => ({ active, done }))).toEqual([
      { active: true, done: false }, { active: false, done: false }, { active: false, done: false },
    ]);
    expect(workflowPath(stages.map(stage => ({ ...stage, status: "done" }))).segments.every(segment => segment.done && !segment.active)).toBe(true);
  });

  it("does not report a pending prerequisite as complete or flowing", () => {
    const layout = workflowPath([{ label: "First", status: "pending" }, { label: "Second", status: "running" }]);
    expect(layout.segments[0]).toMatchObject({ done: false, active: false });
  });

  it("keeps geometry and height stable as backend statuses advance", () => {
    const initial = workflowPath(stages);
    const complete = workflowPath(stages.map(stage => ({ ...stage, status: "done" })));
    expect(complete.height).toBe(initial.height);
    expect(complete.points.map(({ x, y }) => [x, y])).toEqual(initial.points.map(({ x, y }) => [x, y]));
    expect(complete.segments.map(segment => segment.path)).toEqual(initial.segments.map(segment => segment.path));
  });

  it("draws one continuous snake with increasing stops through its bend", () => {
    const layout = workflowPath(stages);
    expect(layout.path.match(/\bM\b/g)).toHaveLength(1);
    expect(layout.path).toContain('Q 720');
    expect(layout.stops).toHaveLength(stages.length);
    expect(layout.stops[0]).toBe(0);
    expect(layout.stops.at(-1)).toBe(1);
    expect(layout.stops.every((stop, index) => index === 0 || stop > layout.stops[index - 1])).toBe(true);
  });

  it("travels to each completed check before activating its completion and never runs ahead", () => {
    const initial = createWorkflowFrame(workflow.id, 4, 0);
    expect(initial).toMatchObject({ completed: 0, target: 1 });
    expect(advanceWorkflowFrame(initial, workflow.id, 4, WORKFLOW_STEP_DWELL_MS - 1)).toBe(initial);
    const first = advanceWorkflowFrame(initial, workflow.id, 4, WORKFLOW_STEP_DWELL_MS);
    expect(first).toMatchObject({ completed: 1, target: 2 });
    const second = advanceWorkflowFrame(first, workflow.id, 4, first.nextAt);
    expect(second).toMatchObject({ completed: 2, target: 3 });
    expect(advanceWorkflowFrame(second, workflow.id, 4, second.nextAt - 1)).toBe(second);
    const third = advanceWorkflowFrame(second, workflow.id, 4, second.nextAt);
    expect(third.completed).toBe(3);
    const clamped = advanceWorkflowFrame(third, workflow.id, 3, third.nextAt + 10000);
    expect(clamped).toMatchObject({ completed: 3, target: 3 });
    expect(advanceWorkflowFrame(clamped, workflow.id, 3, clamped.nextAt + 10000)).toBe(clamped);
    expect(completedWorkflowStages([{ label: 'Not finished', status: 'running' }, { label: 'Later check', status: 'done' }])).toBe(0);
  });

  it("resets for a new workflow, clamps regressions, and skips dwell for reduced motion", () => {
    const frame = { key: workflow.id, completed: 3, target: 4, nextAt: 10000 };
    expect(advanceWorkflowFrame(frame, 'new-change', 4, 20)).toMatchObject({ key: 'new-change', completed: 0, target: 1 });
    expect(advanceWorkflowFrame(frame, workflow.id, 1, 20)).toMatchObject({ completed: 1, target: 1 });
    expect(advanceWorkflowFrame(frame, workflow.id, 4, 20, true)).toMatchObject({ completed: 4, target: 4 });
    expect(createWorkflowFrame(workflow.id, 4, 0, true).completed).toBe(4);
  });

  it("keeps a fast four- or six-check run visible for six to eight seconds including the landing", () => {
    for (const count of [4, 6]) {
      let frame = createWorkflowFrame(workflow.id, count, 0, false, count);
      let elapsed = 0;
      while (frame.completed < count) {
        expect(workflowHandoffDelay(false, false, frame, count)).toBeNull();
        elapsed = frame.nextAt;
        frame = advanceWorkflowFrame(frame, workflow.id, count, elapsed, false, count);
      }
      expect(Math.abs(elapsed - WORKFLOW_SEQUENCE_MS)).toBeLessThan(count);
      expect(workflowHandoffDelay(false, false, frame, count)).toBe(WORKFLOW_HANDOFF_MS);
      expect(elapsed + WORKFLOW_HANDOFF_MS).toBeGreaterThanOrEqual(6000);
      expect(elapsed + WORKFLOW_HANDOFF_MS).toBeLessThanOrEqual(8000);
    }
  });

  it("gives a late backend result a full journey instead of jumping directly to done", () => {
    let frame = createWorkflowFrame(workflow.id, 1, 0);
    frame = advanceWorkflowFrame(frame, workflow.id, 1, frame.nextAt);
    expect(frame).toMatchObject({ completed: 1, target: 1 });
    const delayed = advanceWorkflowFrame(frame, workflow.id, 2, 12000);
    expect(delayed).toMatchObject({ completed: 1, target: 2, nextAt: 12000 + workflowStepDwellMs(4) });
    expect(advanceWorkflowFrame(delayed, workflow.id, 2, delayed.nextAt - 1)).toBe(delayed);
  });

  it("releases partial terminal checks, failures, and reduced motion without claiming uncompleted stages", () => {
    const frame = { key: workflow.id, completed: 1, target: 2, nextAt: 10000 };
    expect(workflowHandoffDelay(true, false, frame, 2)).toBeNull();
    expect(workflowHandoffDelay(false, false, frame, 2)).toBeNull();
    expect(workflowHandoffDelay(false, true, frame, 2)).toBe(0);
    expect(workflowHandoffDelay(false, false, frame, 2, true)).toBe(0);
    const landed = advanceWorkflowFrame(frame, workflow.id, 2, frame.nextAt);
    expect(landed.completed).toBe(2);
    expect(workflowHandoffDelay(false, false, landed, 2)).toBe(WORKFLOW_HANDOFF_MS);
  });

  it("renders real stage labels and accessible statuses without invented percentage", () => {
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { workflow }));
    for (const stage of stages) expect(html).toContain(stage.label);
    expect(html).toContain("— running");
    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("Ready for your review");
  });

  it("continues the visual sequence when review is already prepared and hides the path for an old wait", () => {
    const settled = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: { ...workflow, status: "review", stages: stages.map(stage => ({ ...stage, status: 'done' as const })) }, settled: true, hasDecisions: true }));
    expect(settled).toContain("Following the change through your plan");
    expect(settled).not.toContain("Ready for your review");
    expect(settled).not.toContain('class="wp-stage wp-done"');
    const waiting = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: { ...workflow, status: "waiting", summary: "Waiting for the caterer’s quote" } }));
    expect(waiting).toContain("Waiting for the caterer’s quote");
    expect(waiting).toMatch(/class="wp-map" style="height:0;[^\"]*" aria-hidden="true"/);
  });

  it("shows a concise failure without exposing raw diagnostics or claiming a successful check", () => {
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: { ...workflow, status: "failed", error: "Lookup failed <try again>" } }));
    expect(html).toContain("Some checks couldn’t finish");
    expect(html).not.toContain("Lookup failed");
    expect(html).toMatch(/class="wp-map" style="height:0;[^\"]*" aria-hidden="true"/);
    const partial = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: { ...workflow, status: 'review', error: 'Local budget diagnostic' }, settled: true }));
    expect(partial).toContain("Some checks couldn’t finish");
    expect(partial).not.toContain('Related details checked');
    expect(partial).not.toContain('Local budget diagnostic');
  });

  it("does not reflow existing checks when a vendor wait is appended", () => {
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: { ...workflow, status: 'review', stages: [...stages.map(stage => ({ ...stage, status: 'done' as const })), { label: 'Waiting for a vendor', status: 'waiting' }] }, settled: true }));
    expect(html.match(/class="wp-stage wp-(running|pending)"/g)).toHaveLength(4);
    expect(html.match(/ — done/g)).toHaveLength(4);
    expect(html).not.toContain('Waiting for a vendor');
  });

  it("keeps completed guest updates reviewable when the additional AI review is unavailable", () => {
    const partial = { ...workflow, status: 'review' as const, stages: stages.map(stage => ({ ...stage, status: 'done' as const })), error: 'Local budget diagnostic' };
    const html = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: partial, hasDecisions: true }));
    expect(html).toContain('Updates ready · AI review unavailable');
    expect(html).not.toContain('Some checks couldn’t finish');
    expect(html).not.toContain('Local budget diagnostic');
    const animating = renderToStaticMarkup(createElement(WorkflowProgress, { workflow: partial, settled: true, hasDecisions: true }));
    expect(animating).toContain('Following the change through your plan');
    expect(animating).toContain('wp-map is-visible');
  });
});
