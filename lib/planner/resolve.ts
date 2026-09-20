import type { Contact, SourceDocument, VendorEngagement } from "@/lib/db/schema";
import type { ProjectContext } from "./context";

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !["the", "and", "hotel", "catering", "hall", "centre", "center", "rentals", "downtown"].includes(t));
}

export type Resolution<T> = { status: "resolved"; value: T } | { status: "ambiguous"; options: T[] } | { status: "unresolved" };

export function resolveEngagement(ctx: ProjectContext, ref: string, service?: string): Resolution<VendorEngagement> {
  const refTokens = tokens(ref);
  const candidates = ctx.engagements.filter((e) => {
    if (service && service !== "unknown" && e.service !== service) return false;
    const nameTokens = tokens(e.vendorName);
    return refTokens.some((t) => nameTokens.some((n) => n.startsWith(t) || t.startsWith(n)));
  });
  if (candidates.length === 1) return { status: "resolved", value: candidates[0] };
  if (candidates.length > 1) {
    const exact = candidates.filter((c) => c.vendorName.toLowerCase() === ref.toLowerCase());
    if (exact.length === 1) return { status: "resolved", value: exact[0] };
    return { status: "ambiguous", options: candidates };
  }
  return { status: "unresolved" };
}

export function contactForEngagement(ctx: ProjectContext, e: VendorEngagement): Contact | undefined {
  return ctx.contacts.find((c) => c.id === e.contactId) ?? ctx.contacts.find((c) => c.organization && tokens(c.organization).some((t) => tokens(e.vendorName).includes(t)));
}

export function resolveVenue(ctx: ProjectContext, ref: string): Resolution<{ engagement: VendorEngagement; document?: SourceDocument }> {
  const res = resolveEngagement(ctx, ref, "venue");
  if (res.status !== "resolved") {
    if (res.status === "ambiguous") return { status: "ambiguous", options: res.options.map((engagement) => ({ engagement, document: venueDocument(ctx, engagement) })) };
    return res;
  }
  return { status: "resolved", value: { engagement: res.value, document: venueDocument(ctx, res.value) } };
}

export function venueDocument(ctx: ProjectContext, e: VendorEngagement): SourceDocument | undefined {
  const nameTokens = tokens(e.vendorName);
  return ctx.documents.find((d) => d.kind === "source" && nameTokens.some((t) => d.path.toLowerCase().includes(t) || d.content.toLowerCase().split("\n")[0].includes(t)));
}

export type VenueFacts = {
  room?: string;
  address?: string;
  seatedCapacity?: number;
  standingCapacity?: number;
  includedAv: string[];
  hireCents?: number;
  depositCents?: number;
  depositTerms?: string;
  availability?: string;
  deliveryAccess?: string;
  kitchenFeeCents?: number;
  dated?: string;
  reference?: string;
  excerpts: Record<string, string>;
};

/** Deterministic extraction of venue facts from a Markdown proposal/quote fixture. */
export function extractVenueFacts(doc: SourceDocument): VenueFacts {
  const out: VenueFacts = { includedAv: [], excerpts: {} };
  const lines = doc.content.split("\n");
  const grab = (label: RegExp, key: keyof VenueFacts["excerpts"] | string) => {
    const line = lines.find((l) => label.test(l));
    if (line) out.excerpts[key] = line.replace(/^-\s*/, "").trim();
    return line;
  };
  const money = (line?: string) => {
    const m = line?.match(/USD\s*([\d,]+(?:\.\d{2})?)/);
    return m ? Math.round(Number(m[1].replace(/,/g, "")) * 100) : undefined;
  };
  const room = grab(/^-\s*Room:/i, "room");
  if (room) out.room = room.split(":")[1].trim();
  const addr = grab(/^-\s*Address:/i, "address");
  if (addr) out.address = addr.split(":")[1].replace(/\(fictional\)/i, "").trim();
  const seated = grab(/^-\s*Seated capacity/i, "seatedCapacity");
  const sm = seated?.match(/(\d{2,4})\s*guests/);
  if (sm) out.seatedCapacity = Number(sm[1]);
  const standing = grab(/^-\s*Standing (?:reception )?capacity/i, "standingCapacity");
  const stm = standing?.match(/(\d{2,4})\s*guests/);
  if (stm) out.standingCapacity = Number(stm[1]);
  const av = grab(/^-\s*(Included AV|AV):/i, "includedAv");
  if (av && !/not included/i.test(av)) {
    out.includedAv = av
      .split(":")
      .slice(1)
      .join(":")
      .split(",")
      .map((x) => x.trim().replace(/^built-in\s+/i, ""))
      .filter(Boolean);
  }
  out.hireCents = money(grab(/^-\s*(Room|Venue) hire/i, "hireCents"));
  const dep = grab(/^-\s*Deposit:/i, "depositCents");
  out.depositCents = money(dep);
  out.depositTerms = dep?.split(":").slice(1).join(":").trim();
  const avail = grab(/^-\s*Availability:/i, "availability");
  if (avail) out.availability = avail.split(":").slice(1).join(":").trim();
  const delivery = grab(/^-\s*Vendor delivery access/i, "deliveryAccess");
  if (delivery) out.deliveryAccess = delivery.split(":").slice(1).join(":").trim();
  const kitchen = delivery?.match(/USD\s*([\d,]+)\s*kitchen fee/i);
  if (kitchen) out.kitchenFeeCents = Number(kitchen[1].replace(/,/g, "")) * 100;
  const dated = grab(/^Dated:/i, "dated");
  if (dated) out.dated = dated.split(":")[1].trim();
  const ref = grab(/reference:/i, "reference");
  if (ref) out.reference = ref.split(":")[1].replace(/\(fictional\)/i, "").trim();
  return out;
}

export function docExcerpt(doc: SourceDocument | undefined, pattern: RegExp): string | undefined {
  if (!doc) return undefined;
  return doc.content.split("\n").find((l) => pattern.test(l))?.replace(/^-\s*/, "").trim();
}

export function findDocument(ctx: ProjectContext, nameFragment: string): SourceDocument | undefined {
  return ctx.documents.find((d) => d.path.toLowerCase().includes(nameFragment.toLowerCase()));
}
