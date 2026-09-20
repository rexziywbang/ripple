import { z } from "zod";

const certainty = z.enum(["explicit", "inferred"]);

/**
 * Bounded action registry. Model or fallback output must map onto one of these
 * operations; anything else is reported as unsupported. Strings here never become
 * executable tools, recipients, or URLs — resolution happens against project data.
 */
export const RequestedChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_attendance"), value: z.number().int().positive(), certainty }),
  z.object({ op: z.literal("set_venue"), venueRef: z.string().min(1), roomRef: z.string().optional(), certainty }),
  z.object({ op: z.literal("cancel_vendor"), vendorRef: z.string().min(1), service: z.enum(["catering", "venue", "equipment", "unknown"]).default("unknown"), certainty }),
  z.object({ op: z.literal("request_quote"), vendorRef: z.string().min(1), service: z.enum(["catering", "venue", "equipment", "unknown"]).default("unknown"), certainty }),
  z.object({ op: z.literal("set_budget_ceiling"), cents: z.number().int().nonnegative(), currency: z.string().default("USD"), certainty }),
  z.object({ op: z.literal("add_dietary_option"), option: z.enum(["vegetarian", "vegan", "halal", "kosher", "gluten_free", "nut_free"]), certainty }),
  z.object({ op: z.literal("shift_schedule"), item: z.enum(["dinner", "event_start", "event_end", "awards", "doors"]), deltaMinutes: z.number().int(), certainty }),
  z.object({ op: z.literal("set_time"), item: z.enum(["dinner", "event_start", "event_end", "awards", "doors"]), time: z.string().regex(/^\d{2}:\d{2}$/), certainty }),
  z.object({ op: z.literal("set_date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), certainty }),
  z.object({ op: z.literal("set_format"), format: z.enum(["seated_dinner", "standing_reception"]), certainty }),
  z.object({ op: z.literal("venue_provides_equipment"), items: z.array(z.string().min(1)).min(1), certainty }),
  z.object({ op: z.literal("staff_unavailable"), count: z.number().int().positive(), names: z.array(z.string()).optional(), certainty }),
  z.object({ op: z.literal("add_equipment"), item: z.string().min(1), quantity: z.number().int().positive().default(1), certainty }),
  z.object({ op: z.literal("unsupported"), text: z.string(), reason: z.string(), certainty }),
]);

export type RequestedChange = z.infer<typeof RequestedChangeSchema>;

export const ChangeIntentSchema = z.object({
  summary: z.string().min(1),
  requestedChanges: z.array(RequestedChangeSchema),
  questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()).optional() })).default([]),
  evidenceNeeded: z.array(z.string()).default([]),
});

export type ChangeIntent = z.infer<typeof ChangeIntentSchema>;

export const INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "requestedChanges", "questions", "evidenceNeeded"],
  properties: {
    summary: { type: "string" },
    requestedChanges: {
      type: "array",
      items: {
        type: "object",
        description:
          "One of: set_attendance{value}, set_venue{venueRef,roomRef?}, cancel_vendor{vendorRef,service}, request_quote{vendorRef,service}, set_budget_ceiling{cents,currency}, add_dietary_option{option}, shift_schedule{item,deltaMinutes}, set_time{item,time}, set_date{date}, set_format{format}, venue_provides_equipment{items}, staff_unavailable{count,names?}, add_equipment{item,quantity}, unsupported{text,reason}",
        properties: {
          op: { type: "string" },
          certainty: { type: "string", enum: ["explicit", "inferred"] },
          value: { type: "number" },
          venueRef: { type: "string" },
          roomRef: { type: "string" },
          vendorRef: { type: "string" },
          service: { type: "string", enum: ["catering", "venue", "equipment", "unknown"] },
          cents: { type: "number" },
          currency: { type: "string" },
          option: { type: "string" },
          item: { type: "string" },
          deltaMinutes: { type: "number" },
          time: { type: "string" },
          date: { type: "string" },
          format: { type: "string", enum: ["seated_dinner", "standing_reception"] },
          items: { type: "array", items: { type: "string" } },
          count: { type: "number" },
          names: { type: "array", items: { type: "string" } },
          quantity: { type: "number" },
          text: { type: "string" },
          reason: { type: "string" },
        },
        required: ["op", "certainty"],
      },
    },
    questions: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["id", "question"] },
    },
    evidenceNeeded: { type: "array", items: { type: "string" } },
  },
} as const;
