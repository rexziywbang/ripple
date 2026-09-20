import { parseDollarsToCents } from "@/lib/domain/money";
import type { ChangeIntent, RequestedChange } from "./intent";

export type InterpreterVocabulary = {
  vendorNames: string[];
  venueNames: string[];
  staffNames?: string[];
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDate(text: string): string | null {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dm = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i) ?? text.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  if (!dm) return null;
  const [d, mth, y] = /^\d/.test(dm[1]) ? [dm[1], dm[2], dm[3]] : [dm[2], dm[1], dm[3]];
  return `${y}-${String(MONTHS.indexOf(mth.toLowerCase()) + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };

function num(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function splitClauses(request: string): string[] {
  return request
    .replace(/\s+/g, " ")
    .split(/(?:\.\s+|;\s*|\s+and\s+(?=(?:then\s+)?[a-z]))/i)
    .map((c) => c.replace(/^then\s+/i, "").replace(/[.\s]+$/g, "").trim())
    .filter(Boolean);
}

function dietaryOption(text: string): RequestedChange | null {
  const m = text.match(/\b(vegetarian|vegan|halal|kosher|gluten[- ]?free|nut[- ]?free)\b/i);
  if (!m) return null;
  const option = m[1].toLowerCase().replace(/[- ]/g, "_") as "vegetarian" | "vegan" | "halal" | "kosher" | "gluten_free" | "nut_free";
  return { op: "add_dietary_option", option, certainty: "explicit" };
}

function extractVendorRef(text: string, vocab: InterpreterVocabulary): string | null {
  const lower = text.toLowerCase();
  for (const name of vocab.vendorNames) {
    const tokens = name.toLowerCase().split(/\s+/);
    if (lower.includes(name.toLowerCase()) || lower.includes(tokens[0])) return name;
  }
  return null;
}

function scheduleItem(text: string): "dinner" | "event_start" | "event_end" | "awards" | "doors" {
  const l = text.toLowerCase();
  if (/awards?|speech/.test(l)) return "awards";
  if (/doors|reception|start of the event|event start|whole event|everything/.test(l)) return "event_start";
  if (/close|end/.test(l)) return "event_end";
  return "dinner";
}

/**
 * "Demo reasoning": a deterministic, clearly-labelled interpreter used when no LLM key is
 * configured. It handles multiple clauses across every planning area and explains what it
 * cannot interpret rather than guessing.
 */
export function interpretDeterministically(request: string, vocab: InterpreterVocabulary): ChangeIntent {
  const changes: RequestedChange[] = [];
  const questions: ChangeIntent["questions"] = [];
  const evidenceNeeded: string[] = [];
  const clauses = splitClauses(request);

  for (const clause of clauses) {
    const c = clause.trim();
    const l = c.toLowerCase();
    let matched = false;

    const attendance = l.match(/(?:attendance|guests?|headcount|attendees|guest count|rsvps?)\D{0,25}?(\d{2,4})\b/) ?? l.match(/(\d{2,4})\s+(?:guests|attendees|people)/);
    if (attendance && /attend|guest|headcount|people|rsvp/.test(l) && !/budget|\$/.test(l)) {
      changes.push({ op: "set_attendance", value: Number(attendance[1]), certainty: "explicit" });
      matched = true;
    }

    const budget = l.match(/budget\D{0,30}?\$?\s?([\d,]+(?:\.\d+)?k?)/) ?? l.match(/\$\s?([\d,]+(?:\.\d+)?k?)\s*(?:total\s+)?budget/);
    if (budget && /budget/.test(l)) {
      const cents = parseDollarsToCents(budget[1]);
      if (cents !== null) {
        changes.push({ op: "set_budget_ceiling", cents, currency: "USD", certainty: "explicit" });
        matched = true;
      }
    }

    if (/cancel|drop|stop using|no longer use|terminate/.test(l) && /cater|vendor|order|booking|venue|hall|hotel|rental|from\b|with\b/.test(l) && !/no longer work|no longer available/.test(l)) {
      const vendorRef = extractVendorRef(c, vocab) ?? extractVendorRef(c, { vendorNames: vocab.venueNames, venueNames: [] }) ?? c.match(/(?:from|with)\s+([A-Z][\w&' -]+?)(?:\s+(?:and|instead)|$)/)?.[1] ?? null;
      if (vendorRef) {
        changes.push({ op: "cancel_vendor", vendorRef, service: /cater/.test(l) ? "catering" : /venue|hall|hotel/.test(l) ? "venue" : /av|rental|equipment/.test(l) ? "equipment" : "unknown", certainty: "explicit" });
        matched = true;
      } else {
        questions.push({ id: `q_cancel_${questions.length}`, question: `Which vendor should be cancelled? I could not match a vendor name in “${c}”.`, options: vocab.vendorNames });
        matched = true;
      }
    }

    if (/contact|reach out|ask|get a quote|request a quote|quote from|instead|switch to|replace(?:ment)? (?:with|by)|use\b/.test(l) && !/venue has changed|venue is now|move(?:d)? (?:the )?(?:event|venue)/.test(l)) {
      const vendorRef = extractVendorRef(c, vocab);
      const alreadyCancelled = changes.some((ch) => ch.op === "cancel_vendor" && ch.vendorRef === vendorRef);
      if (vendorRef && !alreadyCancelled && !/cancel/.test(l.split(vendorRef.toLowerCase().split(" ")[0])[0] ?? "")) {
        changes.push({ op: "request_quote", vendorRef, service: /cater|menu|food/.test(l) || changes.some((ch) => ch.op === "cancel_vendor" && ch.service === "catering") ? "catering" : "unknown", certainty: "explicit" });
        matched = true;
      } else if (!vendorRef && /contact|quote|instead|switch to/.test(l)) {
        const target = c.match(/(?:contact|to|from)\s+([A-Z][\w&' -]+)/)?.[1];
        if (target) {
          changes.push({ op: "request_quote", vendorRef: target.trim(), service: "unknown", certainty: "inferred" });
          matched = true;
        }
      }
    }

    if (/venue|hotel|hall|location|move (?:the )?event to/.test(l) && /chang|now|move|switch|new|is\b|to\b/.test(l) && !/provide|include|microphone|projector|capacity/.test(l) && !matched) {
      const ref = c.match(/(?:to|is now|now|at)\s+(?:the\s+)?([A-Z][\w&' -]+?)(?:\s+(?:hotel|hall|centre|center))?\s*$/i)?.[1] ?? extractVendorRef(c, { vendorNames: vocab.venueNames, venueNames: [] });
      if (ref) {
        changes.push({ op: "set_venue", venueRef: ref.trim(), certainty: "explicit" });
        matched = true;
      }
    }

    if (/venue|hotel|hall/.test(l) && /provide|provid|include|supplie|suppl|has|comes with|offers|will bring/.test(l) && /microphone|projector|screen|\bpa\b|speaker|lectern|\bav\b|sound|stage|audio|equipment/.test(l)) {
      const items: string[] = [];
      if (/microphone|mics?/.test(l)) items.push("wireless microphones");
      if (/projector/.test(l)) items.push("projector");
      if (/screen/.test(l)) items.push("screen");
      if (/\bpa\b|speaker|sound system/.test(l)) items.push("PA system");
      if (/lectern|podium/.test(l)) items.push("lectern");
      if (/stage/.test(l)) items.push("stage");
      if (!items.length && /\bav\b|audio|equipment/.test(l)) items.push("projector", "screen", "PA system", "wireless microphones", "lectern");
      if (items.length) {
        changes.push({ op: "venue_provides_equipment", items, certainty: "explicit" });
        matched = true;
      }
    }

    const staffM = l.match(/(\w+)\s+(?:staff(?: members?)?|crew|volunteers?)\s+(?:are |is )?(?:no longer|not|un)?\s*(?:available|dropped out|cancelled|out|sick)/) ?? l.match(/lost\s+(\w+)\s+staff/);
    if (staffM && /staff|crew|volunteer/.test(l)) {
      const count = num(staffM[1]);
      if (count) {
        changes.push({ op: "staff_unavailable", count, certainty: "explicit" });
        matched = true;
      }
    } else if (/no longer work|can't work|cannot work|unavailable|dropped out|pulled out|is out|is sick|called in sick|can't make it|cannot make it/.test(l)) {
      const names = (vocab.staffNames ?? []).filter((n) => l.includes(n.toLowerCase()) || l.includes(n.toLowerCase().split(" ")[0]));
      if (names.length) {
        changes.push({ op: "staff_unavailable", count: names.length, names, certainty: "explicit" });
        matched = true;
      } else if (/work|shift|event|staff|crew|volunteer/.test(l) && (vocab.staffNames?.length ?? 0) > 0) {
        questions.push({ id: "staff_name", question: "I could not match that name to anyone on the staff roster. Who is no longer available?", options: vocab.staffNames });
        matched = true;
      }
    }

    if (/standing reception|cocktail|standing/.test(l) && /instead|change|switch|make it|become/.test(l)) {
      changes.push({ op: "set_format", format: "standing_reception", certainty: "explicit" });
      matched = true;
    } else if (/seated dinner|sit[- ]down|seated/.test(l) && /instead|change|switch|back to|make it/.test(l)) {
      changes.push({ op: "set_format", format: "seated_dinner", certainty: "explicit" });
      matched = true;
    }

    const shift = l.match(/(?:move|push|bring|shift|delay)\s+(?:the\s+)?([\w\s]+?)\s+(back|forward|later|earlier|up)\s+(?:by\s+)?(\w+)\s*(hours|hour|minutes|minute|mins|min)/) ?? l.match(/(?:move|push|bring|shift|delay)\s+(?:the\s+)?([\w\s]+?)\s+(?:by\s+)?(\w+)\s*(hours|hour|minutes|minute|mins|min)\s*(back|forward|later|earlier)?/);
    if (shift) {
      const item = scheduleItem(shift[1]);
      let direction: string;
      let amountRaw: string;
      let unit: string;
      if (/^(back|forward|later|earlier|up)$/.test(shift[2])) {
        direction = shift[2];
        amountRaw = shift[3];
        unit = shift[4];
      } else {
        amountRaw = shift[2];
        unit = shift[3];
        direction = shift[4] ?? (/delay|push/.test(l) ? "later" : "earlier");
      }
      const amount = num(amountRaw);
      if (amount) {
        const minutes = /hour/.test(unit) ? amount * 60 : amount;
        const sign = /back|later|delay/.test(direction) ? 1 : -1;
        changes.push({ op: "shift_schedule", item, deltaMinutes: sign * minutes, certainty: "explicit" });
        matched = true;
      }
    }
    const setTime = l.match(/(dinner|doors|awards|event|reception)\D{0,20}?(?:at|to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (setTime && /start|move|change|serve|at\b|to\b/.test(l) && !shift && !isoDate(c)) {
      let h = Number(setTime[2]);
      const mm = setTime[3] ?? "00";
      if (setTime[4] === "pm" && h < 12) h += 12;
      if (setTime[4] === "am" && h === 12) h = 0;
      if (!setTime[4] && h < 12 && h >= 1 && h <= 11) h += 12;
      changes.push({ op: "set_time", item: scheduleItem(setTime[1]), time: `${String(h).padStart(2, "0")}:${mm}`, certainty: setTime[4] ? "explicit" : "inferred" });
      matched = true;
    }

    const dateStr = /date|move|change|reschedul|postpone|bring (?:the )?event/.test(l) && !shift ? isoDate(c) : null;
    if (dateStr) {
      changes.push({ op: "set_date", date: dateStr, certainty: "explicit" });
      matched = true;
    }

    const diet = dietaryOption(c);
    if (diet && /add|option|offer|include|need|require|provide/.test(l) && !/venue|projector|microphone/.test(l)) {
      changes.push(diet);
      matched = true;
    }

    const equip = l.match(/add\s+(\w+)\s+(?:extra\s+|more\s+|additional\s+)?([\w\s-]+?)(?:\s+to the (?:rental|order|equipment))?$/);
    if (equip && /microphone|speaker|projector|screen|table|chair|heater|lectern|light/.test(l) && !/venue|provide/.test(l)) {
      const qty = num(equip[1]) ?? 1;
      changes.push({ op: "add_equipment", item: equip[2].trim(), quantity: qty, certainty: "explicit" });
      matched = true;
    }

    if (!matched) {
      changes.push({
        op: "unsupported",
        text: c,
        reason:
          "Demo reasoning could not map this to a supported change. Supported changes: attendance, budget ceiling, venue, vendor cancellation or quote request, dietary options, schedule shifts, event format, venue-provided equipment, staff availability, and extra equipment.",
        certainty: "explicit",
      });
    }
  }

  const supported = changes.filter((c) => c.op !== "unsupported");
  const summary = supported.length
    ? supported.map(describeChange).join("; ")
    : "No supported change could be interpreted from this request.";
  return { summary, requestedChanges: changes, questions, evidenceNeeded };
}

export function describeChange(c: RequestedChange): string {
  switch (c.op) {
    case "set_attendance":
      return `Set expected attendance to ${c.value}`;
    case "set_venue":
      return `Change venue to ${c.venueRef}${c.roomRef ? ` (${c.roomRef})` : ""}`;
    case "cancel_vendor":
      return `Cancel ${c.service === "unknown" ? "engagement" : c.service} with ${c.vendorRef}`;
    case "request_quote":
      return `Request a ${c.service === "unknown" ? "" : c.service + " "}quote from ${c.vendorRef}`;
    case "set_budget_ceiling":
      return `Set the budget ceiling to $${(c.cents / 100).toLocaleString("en-US")}`;
    case "add_dietary_option":
      return `Add a ${c.option.replace("_", "-")} option`;
    case "shift_schedule":
      return `Move the ${c.item.replace("_", " ")} ${c.deltaMinutes > 0 ? "later" : "earlier"} by ${Math.abs(c.deltaMinutes)} minutes`;
    case "set_time":
      return `Set the ${c.item.replace("_", " ")} time to ${c.time}`;
    case "set_date":
      return `Move the event date to ${c.date}`;
    case "set_format":
      return `Change the format to ${c.format === "standing_reception" ? "a standing reception" : "a seated dinner"}`;
    case "venue_provides_equipment":
      return `Venue now provides ${c.items.join(", ")}`;
    case "staff_unavailable":
      return `${c.count} staff member${c.count === 1 ? "" : "s"} no longer available`;
    case "add_equipment":
      return `Add ${c.quantity} × ${c.item}`;
    case "unsupported":
      return `Unsupported: “${c.text}”`;
  }
}
