import type { ProjectState } from "../../shared/types";

/** Keep failures in the audit history, but stop resurfacing resolved checks as current work. */
export function recentPlanningActivity(state: Pick<ProjectState, "activity" | "workflow">) {
  const workflow = state.workflow;
  const checksSucceeded = !!workflow && ["review", "waiting", "complete"].includes(workflow.status) && !workflow.error && !workflow.canRetry;
  const failedCheckTitles = new Set(["Extra detail checking paused", "Could not finish checking the change"]);
  const visible = state.activity.filter(item => !item.automatic && !(checksSucceeded && item.status === "attention" && failedCheckTitles.has(item.title)));
  return visible.reduce<typeof visible>((result, item) => {
    const previous = result.at(-1);
    const elapsed = previous ? Math.abs(Date.parse(previous.at) - Date.parse(item.at)) : Infinity;
    const previousUndoable = !!previous?.canUndo && !!previous.changeId;
    const itemUndoable = !!item.canUndo && !!item.changeId;
    // A local fact and its action receipt can share a title a moment apart.
    // Keep the useful Undo entry in this compact list, retaining both in Activity.
    if (previous?.title === item.title && elapsed < 5000 && previousUndoable !== itemUndoable) {
      if (itemUndoable) result[result.length - 1] = item;
    } else result.push(item);
    return result;
  }, []);
}
