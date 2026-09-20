import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  LoaderCircle,
  MapPin,
  Monitor,
  Users,
  Utensils,
  Wallet,
} from "lucide-react";
import type { Area, FactPatch, Facts, ProjectState } from "../../shared/types";
import "./inline-plan.css";
import PlaceMatches, { placeSelectionPatch } from "./PlaceMatches";
import type { PlaceMatch } from "./PlaceMatches";

type FieldKind = "text" | "integer" | "money" | "date" | "time" | "timezone";
type ParseResult =
  | { ok: true; value: string | number }
  | { ok: false; error: string };
type FieldOptions = {
  kind?: FieldKind;
  min?: number;
  max?: number;
  optional?: boolean;
};
type InlinePlanProps = {
  state: ProjectState;
  onSave: (area: Area, patch: FactPatch) => Promise<boolean>;
};

/** Parse complete, intentional values only; an empty numeric draft is never zero. */
export function parseInlineValue(
  raw: string,
  options: FieldOptions = {},
): ParseResult {
  const kind = options.kind ?? "text";
  const trimmed = raw.trim();
  if (!trimmed)
    return options.optional && (kind === "text" || kind === "timezone")
      ? { ok: true, value: "" }
      : { ok: false, error: "Add a value to save this change." };
  if (kind === "integer" || kind === "money") {
    const formatted =
      kind === "money" ? trimmed.replace(/^\$\s*/, "") : trimmed;
    const validFormat =
      kind === "integer"
        ? /^(?:\d+|\d{1,3}(?:,\d{3})+)$/
        : /^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?|\.\d{1,2})$/;
    if (!validFormat.test(formatted)) {
      return {
        ok: false,
        error:
          kind === "integer"
            ? "Use a whole number."
            : "Use a price with up to two decimal places.",
      };
    }
    const numeric = formatted.replace(/,/g, "");
    const value =
      kind === "money" ? Math.round(Number(numeric) * 100) : Number(numeric);
    const min = options.min ?? 0;
    const max = options.max ?? 1_000_000_000;
    if (!Number.isSafeInteger(value) || value > max || value < min) {
      return {
        ok: false,
        error:
          kind === "money"
            ? "Enter a valid amount within the supported range."
            : `Use a number from ${min.toLocaleString()} to ${max.toLocaleString()}.`,
      };
    }
    return { ok: true, value };
  }
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
      return { ok: false, error: "Choose a complete event date." };
    const parsed = new Date(`${trimmed}T12:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== trimmed
    )
      return { ok: false, error: "Choose a valid event date." };
  }
  if (kind === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed))
    return { ok: false, error: "Choose a valid time." };
  if (kind === "timezone") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format();
    } catch {
      return { ok: false, error: "Use a time zone such as America/New_York." };
    }
  }
  if (trimmed.length > 8000)
    return { ok: false, error: "Keep this detail under 8,000 characters." };
  return { ok: true, value: trimmed };
}

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);

export function equipmentAllowance(state: Pick<ProjectState, "project" | "sources">) {
  const f = state.project.facts;
  const venuePending = f.venueAVPending ?? f.venueDetailsPending ?? false;
  const included = !venuePending && f.venueIncludesAV && f.equipmentCostCents === 0;
  // This is the scope written in the existing AV record, not an inferred quote.
  // Its listed price must never replace the user's current planning allowance.
  const record = state.sources.find(source => source.id === "equipment-contract" && source.area === "equipment");
  const scope = record?.content.split("\n").map(line => /^([^:$]{1,160}):\s*\$/.exec(line.trim())?.[1].trim()).find(Boolean);
  return {
    value: included ? "Included with venue" : dollars(f.equipmentCostCents),
    status: included ? "AV marked included in the venue plan"
      : venuePending ? "Previous allowance · venue AV unconfirmed" : "Provisional estimate · quote not verified",
    requirements: scope ? `Recorded scope: ${scope}. Check against the event program and venue inclusions.`
      : "Equipment needs checking against venue inclusions and the event program.",
    retainRental: !venuePending && f.venueIncludesAV && f.equipmentCostCents > 0,
  };
}
export function staffingEstimate(facts: Pick<Facts, "staffCount" | "staffCostEachCents">) {
  return {
    value: facts.staffCount === 0 ? "No staff planned" : facts.staffCostEachCents > 0 ? dollars(facts.staffCount * facts.staffCostEachCents) : "Cost to confirm",
    status: facts.staffCostEachCents > 0 ? "Planning estimate · saved staffing rate" : "Staffing rate not yet confirmed",
  };
}
const rawValue = (value: string | number, kind: FieldKind = "text", zeroIsUnset = false) =>
  zeroIsUnset && value === 0 ? "" : kind === "money" ? String(Number(value) / 100) : String(value);
const statusText = (status: Facts["cateringStatus"]) =>
  ({
    not_set: "Caterer not set",
    confirmed: "Confirmed",
    awaiting_quote: "Quote pending",
    quoted: "Quote received · not yet booked",
    awaiting_confirmation: "Waiting for confirmation",
  })[status];

type FieldProps = FieldOptions & {
  label: string;
  field: keyof Facts;
  area: Area;
  value: string | number;
  onSave: InlinePlanProps["onSave"];
  suffix?: string;
  wide?: boolean;
  hideLabel?: boolean;
  multiline?: boolean;
  zeroIsUnset?: boolean;
  placeKind?: "venue" | "catering";
  projectId?:string;
};

/** Each field owns its draft. Incoming snapshots cannot replace active or unsaved typing. */
function InlineField({
  label,
  field,
  area,
  value,
  onSave,
  kind = "text",
  min,
  max,
  optional,
  suffix,
  wide,
  hideLabel,
  multiline,
  zeroIsUnset = false,
  placeKind,
  projectId,
}: FieldProps) {
  const inputId = useId();
  const [showMatches, setShowMatches] = useState(false);
  const [draft, setDraft] = useState(() => rawValue(value, kind, zeroIsUnset));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const draftRef = useRef(draft);
  const savedRef = useRef(value);
  const dirtyRef = useRef(false);
  const focusedRef = useRef(false);
  const editVersion = useRef(0);
  const pendingCount = useRef(0);
  const saveSequence = useRef(0);
  const lastSubmitted = useRef<string | number | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    savedRef.current = value;
    if (pendingCount.current > 0 || focusedRef.current || dirtyRef.current)
      return;
    const next = rawValue(value, kind, zeroIsUnset);
    draftRef.current = next;
    setDraft(next);
  }, [value, kind, zeroIsUnset]);

  async function commit(extraPatch: FactPatch = {}) {
    // Focusing a field is not an edit. A newer server value must not be written
    // back to its old value merely because the user later leaves that field.
    if (!dirtyRef.current) {
      if (pendingCount.current === 0) {
        const current = rawValue(savedRef.current, kind, zeroIsUnset);
        draftRef.current = current;
        setDraft(current);
      }
      return;
    }
    const parsed = parseInlineValue(draftRef.current, {
      kind,
      min,
      max,
      optional,
    });
    if (!parsed.ok) {
      setError(parsed.error);
      setStatus("error");
      return;
    }
    const baseline =
      pendingCount.current > 0 ? lastSubmitted.current : savedRef.current;
    if (parsed.value === baseline && Object.keys(extraPatch).length === 0) {
      if (pendingCount.current === 0) {
        dirtyRef.current = false;
        setStatus("idle");
        setError("");
        const clean = rawValue(parsed.value, kind, zeroIsUnset);
        draftRef.current = clean;
        setDraft(clean);
      }
      return;
    }
    const sequence = ++saveSequence.current;
    const version = editVersion.current;
    pendingCount.current++;
    lastSubmitted.current = parsed.value;
    setStatus("saving");
    setError("");
    let saved = false;
    try {
      saved = await onSave(area, { [field]: parsed.value, ...extraPatch } as FactPatch);
    } catch {
      saved = false;
    }
    pendingCount.current--;
    if (!alive.current) return;
    if (saved) savedRef.current = parsed.value;
    if (sequence !== saveSequence.current) return;
    if (saved) {
      if (editVersion.current === version) {
        const clean = rawValue(parsed.value, kind, zeroIsUnset);
        draftRef.current = clean;
        dirtyRef.current = false;
        setDraft(clean);
        setStatus("saved");
      } else {
        // A previous request finished while the user was typing the next change.
        setStatus(pendingCount.current > 0 ? "saving" : "idle");
      }
    } else {
      lastSubmitted.current = undefined;
      setError("Couldn’t save. Your edit is still here; press Enter to retry.");
      setStatus("error");
    }
  }

  function restore() {
    setShowMatches(false);
    editVersion.current++;
    const restored = rawValue(savedRef.current, kind, zeroIsUnset);
    draftRef.current = restored;
    dirtyRef.current = false;
    setDraft(restored);
    setError("");
    setStatus(pendingCount.current > 0 ? "saving" : "idle");
  }
  function selectPlace(place: PlaceMatch) {
    if (!placeKind) return;
    editVersion.current++;
    draftRef.current = place.name;
    dirtyRef.current = true;
    setDraft(place.name);
    setShowMatches(false);
    void commit(placeSelectionPatch(placeKind, place));
    window.requestAnimationFrame(() => document.getElementById(inputId)?.focus());
  }
  const shared = {
    id: inputId,
    value: draft,
    "aria-label": label,
    placeholder: zeroIsUnset ? "Not set" : optional ? "Add details" : "Not set",
    "aria-invalid": status === "error",
    "aria-describedby": status === "error" ? `${inputId}-status` : undefined,
    onFocus: () => {
      focusedRef.current = true;
    },
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      editVersion.current++;
      draftRef.current = event.target.value;
      dirtyRef.current = true;
      setDraft(event.target.value);
      if (placeKind) setShowMatches(true);
      setError("");
      setStatus(pendingCount.current > 0 ? "saving" : "idle");
    },
    onBlur: () => {
      focusedRef.current = false;
    },
    onKeyDown: (
      event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restore();
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void commit();
      }
    },
  };
  return (
    <div
      className={`ip-field${wide ? " ip-field-wide" : ""}${status === "error" ? " ip-field-error" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          focusedRef.current = false;
          void commit();
          setShowMatches(false);
        }
      }}
    >
      <label className={hideLabel ? "ip-label-hidden" : undefined} htmlFor={inputId}>{label}</label>
      <div className={`ip-input-line${kind === "money" ? " ip-money" : ""}`}>
        {kind === "money" && (
          <span className="ip-currency" aria-hidden="true">
            $
          </span>
        )}
        {multiline ? (
          <textarea {...shared} rows={2} />
        ) : (
          <input
            {...shared}
            type={kind === "date" || kind === "time" ? kind : "text"}
            inputMode={
              kind === "integer"
                ? "numeric"
                : kind === "money"
                  ? "decimal"
                  : undefined
            }
            autoComplete="off"
          />
        )}
        {suffix && <span className="ip-suffix">{suffix}</span>}
      </div>
      <span
        className={`ip-field-status ip-status-${status}`}
        id={`${inputId}-status`}
        role={status === "error" ? "alert" : "status"}
      >
        {status === "saving" ? (
          <>
            <LoaderCircle size={10} className="ip-spin" />
            Saving…
          </>
        ) : status === "error" ? (
          <>
            <CircleAlert size={11} />
            {error}
          </>
        ) : (
          <>&nbsp;</>
        )}
      </span>
      {placeKind && showMatches && <PlaceMatches query={draft} kind={placeKind} projectId={projectId} onSelect={selectPlace} onDismiss={() => { setShowMatches(false); void commit(); window.requestAnimationFrame(() => document.getElementById(inputId)?.focus()); }} />}
    </div>
  );
}

function InlineToggle({
  label,
  area,
  field,
  value,
  onSave,
}: {
  label: string;
  area: Area;
  field: keyof Facts;
  value: boolean;
  onSave: InlinePlanProps["onSave"];
}) {
  const [checked, setChecked] = useState(value);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const sequence = useRef(0);
  const pending = useRef(0);
  const latestSaved = useRef(value);
  useEffect(() => {
    latestSaved.current = value;
    if (!pending.current) setChecked(value);
  }, [value]);
  async function change(next: boolean) {
    setChecked(next);
    setStatus("saving");
    pending.current++;
    const current = ++sequence.current;
    let ok = false;
    try {
      ok = await onSave(area, { [field]: next });
    } catch {
      ok = false;
    }
    pending.current--;
    if (ok) latestSaved.current = next;
    if (current !== sequence.current) return;
    setStatus(ok ? "saved" : "error");
    if (!ok) setChecked(latestSaved.current);
  }
  return (
    <div className="ip-toggle-wrap">
      <label className="ip-toggle">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <span
        className={`ip-field-status ip-status-${status}`}
        role={status === "error" ? "alert" : "status"}
      >
        {status === "saving"
          ? "Saving…"
          : status === "error"
              ? "Couldn’t save. Try again."
              : ""}
      </span>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  tone,
  children,
  details,
  hint,
}: {
  title: string;
  icon: typeof CalendarDays;
  tone: string;
  children: ReactNode;
  details?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <section className="ip-section" aria-label={title}>
      <div className="ip-section-heading">
        <span className={`ip-section-icon ip-tone-${tone}`}>
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <h3>{title}</h3>
      </div>
      <div className="ip-section-content">
        <div className="ip-fields">{children}</div>
        {hint && <div className="ip-section-hint">{hint}</div>}
        {details && (
          <details className="ip-details">
            <summary aria-label={`${title} details`} title={`${title} details`}>
              <ChevronDown size={14} />
            </summary>
            <div className="ip-detail-fields">{details}</div>
          </details>
        )}
      </div>
    </section>
  );
}

export default function InlinePlan({ state, onSave }: InlinePlanProps) {
  const f = state.project.facts;
  const equipment = equipmentAllowance(state);
  const venuePending = "venueDetailsPending" in f && f.venueDetailsPending === true;
  const capacityPending = f.venueCapacityPending ?? venuePending;
  const avPending = f.venueAVPending ?? venuePending;
  const venueEvidence = state.sources.find(source => source.id === f.venueCapacityEvidenceId)?.venueEvidence;
  const currentVenueEvidence = venueEvidence?.name === f.venue && venueEvidence.address === f.venueAddress && venueEvidence.eventFormat === f.format ? venueEvidence : undefined;
  const capacityEvidence = !capacityPending && currentVenueEvidence?.capacity?.guests === f.venueCapacity ? currentVenueEvidence.capacity : undefined;
  const avEvidence = !avPending && currentVenueEvidence?.av?.included === f.venueIncludesAV ? currentVenueEvidence.av : undefined;
  const evidenceLink = (url: string) => {
    try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; }
  };
  const remaining = f.budgetLimitCents - state.budget.totalCents;
  const incomplete = state.budget.lines.some(
    (line) => line.status === "awaiting quote",
  );
  const awaitingCateringQuote = f.cateringStatus === "awaiting_quote";
  const cateringQuote = state.cateringQuote;
  const matchedCateringQuote = cateringQuote?.status === "quoted";
  const cateringLabel = matchedCateringQuote
    ? f.cateringStatus === "confirmed" ? "Confirmed" : f.cateringStatus === "awaiting_confirmation" ? "Booking requested" : "Quoted"
    : cateringQuote?.inquiry === "sent" ? "Quote requested" : cateringQuote?.inquiry === "approved" ? "Request approved" : cateringQuote?.inquiry === "draft" ? "Quote request prepared" : awaitingCateringQuote ? "Quote needed" : "Recorded rate";
  const field = (
    area: Area,
    key: keyof Facts,
    label: string,
    options: Omit<
      FieldProps,
      "area" | "field" | "label" | "value" | "onSave"
    > = {},
  ) => (
    <InlineField
      key={`${state.project.id}-${key}`}
      area={area}
      field={key}
      label={label}
      value={key === "venueAddress" ? f.venueAddress.replace(/\s*\(demo\)$/, "") : f[key] as string | number}
      onSave={onSave}
      projectId={state.project.id}
      {...options}
    />
  );
  return (
    <section className="inline-plan" aria-label="Your editable event plan">
      <div className="ip-sheet" key={state.project.id}>
        <Section
          title="When"
          icon={CalendarDays}
          tone="sage"
          details={
            <>
              {field("brief", "format", "Event format", { wide: true })}
              {field("brief", "timezone", "Time zone", {
                kind: "timezone",
                wide: true,
              })}
              {field("brief", "notes", "Event brief", {
                optional: true,
                multiline: true,
                wide: true,
              })}
            </>
          }
        >
          {field("brief", "date", "Date", { kind: "date" })}
          {field("brief", "time", "Start time", { kind: "time" })}
        </Section>
        <Section
          title="Guests"
          icon={Users}
          tone="blue"
          hint={!capacityPending && f.venueCapacity > 0 && f.attendance > f.venueCapacity ? <span className="ip-warning">{f.attendance - f.venueCapacity} above recorded capacity</span> : undefined}
        >
          {field("guests", "attendance", "Expected guests", {
            kind: "integer",
            min: 1,
            max: 100000,
            zeroIsUnset: true,
            suffix: "people",
            hideLabel: true,
          })}
          {field("guests", "dietary", "Dietary requirements", {
            optional: true,
            wide: true,
          })}
        </Section>
        <Section
          title="Venue"
          icon={MapPin}
          tone="sand"
          hint={capacityEvidence ? <>
            <span>{capacityEvidence.guests} {capacityEvidence.layout.replaceAll("_", " ")} · {capacityEvidence.room}</span>
            {evidenceLink(capacityEvidence.sourceUrl) && <a href={evidenceLink(capacityEvidence.sourceUrl)} target="_blank" rel="noreferrer" aria-label="Published room capacity source"><ExternalLink size={11} /></a>}
          </> : venuePending ? "Venue quote needed" : undefined}
          details={
            <>
              {field("venue", "venueAddress", "Venue address", { wide: true })}
              {capacityEvidence ? <div className="ip-source-value">
                <span>{capacityEvidence.guests} guests · {capacityEvidence.room}</span>
                <small>{capacityEvidence.layout.replaceAll("_", " ")}{evidenceLink(capacityEvidence.sourceUrl) && <a href={evidenceLink(capacityEvidence.sourceUrl)} target="_blank" rel="noreferrer">Source <ExternalLink size={10} /></a>}</small>
              </div> : !capacityPending ? field("venue", "venueCapacity", "Recorded capacity", { kind: "integer", zeroIsUnset: true }) : <p className="ip-detail-note">{currentVenueEvidence?.roomLimit ? `${currentVenueEvidence.roomLimit.guests}-person room limit; seated capacity not published.` : "No published seating capacity found."}</p>}
              {venuePending ? (
                <div className="ip-prior-pricing">
                  <div><span>Previous room estimate</span><strong>{dollars(f.venueCostCents)}</strong></div>
                  <p>Carried in the budget until a new quote arrives.</p>
                </div>
              ) : field("venue", "venueCostCents", "Recorded room cost", { kind: "money" })}
              {avPending ? <p className="ip-detail-note">AV package not published.</p> : avEvidence ? <div className="ip-source-value">
                <span>{avEvidence.included ? "AV included" : "AV not included"}{avEvidence.items.length > 0 && ` · ${avEvidence.items.join(", ")}`}</span>
                {evidenceLink(avEvidence.sourceUrl) && <small><a href={evidenceLink(avEvidence.sourceUrl)} target="_blank" rel="noreferrer">Source <ExternalLink size={10} /></a></small>}
              </div> : <InlineToggle
                label="Audio & visual equipment included"
                area="venue"
                field="venueIncludesAV"
                value={f.venueIncludesAV}
                onSave={onSave}
              />}

            </>
          }
        >
          {field("venue", "venue", "Location", { wide: true, hideLabel: true, placeKind: "venue" })}
        </Section>
        <Section
          title="Catering"
          icon={Utensils}
          tone="rose"
          hint={
            <>
              <span
                className={
                  f.cateringStatus === "confirmed"
                    ? "ip-confirmed"
                    : "ip-waiting"
                }
              >
                {cateringLabel}
              </span>
              {!awaitingCateringQuote && f.caterer && f.cateringPerPersonCents > 0 && (
                <>
                  <span className="ip-hint-separator">·</span>
                  {dollars(f.cateringPerPersonCents)} per person
                </>
              )}
            </>
          }
          details={
            <>
              <div className="ip-prior-pricing">
                <div>
                  <span>{matchedCateringQuote ? "Per guest" : "Recorded per guest"}</span>
                  <strong>{dollars(f.cateringPerPersonCents)}</strong>
                </div>
                <div>
                  <span>{matchedCateringQuote ? "Delivery" : "Recorded delivery"}</span>
                  <strong>{dollars(f.cateringDeliveryCents)}</strong>
                </div>
                {!matchedCateringQuote && <p>No complete quote for this date and guest count.</p>}
              </div>
              {matchedCateringQuote && cateringQuote.sourceTitle && <div className="ip-source-value">
                <span>{cateringQuote.sourceTitle}</span>
                <small>{cateringQuote.simulated ? "Scenario quote" : cateringQuote.provenance === "document" ? "Event document" : "Received email"}{cateringQuote.sourcePath && evidenceLink(cateringQuote.sourcePath) && <a href={evidenceLink(cateringQuote.sourcePath)} target="_blank" rel="noreferrer">Source <ExternalLink size={10} /></a>}</small>
              </div>}
            </>
          }
        >
          {field("catering", "caterer", "Catering partner", { wide: true, hideLabel: true, placeKind: "catering" })}
        </Section>
        <Section
          title="Budget"
          icon={Wallet}
          tone="sage"
          hint={
            <>
              {f.budgetLimitCents <= 0 ? (
                "Budget not set"
              ) : venuePending ? (
                <span className="ip-waiting">Venue quote needed</span>
              ) : incomplete ? (
                <span className="ip-waiting">Quote not yet received</span>
              ) : (
                <span className={remaining < 0 ? "ip-warning" : ""}>
                  {dollars(Math.abs(remaining))}{" "}
                  {remaining < 0 ? "over budget" : "remaining"}
                </span>
              )}
            </>
          }
          details={
            <div className="ip-budget-breakdown">
              <dl>
                {state.budget.lines.map((line, index) => (
                  <div className="ip-budget-row" key={`${line.label}-${index}`}>
                    <dt>
                      <span>{line.label}</span>
                      <small>{line.status}</small>
                      <p>{line.detail}</p>
                    </dt>
                    <dd
                      className={
                        line.status === "awaiting quote"
                          ? "ip-budget-unknown"
                          : ""
                      }
                    >
                      {line.status === "awaiting quote"
                        ? "Awaiting quote"
                        : dollars(line.amountCents)}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="ip-budget-sum">
                <strong>{venuePending ? "Planning estimate" : incomplete ? "Known costs" : "Total estimate"}</strong>
                <strong>{dollars(state.budget.totalCents)}</strong>
              </div>
              {(incomplete || venuePending) && (
                <p className="ip-budget-note">
                  {venuePending ? "Includes the previous venue estimate. The selected venue’s capacity, price, and AV are not yet confirmed." : "The total is incomplete until the quote arrives."}
                </p>
              )}
            </div>
          }
        >
          {field("budget", "budgetLimitCents", "Total budget", {
            kind: "money",
            wide: true,
            hideLabel: true,
          })}
        </Section>
        <Section
          title="Staff"
          icon={ClipboardList}
          tone="lavender"
        >
          {field("staff", "staffCount", "Team members", {
            kind: "integer",
            suffix: "people",
            hideLabel: true,
          })}
          <div className="ip-staff-summary">
            <strong>{staffingEstimate(f).value}</strong>
            <small>{f.staffCostEachCents > 0 ? "Estimated total · saved rate" : "Rate unconfirmed"}</small>
          </div>
        </Section>
        <Section
          title="Equipment"
          icon={Monitor}
          tone="sand"
          details={<>
            <p className="ip-detail-note">{equipment.requirements}</p>
            {equipment.retainRental && <p className="ip-detail-note">Existing rental allowance stays until cancellation is confirmed.</p>}
            {!avPending && <InlineToggle
                label="Venue AV included"
                area="equipment"
                field="venueIncludesAV"
                value={f.venueIncludesAV}
                onSave={onSave}
              />}
          </>}
        >
          <div className="ip-equipment-summary">
            <strong>{equipment.value}</strong>
            <small>{equipment.status}</small>
          </div>
        </Section>
      </div>
    </section>
  );
}
