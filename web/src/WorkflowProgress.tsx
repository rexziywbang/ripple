import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, CircleAlert, Clock3 } from "lucide-react";
import type { ChangeImpact, Stage, Workflow } from "../../shared/types";
import ChangeRipple from "./ChangeRipple";
import "./workflow-progress.css";

export const WORKFLOW_SEQUENCE_MS = 6200;
export const WORKFLOW_HANDOFF_MS = 650;
export const WORKFLOW_STEP_DWELL_MS = WORKFLOW_SEQUENCE_MS / 4;
export type WorkflowFrame = { key: string; completed: number; target: number; nextAt: number };

export function workflowStepDwellMs(stageCount: number) {
  return Math.round(WORKFLOW_SEQUENCE_MS / Math.max(1, stageCount));
}

export function createWorkflowFrame(key: string, actualCompleted: number, now: number, reducedMotion = false, stageCount = 4): WorkflowFrame {
  return { key, completed: reducedMotion ? actualCompleted : 0, target: reducedMotion ? actualCompleted : Math.min(1, actualCompleted), nextAt: now + workflowStepDwellMs(stageCount) };
}

/** Only an uninterrupted prefix of actual completed checks can fill the path. */
export function completedWorkflowStages(stages: readonly Stage[]) {
  const firstUnfinished = stages.findIndex(stage => stage.status !== "done");
  return firstUnfinished === -1 ? stages.length : firstUnfinished;
}

/** Delay presentation, never completion evidence. Reduced motion follows state immediately. */
export function advanceWorkflowFrame(frame: WorkflowFrame, key: string, actualCompleted: number, now: number, reducedMotion = false, stageCount = 4): WorkflowFrame {
  if (frame.key !== key) return createWorkflowFrame(key, actualCompleted, now, reducedMotion, stageCount);
  if (reducedMotion || actualCompleted < frame.completed || actualCompleted < frame.target) {
    return frame.completed === actualCompleted && frame.target === actualCompleted ? frame
      : { key, completed: actualCompleted, target: actualCompleted, nextAt: now };
  }
  // Start travel only after completion evidence arrives, including a slow backend check.
  if (frame.target === frame.completed && actualCompleted > frame.completed) {
    return { ...frame, target: frame.completed + 1, nextAt: now + workflowStepDwellMs(stageCount) };
  }
  if (frame.target > frame.completed && now >= frame.nextAt) {
    return { key, completed: frame.target, target: Math.min(actualCompleted, frame.target + 1), nextAt: now + workflowStepDwellMs(stageCount) };
  }
  return frame;
}

/** A terminal run may have a partial prefix; never wait for checks it will not complete. */
export function workflowHandoffDelay(active: boolean, failed: boolean, frame: WorkflowFrame, actualCompleted: number, reducedMotion = false) {
  if (active) return null;
  if (failed || reducedMotion) return 0;
  return frame.completed >= actualCompleted ? WORKFLOW_HANDOFF_MS : null;
}

function curveLength(start: [number, number], control: [number, number], end: [number, number]) {
  let length = 0;
  let previous = start;
  for (let step = 1; step <= 24; step++) {
    const t = step / 24;
    const point: [number, number] = [
      (1 - t) ** 2 * start[0] + 2 * (1 - t) * t * control[0] + t ** 2 * end[0],
      (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * control[1] + t ** 2 * end[1],
    ];
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return length;
}

export function workflowPath(stages: readonly Stage[]) {
  const rows = Math.max(1, Math.ceil(stages.length / 3));
  const columns = Math.max(1, Math.ceil(stages.length / rows));
  const points = stages.map((stage, index) => {
    const row = Math.floor(index / columns);
    const position = index % columns;
    const column = row % 2 ? columns - 1 - position : position;
    return { ...stage, x: columns === 1 ? 360 : 96 + column * 528 / (columns - 1), y: 27 + row * 87 };
  });
  const segments = points.slice(1).map((point, at) => {
    const previous = points[at];
    const right = previous.x > 360;
    const edge = right ? 662 : 58;
    const bend = right ? 720 : 0;
    const middle = (previous.y + point.y) / 2;
    const path = previous.y === point.y ? `M ${previous.x} ${previous.y} H ${point.x}`
      : `M ${previous.x} ${previous.y} H ${edge} Q ${bend} ${previous.y} ${bend} ${middle} Q ${bend} ${point.y} ${edge} ${point.y} H ${point.x}`;
    const length = previous.y === point.y ? Math.abs(point.x - previous.x)
      : Math.abs(edge - previous.x) + curveLength([edge, previous.y], [bend, previous.y], [bend, middle])
        + curveLength([bend, middle], [bend, point.y], [edge, point.y]) + Math.abs(point.x - edge);
    return { path, length, done: previous.status === "done" && point.status === "done", active: previous.status === "done" && point.status === "running" };
  });
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let through = 0;
  const stops = [0, ...segments.map(segment => { through += segment.length; return total ? through / total : 0; })];
  // A single unbroken SVG path lets both completion and the loading light travel around bends.
  const path = segments.map((segment, index) => index ? segment.path.replace(/^M [^ ]+ [^ ]+ /, "") : segment.path).join(" ");
  return { points, segments, path, stops, height: 99 + (rows - 1) * 87 };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function WorkflowProgress({ workflow, impact, settled = false, hasDecisions = false, onVisualComplete }: {
  workflow: NonNullable<Workflow>; impact?: ChangeImpact; settled?: boolean; hasDecisions?: boolean; onVisualComplete?: (workflowId: string) => void;
}) {
  const gradient = `workflow-${useId().replaceAll(":", "")}`;
  const reducedMotion = useReducedMotion();
  const active = workflow.status === "planning";
  const waiting = workflow.status === "waiting";
  // Vendor waits are a separate state, not new planning checks that should move existing nodes.
  const stages = workflow.stages.filter(stage => stage.status !== "waiting");
  const partialSuccess = Boolean(workflow.error) && ["review", "complete", "waiting"].includes(workflow.status) && stages.length > 0 && stages.every(stage => stage.status === "done");
  const failed = workflow.status === "failed" || (Boolean(workflow.error) && !partialSuccess);
  const key = workflow.id;
  const actualCompleted = completedWorkflowStages(stages);
  const immediate = reducedMotion || (!active && !settled);
  const dwell = workflowStepDwellMs(stages.length);
  const [frame, setFrame] = useState<WorkflowFrame>(() => createWorkflowFrame(key, actualCompleted, Date.now(), immediate, stages.length));
  useEffect(() => {
    const next = advanceWorkflowFrame(frame, key, actualCompleted, Date.now(), immediate, stages.length);
    if (next !== frame) { setFrame(next); return; }
    if (!immediate && !failed && frame.target > frame.completed) {
      const timer = window.setTimeout(() => setFrame(previous => advanceWorkflowFrame(previous, key, actualCompleted, Date.now(), immediate, stages.length)), Math.max(0, frame.nextAt - Date.now()));
      return () => window.clearTimeout(timer);
    }
  }, [frame, key, actualCompleted, immediate, failed, stages.length]);
  const currentFrame = frame.key === key ? frame : createWorkflowFrame(key, actualCompleted, Date.now(), immediate, stages.length);
  const visibleCompleted = immediate ? actualCompleted : Math.min(currentFrame.completed, actualCompleted);
  const targetCompleted = immediate ? actualCompleted : Math.min(currentFrame.target, actualCompleted);
  const caughtUp = visibleCompleted >= actualCompleted;
  const onComplete = useRef(onVisualComplete);
  onComplete.current = onVisualComplete;
  const notified = useRef<string | null>(null);
  const handoffDelay = workflowHandoffDelay(active, failed, currentFrame, actualCompleted, reducedMotion);
  useEffect(() => {
    if (handoffDelay === null || notified.current === key) return;
    const timer = window.setTimeout(() => {
      notified.current = key;
      onComplete.current?.(key);
    }, handoffDelay);
    return () => window.clearTimeout(timer);
  }, [key, handoffDelay]);
  const layout = workflowPath(stages);
  const progress = targetCompleted > 0 ? layout.stops[targetCompleted - 1] ?? 0 : 0;
  const showPath = !failed && (active || settled) && stages.length > 0;
  const presenting = showPath && !caughtUp;
  const complete = !active && caughtUp && actualCompleted === stages.length;
  const heading = failed ? "Some checks couldn’t finish"
    : active || presenting ? "Following the change through your plan"
    : partialSuccess ? "Updates ready · AI review unavailable"
    : settled && complete ? hasDecisions ? "Ready for your review" : "Related details checked"
    : waiting ? workflow.summary || "Waiting for a reply" : workflow.summary;
  return (
    <section className={`workflow-progress${(active || presenting) && !failed ? " wp-active" : ""}${settled && complete && !failed ? " wp-settled" : ""}${failed ? " wp-failed" : ""}`} aria-label="Planning progress">
      <header className="wp-heading">
        <span className="wp-mark" aria-hidden="true">{failed ? <CircleAlert size={16} /> : settled && complete ? <Check size={16} /> : waiting && !presenting ? <Clock3 size={16} /> : <span />}</span>
        <strong role="status">{heading}</strong>
      </header>
      {impact && showPath ? <ChangeRipple key={impact.id} impact={impact} /> : stages.length > 0 && <div className={`wp-map${showPath ? " is-visible" : ""}`} style={{ height: showPath ? layout.height : 0, "--wp-travel-ms": `${dwell}ms` } as CSSProperties} aria-hidden={!showPath}>
        <svg key={key} className="wp-path" viewBox={`0 0 720 ${layout.height}`} preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="720" y2="0"><stop offset="0%" stopColor="var(--accent, #79566f)" /><stop offset="100%" stopColor="#a07c70" /></linearGradient></defs>
          <path className="wp-track" d={layout.path} />
          <path className="wp-completed wp-completed-glow" d={layout.path} pathLength="1" stroke={`url(#${gradient})`} style={{ strokeDashoffset: 1 - progress }} />
          <path className="wp-completed" d={layout.path} pathLength="1" stroke={`url(#${gradient})`} style={{ strokeDashoffset: 1 - progress }} />
          <path className={`wp-flow${active || presenting ? " is-active" : ""}`} d={layout.path} pathLength="1" />
        </svg>
        <ol className="wp-stages" aria-label="Consequence checks">
          {layout.points.map((stage, index) => {
            const presented = index < visibleCompleted ? "done" : index === visibleCompleted && (stage.status === "done" || stage.status === "running") ? "running" : "pending";
            return <li key={stage.label} className={`wp-stage wp-${presented}`} style={{ left: `${stage.x / 7.2}%`, top: stage.y }}>
              <span className="wp-node" aria-hidden="true"><span className="wp-node-number">{index + 1}</span><Check className="wp-node-check" size={13} /></span>
              <span className="wp-label">{stage.label}<span className="wp-screen-reader"> — {stage.status}</span></span>
            </li>;
          })}
        </ol>
      </div>}
    </section>
  );
}
