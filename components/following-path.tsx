"use client";

import { useEffect, useState } from "react";
import type { WorkflowStage } from "@/lib/db/schema";
import type { WorkflowView } from "@/lib/api/snapshot";

export const PATH: { stage: WorkflowStage; title: string; hint: string }[] = [
  { stage: "understand", title: "Understand", hint: "Reading your request against the event plan" },
  { stage: "check_sources", title: "Check sources", hint: "Cross-checking documents, emails and quotes" },
  { stage: "follow_consequences", title: "Follow consequences", hint: "Tracing what else this changes" },
  { stage: "prepare_updates", title: "Prepare updates", hint: "Drafting updates and messages for review" },
  { stage: "review", title: "Ready to review", hint: "Nothing applied until you approve" },
];

export type StepState = "done" | "active" | "todo" | "failed";

export function stageState(wf: WorkflowView, stage: WorkflowStage): StepState {
  const t = wf.tasks.find((x) => x.kind === "stage" && x.stage === stage);
  if (!t) return "todo";
  if (t.status === "succeeded") return "done";
  if (t.status === "failed") return "failed";
  if (t.status === "running") return "active";
  return "todo";
}

export function pathSteps(wf: WorkflowView) {
  const past = ["executing", "waiting_external", "partially_complete", "completed"].includes(wf.status);
  return PATH.map((p) => {
    const st = stageState(wf, p.stage);
    const done = st === "done" || (past && p.stage === "review");
    const active = st === "active" || (wf.status === "ready_for_review" && p.stage === "review") || (wf.status === "needs_input" && p.stage === "understand");
    return { ...p, done, active, failed: st === "failed", task: wf.tasks.find((x) => x.kind === "stage" && x.stage === p.stage) };
  });
}

const STEP_MS = 650;

/** Whether a workflow is young enough that the organizer is still watching it being worked on. */
export function isFresh(wf: WorkflowView): boolean {
  return wf.status === "planning" || Date.now() - wf.createdAt < 10_000;
}

/**
 * The path Ripple walks while it works: numbered circles light up in turn and become checkmarks.
 * Driven by real task state; a step is never shown done before the worker finished it. Because the
 * worker often finishes in milliseconds, completed steps are revealed one at a time so the organizer
 * can follow along. `onSettled` fires once the display has caught up with a workflow that has stopped planning.
 */
export function FollowingPath({ wf, onSettled }: { wf: WorkflowView; onSettled?: () => void }) {
  const real = pathSteps(wf);
  const realDone = real.filter((s) => s.done).length;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown < realDone) {
      const t = setTimeout(() => setShown((n) => n + 1), STEP_MS);
      return () => clearTimeout(t);
    }
    if (wf.status !== "planning" && onSettled) {
      const t = setTimeout(onSettled, STEP_MS);
      return () => clearTimeout(t);
    }
  }, [shown, realDone, wf.status, onSettled]);

  const steps = real.map((s, i) => ({ ...s, done: s.done && i < shown }));
  const firstPending = steps.findIndex((s) => !s.done);
  const current = steps.find((s) => s.failed) ?? (firstPending >= 0 ? steps[firstPending] : null);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section aria-label="Following the change" className="rounded-xl border border-border bg-background p-4">
      <p className="text-sm font-semibold">Following the change</p>
      <p className="truncate text-xs text-muted" title={wf.request}>
        “{wf.request}”
      </p>
      <ol className="path mt-4">
        {steps.map((s, i) => {
          const state: StepState = s.failed ? "failed" : s.done ? "done" : i === firstPending ? "active" : "todo";
          return (
            <li key={s.stage} data-state={state} aria-current={state === "active" ? "step" : undefined} className="path-step">
              <span className="path-node" aria-hidden>
                {state === "done" ? (
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8.5l3 3 7-7" />
                  </svg>
                ) : state === "failed" ? (
                  "!"
                ) : (
                  i + 1
                )}
              </span>
              <span className="path-label">{s.title}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <p className="min-w-0 truncate text-muted" aria-live="polite">
          {current ? (current.task?.status === "running" || current.failed ? (current.task?.detail ?? current.hint) : current.hint) : "Done"}
        </p>
        <span className="shrink-0 tabular-nums text-muted">
          {doneCount}/{steps.length}
        </span>
      </div>
    </section>
  );
}
