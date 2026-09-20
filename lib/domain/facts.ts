import type { ProjectFact } from "@/lib/db/schema";

export type StaffingPolicy = { perAttendees: number; ratePerStaffCents: number; currency: string; label: string };
export type EventFormat = "seated_dinner" | "standing_reception";

export type FactMap = Record<string, ProjectFact>;

export function factValue<T>(facts: FactMap, key: string): T | undefined {
  const f = facts[key];
  if (!f) return undefined;
  return f.value as T;
}

export function factNumber(facts: FactMap, key: string): number | undefined {
  const v = factValue<unknown>(facts, key);
  return typeof v === "number" ? v : undefined;
}

export function factString(facts: FactMap, key: string): string | undefined {
  const v = factValue<unknown>(facts, key);
  return typeof v === "string" ? v : undefined;
}

export function factStringList(facts: FactMap, key: string): string[] {
  const v = factValue<unknown>(facts, key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function factVersions(facts: FactMap, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = facts[k]?.version ?? 0;
  }
  return out;
}

export function requiredStaff(attendance: number, policy: StaffingPolicy): number {
  if (policy.perAttendees <= 0) return 0;
  return Math.ceil(attendance / policy.perAttendees);
}

export function humanFactKey(key: string): string {
  const names: Record<string, string> = {
    "event.name": "Event name",
    "event.date": "Event date",
    "event.time": "Start time",
    "event.timezone": "Timezone",
    "event.format": "Format",
    "event.programme": "Programme",
    "venue.name": "Venue",
    "venue.room": "Room",
    "venue.address": "Address",
    "venue.seated_capacity": "Seated capacity",
    "venue.standing_capacity": "Standing capacity",
    "venue.availability": "Date availability",
    "venue.included_av": "Included AV",
    "venue.delivery_access": "Delivery access",
    "attendance.expected": "Expected attendance",
    "guests.rsvp_accepted": "RSVPs accepted",
    "guests.dietary_vegetarian": "Vegetarian requests",
    "invitation.text": "Invitation text",
    "catering.vendor": "Caterer",
    "catering.unit_cents": "Per-guest price",
    "catering.dietary_options": "Dietary options",
    "catering.service_start": "Dinner service",
    "budget.ceiling_cents": "Budget ceiling",
    "staffing.policy": "Staffing policy",
    "staffing.required": "Staff required",
    "staffing.available": "Staff available",
    "schedule.dinner_start": "Dinner start",
    "equipment.av_rental": "AV rental items",
    "equipment.av_vendor": "AV vendor",
    "equipment.delivery_window": "AV delivery window",
  };
  return names[key] ?? key;
}

export function formatFactValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (key.endsWith("_cents") && typeof value === "number") {
    return `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: value % 100 ? 2 : 0 })}`;
  }
  if (key === "event.format") return value === "standing_reception" ? "Standing reception" : "Seated dinner";
  if (key === "venue.availability" && typeof value === "object") {
    const v = value as { confirmed: boolean; detail: string };
    return v.confirmed ? `Confirmed — ${v.detail}` : `Not confirmed — ${v.detail}`;
  }
  if (key === "staffing.policy" && typeof value === "object") {
    const p = value as StaffingPolicy;
    return `1 per ${p.perAttendees} guests at $${p.ratePerStaffCents / 100} each (sample policy)`;
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
