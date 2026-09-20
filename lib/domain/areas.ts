export type AreaId = "venue" | "guests" | "catering" | "budget" | "staff" | "equipment" | "brief";

export type AreaDef = {
  id: AreaId;
  title: string;
  short: string;
  description: string;
  factKeys: string[];
  examples: string[];
  folder?: string;
};

export const AREAS: AreaDef[] = [
  {
    id: "brief",
    title: "Event brief, date, and format",
    short: "Brief",
    description: "Purpose, date, time, timezone, and meal format.",
    factKeys: ["event.name", "event.date", "event.time", "event.timezone", "event.format", "event.programme"],
    examples: ["Move the dinner back one hour.", "Change to a standing reception instead of a seated dinner."],
    folder: "01 Brief",
  },
  {
    id: "venue",
    title: "Venue and capacity",
    short: "Venue",
    description: "Property, room, capacity, availability, access, and included equipment.",
    factKeys: ["venue.name", "venue.room", "venue.address", "venue.seated_capacity", "venue.standing_capacity", "venue.availability", "venue.included_av", "venue.delivery_access"],
    examples: ["The venue has changed to Marriott Hotel.", "Increase attendance to 300 and add a vegetarian option."],
    folder: "02 Venue",
  },
  {
    id: "guests",
    title: "Guests and invitations",
    short: "Guests",
    description: "Attendance, RSVP status, dietary totals, and invitation content.",
    factKeys: ["attendance.expected", "guests.rsvp_accepted", "guests.dietary_vegetarian", "invitation.text"],
    examples: ["Increase attendance to 300 and add a vegetarian option.", "Reduce attendance to 240."],
    folder: "05 Guests",
  },
  {
    id: "catering",
    title: "Catering and vendors",
    short: "Catering",
    description: "Vendor engagements, quotes, deposits, dietary coverage, and service timing.",
    factKeys: ["catering.vendor", "catering.unit_cents", "catering.dietary_options", "catering.service_start"],
    examples: ["Cancel catering from Shah Halal and contact CAVA instead.", "Add a vegan option."],
    folder: "03 Vendors",
  },
  {
    id: "budget",
    title: "Budget",
    short: "Budget",
    description: "Ceiling, forecast, committed and sunk costs, variance.",
    factKeys: ["budget.ceiling_cents"],
    examples: ["Reduce the total budget to $15,000.", "Increase the budget to $20,000."],
    folder: "04 Budget",
  },
  {
    id: "staff",
    title: "Staff and schedule",
    short: "Staff",
    description: "Coverage policy, roster availability, and run-of-show timings.",
    factKeys: ["staffing.policy", "staffing.required", "staffing.available", "schedule.dinner_start"],
    examples: ["Two staff members are no longer available.", "Move the dinner back one hour."],
    folder: "06 Staff",
  },
  {
    id: "equipment",
    title: "Equipment and logistics",
    short: "Equipment",
    description: "AV, rentals, venue inclusions, delivery windows, and crew instructions.",
    factKeys: ["equipment.av_rental", "equipment.av_vendor", "equipment.delivery_window"],
    examples: ["The venue now provides microphones and a projector.", "Add two extra wireless microphones."],
    folder: "07 Equipment",
  },
];

export const AREA_BY_ID = Object.fromEntries(AREAS.map((a) => [a.id, a])) as Record<AreaId, AreaDef>;

export function areaForFactKey(key: string): AreaId {
  for (const a of AREAS) if (a.factKeys.includes(key)) return a.id;
  const prefix = key.split(".")[0];
  const map: Record<string, AreaId> = {
    event: "brief",
    venue: "venue",
    attendance: "guests",
    guests: "guests",
    invitation: "guests",
    catering: "catering",
    budget: "budget",
    staffing: "staff",
    schedule: "staff",
    equipment: "equipment",
  };
  return map[prefix] ?? "brief";
}
