import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Tone = "neutral" | "accent" | "warn" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-border/60 text-foreground",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const v = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-border bg-surface hover:bg-border/40",
    ghost: "hover:bg-border/40",
    danger: "border border-danger/40 text-danger hover:bg-danger-soft",
  }[variant];
  return <button className={`${base} ${v} ${className}`} {...props} />;
}

export function Card({ children, className = "", as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "aside" } & Record<string, unknown>) {
  return (
    <Tag className={`rounded-xl border border-border bg-surface p-4 shadow-sm ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">{children}</p>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
      <span aria-hidden className="ripple-active inline-block size-2 rounded-full bg-accent" />
      {label}
    </span>
  );
}

export function costTone(status: string): Tone {
  switch (status) {
    case "committed":
    case "sunk":
      return "danger";
    case "quoted":
      return "accent";
    case "estimate":
      return "info";
    case "prospective":
      return "warn";
    case "released":
      return "neutral";
    default:
      return "warn";
  }
}

export const COST_LABEL: Record<string, string> = {
  unknown: "Unknown",
  estimate: "Estimated",
  quoted: "Quoted",
  committed: "Committed",
  sunk: "Sunk",
  prospective: "Prospective",
  released: "Released",
};

export function CostBadge({ status }: { status: string }) {
  return (
    <Badge tone={costTone(status)} title={COST_HELP[status]}>
      {COST_LABEL[status] ?? status}
    </Badge>
  );
}

export const COST_HELP: Record<string, string> = {
  unknown: "No figure yet; not counted as zero.",
  estimate: "Derived from a policy or planning assumption; not a vendor quote.",
  quoted: "A vendor quoted this; not yet accepted or contracted.",
  committed: "Contracted or confirmed with the vendor.",
  sunk: "Already paid and non-recoverable.",
  prospective: "Possible saving; realised only when the other party confirms.",
  released: "No longer owed after cancellation.",
};

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
}

export function relativeTime(ts: number | null | undefined, nowTs = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((nowTs - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
