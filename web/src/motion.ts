import { flushSync } from "react-dom";

let current: ViewTransition | undefined;

/** Keep the outgoing surface until its replacement is ready; form edits stay immediate. */
export function changeSurface(update: () => void) {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  current?.skipTransition();
  current = document.startViewTransition(() => flushSync(update));
  void current.finished.catch(() => {});
}
