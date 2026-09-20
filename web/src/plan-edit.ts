import type { Area, EditRequest, FactPatch } from "../../shared/types";

/** Free-entry venue edits check planning records; explicit place identity/address stays authoritative. */
export function buildPlanEdit(area: Area, patch: FactPatch): EditRequest {
  return {
    area,
    patch,
    ...(area === "venue" && typeof patch.venue === "string" && patch.venue.trim() && !("venueAddress" in patch)
      ? { note: `The venue changed to ${JSON.stringify(patch.venue)}. Use a matching proposal in the planning records to update associated venue details; preserve unrelated values. If no matching proposal supports the details, keep them unchanged and identify what needs confirmation.` }
      : {}),
  };
}
