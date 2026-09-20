import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  LoaderCircle,
  MapPin,
  Monitor,
  Users,
  Utensils,
  Wallet,
} from "lucide-react";
import type { Area, FactPatch, Facts, ProjectState } from "../../shared/types";
import "./inline-plan.css";

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
const rawValue = (value: string | number, kind: FieldKind = "text") =>
  kind === "money" ? String(Number(value) / 100) : String(value);
const statusText = (status: Facts["cateringStatus"]) =>
  ({
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
  multiline?: boolean;
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
  multiline,
}: FieldProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(() => rawValue(value, kind));
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
    const next = rawValue(value, kind);
    draftRef.current = next;
    setDraft(next);
  }, [value, kind]);

  async function commit() {
    // Focusing a field is not an edit. A newer server value must not be written
    // back to its old value merely because the user later leaves that field.
    if (!dirtyRef.current) {
      if (pendingCount.current === 0) {
        const current = rawValue(savedRef.current, kind);
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
    if (parsed.value === baseline) {
      if (pendingCount.current === 0) {
        dirtyRef.current = false;
        setStatus("idle");
        setError("");
        const clean = rawValue(parsed.value, kind);
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
      saved = await onSave(area, { [field]: parsed.value } as FactPatch);
    } catch {
      saved = false;
    }
    pendingCount.current--;
    if (!alive.current) return;
    if (saved) savedRef.current = parsed.value;
    if (sequence !== saveSequence.current) return;
    if (saved) {
      if (editVersion.current === version) {
        const clean = rawValue(parsed.value, kind);
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
    editVersion.current++;
    const restored = rawValue(savedRef.current, kind);
    draftRef.current = restored;
    dirtyRef.current = false;
    setDraft(restored);
    setError("");
    setStatus(pendingCount.current > 0 ? "saving" : "idle");
  }
  const shared = {
    id: inputId,
    value: draft,
    "aria-label": label,
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
      setError("");
      setStatus(pendingCount.current > 0 ? "saving" : "idle");
    },
    onBlur: () => {
      focusedRef.current = false;
      void commit();
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
    >
      <label htmlFor={inputId}>{label}</label>
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
        ) : status === "saved" ? (
          <>
            <Check size={10} />
            Saved
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
          : status === "saved"
            ? "Saved"
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
            <summary>
              Details
              <ChevronDown size={11} />
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
  const remaining = f.budgetLimitCents - state.budget.totalCents;
  const incomplete = state.budget.lines.some(
    (line) => line.status === "awaiting quote",
  );
  const awaitingCateringQuote = f.cateringStatus === "awaiting_quote";
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
      value={f[key] as string | number}
      onSave={onSave}
      {...options}
    />
  );
  return (
    <section className="inline-plan" aria-label="Your editable event plan">
      <div className="ip-sheet" key={state.project.id}>
        <Section
          title="Event details"
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
          hint={
            f.attendance > f.venueCapacity ? (
              <span className="ip-warning">
                {f.attendance - f.venueCapacity} guests over venue capacity
              </span>
            ) : (
              `${Math.max(0, f.venueCapacity - f.attendance)} places to spare at the venue`
            )
          }
        >
          {field("guests", "attendance", "Expected guests", {
            kind: "integer",
            min: 1,
            max: 100000,
            suffix: "people",
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
          hint={`${f.venueCapacity} seated · ${dollars(f.venueCostCents)}${f.venueIncludesAV ? " · AV included" : ""}`}
          details={
            <>
              {field("venue", "venueAddress", "Venue address", { wide: true })}
              {field("venue", "venueCapacity", "Seated capacity", {
                kind: "integer",
              })}
              {field("venue", "venueCostCents", "Room cost", { kind: "money" })}
              <InlineToggle
                label="Audio & visual equipment included"
                area="venue"
                field="venueIncludesAV"
                value={f.venueIncludesAV}
                onSave={onSave}
              />
            </>
          }
        >
          {field("venue", "venue", "Location", { wide: true })}
        </Section>
        <Section
          title="Food & drink"
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
                {statusText(f.cateringStatus)}
              </span>
              {!awaitingCateringQuote && (
                <>
                  <span className="ip-hint-separator">·</span>
                  {dollars(f.cateringPerPersonCents)} per person
                </>
              )}
            </>
          }
          details={
            awaitingCateringQuote ? (
              <div className="ip-prior-pricing">
                <p>
                  New pricing is pending. Earlier amounts are shown only for
                  reference.
                </p>
                <div>
                  <span>Previous price per guest</span>
                  <strong>{dollars(f.cateringPerPersonCents)}</strong>
                </div>
                <div>
                  <span>Previous delivery fee</span>
                  <strong>{dollars(f.cateringDeliveryCents)}</strong>
                </div>
              </div>
            ) : (
              <>
                {field(
                  "catering",
                  "cateringPerPersonCents",
                  "Price per guest",
                  { kind: "money" },
                )}
                {field("catering", "cateringDeliveryCents", "Delivery fee", {
                  kind: "money",
                })}
              </>
            )
          }
        >
          {field("catering", "caterer", "Catering partner", { wide: true })}
        </Section>
        <Section
          title="Budget"
          icon={Wallet}
          tone="sage"
          hint={
            <>
              {dollars(state.budget.totalCents)}{" "}
              {incomplete ? "known costs" : "estimated"}
              <span className="ip-hint-separator">·</span>
              {incomplete ? (
                <span className="ip-waiting">Waiting for quote</span>
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
                <strong>{incomplete ? "Known costs" : "Total estimate"}</strong>
                <strong>{dollars(state.budget.totalCents)}</strong>
              </div>
              {incomplete && (
                <p className="ip-budget-note">
                  The total is incomplete until the quote arrives.
                </p>
              )}
            </div>
          }
        >
          {field("budget", "budgetLimitCents", "Total budget", {
            kind: "money",
            wide: true,
          })}
        </Section>
        <Section
          title="Staff"
          icon={ClipboardList}
          tone="lavender"
          hint={`${dollars(f.staffCostEachCents)} per team member`}
          details={field(
            "staff",
            "staffCostEachCents",
            "Cost per team member",
            { kind: "money", wide: true },
          )}
        >
          {field("staff", "staffCount", "Team members", {
            kind: "integer",
            suffix: "people",
            wide: true,
          })}
        </Section>
        <Section
          title="Equipment"
          icon={Monitor}
          tone="sand"
          hint={
            f.venueIncludesAV
              ? "House audio & visual equipment is included"
              : "Audio, visual & event equipment"
          }
          details={
            <InlineToggle
              label="Equipment included with the venue"
              area="equipment"
              field="venueIncludesAV"
              value={f.venueIncludesAV}
              onSave={onSave}
            />
          }
        >
          {field("equipment", "equipmentCostCents", "Rental estimate", {
            kind: "money",
            wide: true,
          })}
        </Section>
      </div>
      <footer className="ip-footer">
        Enter or leave a field to save. Esc restores its last saved value.
      </footer>
    </section>
  );
}
