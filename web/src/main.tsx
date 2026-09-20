import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Folder,
  History,
  LayoutGrid,
  Link2,
  LoaderCircle,
  Mail,
  MapPin,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Undo2,
  Users,
  Utensils,
  Wallet,
  X,
  ClipboardList,
  Monitor,
  Send,
  ExternalLink,
} from "lucide-react";
import type {
  Area,
  FactPatch,
  ProjectState,
  Proposal,
  Source,
} from "../../shared/types";
import "./styles.css";
import InlinePlan from "./InlinePlan";
import { createMutationQueue } from "./mutation-queue";

const AREA_CONFIG: Record<
  Area,
  { label: string; icon: typeof MapPin; color: string; description: string }
> = {
  venue: {
    label: "Venue",
    icon: MapPin,
    color: "orange",
    description: "The right place for everyone.",
  },
  guests: {
    label: "Guests & invitations",
    icon: Users,
    color: "blue",
    description: "Every guest, accounted for.",
  },
  catering: {
    label: "Food & drink",
    icon: Utensils,
    color: "pink",
    description: "Good food. No surprises.",
  },
  budget: {
    label: "Budget",
    icon: Wallet,
    color: "green",
    description: "Keep the numbers in perspective.",
  },
  staff: {
    label: "Staff & schedule",
    icon: ClipboardList,
    color: "purple",
    description: "Everyone knows where to be.",
  },
  equipment: {
    label: "Equipment",
    icon: Monitor,
    color: "yellow",
    description: "The details behind the scenes.",
  },
  brief: {
    label: "Event details",
    icon: FileText,
    color: "gray",
    description: "One plan everyone can follow.",
  },
};
const money = (cents: number, decimals = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(cents / 100);
const date = (value: string) => {
  try {
    return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString(
      "en-US",
      { month: "long", day: "numeric", year: "numeric" },
    );
  } catch {
    return value;
  }
};
const when = (value: string) => {
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  return seconds < 60
    ? "Just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : new Date(value).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
};
const cname = (...names: (string | false | undefined)[]) =>
  names.filter(Boolean).join(" ");
type View = "overview" | "messages" | "files" | "activity" | "connections";
type Toast = { message: string; error?: boolean } | null;

async function request(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<ProjectState> {
  const response = await fetch(
    path,
    body === undefined && method === "GET"
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function App() {
  const [state, setState] = useState<ProjectState | null>(null);
  const [view, setView] = useState<View>("overview");
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPresenter, setShowPresenter] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [projectSwitch, setProjectSwitch] = useState(false);
  const busyRef = useRef(false);
  const mutationQueue = useRef(createMutationQueue());
  const epoch = useRef(0);
  const activeProject = useRef<string | undefined>(undefined);
  const initialLoad = useCallback(async () => {
    try {
      const result = await request("/api/state", undefined, "GET");
      activeProject.current = result.project.id;
      setState(result);
      setLoadError(null);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void initialLoad();
  }, [initialLoad]);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (busyRef.current || !activeProject.current) return;
      const started = epoch.current;
      const id = activeProject.current;
      try {
        const next = await request(
          `/api/state?projectId=${encodeURIComponent(id)}`,
          undefined,
          "GET",
        );
        if (
          epoch.current === started &&
          activeProject.current === id &&
          !busyRef.current
        )
          setState(next);
      } catch {
        /* The current plan remains available during a temporary connection issue. */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(
      () => setToast(null),
      toast.error ? 8000 : 4500,
    );
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSource(null);
        setShowCreate(false);
        setProjectSwitch(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Reserve the queue before yielding so a blur and the following click both survive.
    busyRef.current = true;
    epoch.current++;
    setBusy((previous) => previous || key);
    return mutationQueue.current
      .enqueue(async () => {
        setBusy(key);
        return operation();
      })
      .finally(() => {
        if (mutationQueue.current.pending === 0) {
          busyRef.current = false;
          setBusy(null);
        }
      });
  }
  function mutate(
    path: string,
    body: unknown,
    key: string,
    success?: string,
    method?: string,
  ) {
    return enqueue(key, async () => {
      try {
        const result = await request(path, body, method);
        if (key === "create") activeProject.current = result.project.id;
        if (activeProject.current === result.project.id) setState(result);
        if (success) setToast({ message: success });
        return true;
      } catch (error) {
        setToast({ message: (error as Error).message, error: true });
        return false;
      }
    });
  }
  function switchProject(id: string) {
    setProjectSwitch(false);
    return enqueue("switch", async () => {
      try {
        const result = await request(
          `/api/state?projectId=${encodeURIComponent(id)}`,
          undefined,
          "GET",
        );
        activeProject.current = id;
        setState(result);
        setView("overview");
        setSource(null);
      } catch (error) {
        setToast({ message: (error as Error).message, error: true });
      }
    });
  }
  if (!state)
    return (
      <div className="boot">
        <RippleMark />
        <h1>Ripple</h1>
        {loadError ? (
          <>
            <p>We couldn’t open your workspace.</p>
            <p className="muted">{loadError}</p>
            <button className="primary" onClick={initialLoad}>
              <RefreshCw size={16} /> Try again
            </button>
          </>
        ) : (
          <>
            <div className="boot-loader" />
            <p>Getting your event ready…</p>
          </>
        )}
      </div>
    );
  const f = state.project.facts;
  const priority = { warning: 0, email: 1, invitation: 2, fact: 3, file: 4 };
  const pending = state.proposals
    .filter((p) => p.status === "pending" || p.status === "blocked")
    .sort((a, b) => priority[a.kind] - priority[b.kind]);
  const active = state.workflow?.status === "planning";
  const waiting = state.workflow?.status === "waiting";
  const latestUndo = state.activity.find((a) => a.canUndo && a.changeId);
  const decisionBusy = busy !== null && busy !== "save";
  const budgetLeft = f.budgetLimitCents - state.budget.totalCents;
  const budgetIncomplete = state.budget.lines.some(
    (line) => line.status === "awaiting quote",
  );
  const url = `/api/projects/${encodeURIComponent(state.project.id)}`;
  const approve = (proposal: Proposal, decision: "approve" | "deny") =>
    mutate(
      `${url}/proposals/${proposal.id}/${decision}`,
      {},
      `${decision}-${proposal.id}`,
      decision === "approve"
        ? "Approved. The plan is being updated."
        : "Suggestion denied.",
    );
  const undo = (id: string) =>
    mutate(
      `${url}/undo/${id}`,
      {},
      `undo-${id}`,
      "The earlier plan has been restored.",
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setView("overview");
          }}
          aria-label="Ripple home"
        >
          <RippleMark />
          <span>
            ripple<span className="brand-dot">.</span>
          </span>
        </a>
        {projectSwitch && (
          <div className="project-menu">
            {state.projects.map((p) => (
              <button key={p.id} onClick={() => switchProject(p.id)}>
                <CalendarDays size={15} />
                <span>{p.name}</span>
                {p.id === state.project.id && <Check size={14} />}
              </button>
            ))}
            <button
              onClick={() => {
                setShowCreate(true);
                setProjectSwitch(false);
              }}
            >
              <Plus size={15} />
              New event
            </button>
          </div>
        )}
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav">
          <button
            className={cname(view === "overview" && "selected")}
            onClick={() => setView("overview")}
          >
            <LayoutGrid size={18} />
            <span>Event plan</span>
            {pending.length > 0 && <b>{pending.length}</b>}
          </button>
          <button
            className={cname(view === "messages" && "selected")}
            onClick={() => setView("messages")}
          >
            <Mail size={18} />
            <span>Communications</span>
          </button>
          <button
            className={cname(view === "activity" && "selected")}
            onClick={() => setView("activity")}
          >
            <History size={18} />
            <span>Activity</span>
          </button>
        </nav>
        <div className="nav-label events-label">
          YOUR EVENTS
          <button aria-label="Create event" onClick={() => setShowCreate(true)}>
            <Plus size={15} />
          </button>
        </div>
        <nav className="events-nav">
          {state.projects.map((p) => (
            <button
              key={p.id}
              className={cname(p.id === state.project.id && "current-event")}
              onClick={() => switchProject(p.id)}
            >
              <span className="event-dot" />
              <span>{p.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="presenter-toggle"
            onClick={() => setView("connections")}
          >
            <Link2 size={16} />
            <span>Integrations & sources</span>
          </button>
          <button
            className="presenter-toggle"
            onClick={() => setShowPresenter(!showPresenter)}
          >
            <Settings2 size={16} />
            <span>Demo controls</span>
            <ChevronRight
              size={14}
              className={showPresenter ? "rotate-90" : ""}
            />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Events</span>
            <ChevronRight size={13} />
            <strong>{state.project.name}</strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button mobile-project-switch"
              aria-label="Switch event or create an event"
              aria-expanded={projectSwitch}
              onClick={() => setProjectSwitch(!projectSwitch)}
            >
              <Folder size={17} />
            </button>
            <span className="demo-badge">
              <span />
              Demo workspace
            </span>
            <button
              className="icon-button"
              aria-label="View connections"
              onClick={() => setView("connections")}
            >
              <Link2 size={17} />
            </button>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>
                {view === "overview"
                  ? state.project.name
                  : view === "messages"
                    ? "Communications"
                    : view === "files"
                      ? "Planning files"
                      : view === "activity"
                        ? "Event activity"
                        : "Integrations & sources"}
              </h1>
              <p>
                {view === "overview" ? (
                  <>
                    <CalendarDays size={14} />
                    {date(f.date)}
                    <span className="separator">·</span>
                    <MapPin size={14} />
                    {f.venue}
                  </>
                ) : view === "messages" ? (
                  "Vendor requests, staff updates, and guest invitations."
                ) : view === "files" ? (
                  "Source documents used to check your event details."
                ) : view === "activity" ? (
                  "A clear record of what changed, and what happened next."
                ) : (
                  "Data sources and delivery status for this event."
                )}
              </p>
            </div>
            <div className="heading-actions">
              {latestUndo && (
                <button
                  className="secondary compact quick-undo"
                  disabled={decisionBusy}
                  title={latestUndo.title}
                  onClick={() => undo(latestUndo.changeId!)}
                >
                  <Undo2 size={15} />
                  Undo last change
                </button>
              )}
            </div>
          </div>
          {showPresenter && (
            <section className="presenter-panel">
              <div>
                <span className="section-eyebrow">PRESENTER TOOLS</span>
                <p>
                  Simulate a vendor reply. These messages stay inside this demo.
                </p>
              </div>
              <div className="presenter-buttons">
                {(
                  [
                    "quote",
                    "confirmation",
                    "cancellation",
                    "stale_quote",
                  ] as const
                ).map((type) => (
                  <button
                    className="secondary compact"
                    disabled={!!busy}
                    key={type}
                    onClick={() =>
                      mutate(
                        `${url}/demo`,
                        { type },
                        `demo-${type}`,
                        "Demo reply received. Related details are being checked.",
                      )
                    }
                  >
                    <Mail size={13} />
                    {type === "quote"
                      ? "New quote"
                      : type === "confirmation"
                        ? "Booking confirmed"
                        : type === "cancellation"
                          ? "Cancellation confirmed"
                          : "Old quote"}
                  </button>
                ))}
                <button
                  className="text-button reset-button"
                  disabled={!!busy}
                  onClick={async () => {
                    if (!resetArmed) {
                      setResetArmed(true);
                      return;
                    }
                    const ok = await mutate(
                      `${url}/reset`,
                      {},
                      "reset",
                      "Demo event reset.",
                    );
                    if (ok) setResetArmed(false);
                  }}
                >
                  <RefreshCw size={13} />
                  {resetArmed ? "Confirm reset" : "Reset demo"}
                </button>
                {resetArmed && (
                  <>
                    <button
                      className="text-button reset-button"
                      onClick={() => setResetArmed(false)}
                    >
                      Cancel
                    </button>
                    <span className="reset-explanation">
                      Resets this demo event’s changes and activity.
                    </span>
                  </>
                )}
              </div>
              <button
                aria-label="Close demo controls"
                className="icon-button"
                onClick={() => setShowPresenter(false)}
              >
                <X size={15} />
              </button>
            </section>
          )}
          {view === "overview" && (
            <>
              <section className="plan-summary" aria-label="Event at a glance">
                <span>
                  <Users size={16} />
                  <strong>{f.attendance} guests</strong>
                  <small
                    className={
                      f.attendance > f.venueCapacity ? "over-text" : ""
                    }
                  >
                    {f.attendance > f.venueCapacity
                      ? `${f.attendance - f.venueCapacity} over capacity`
                      : `${Math.max(0, f.venueCapacity - f.attendance)} places to spare`}
                  </small>
                </span>
                <span>
                  <Wallet size={16} />
                  <strong>{money(state.budget.totalCents)}</strong>
                  <small className={budgetLeft < 0 ? "over-text" : ""}>
                    {budgetIncomplete
                      ? "Awaiting quote · estimate incomplete"
                      : `${money(Math.abs(budgetLeft))} ${budgetLeft < 0 ? "over budget" : "remaining"}`}
                  </small>
                </span>
              </section>
              {state.workflow && (
                <section
                  className={cname(
                    "ambient-strip",
                    active && "is-working",
                    state.workflow.status === "failed" && "has-error",
                  )}
                  aria-live="polite"
                >
                  <button
                    className="ambient-main"
                    onClick={() => setShowProgress(!showProgress)}
                    aria-expanded={showProgress}
                  >
                    <span className="ambient-symbol">
                      {active ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : waiting ? (
                        <Clock3 size={17} />
                      ) : state.workflow.status === "failed" ? (
                        <CircleHelp size={17} />
                      ) : (
                        <CheckCheck size={17} />
                      )}
                    </span>
                    <span>
                      <strong>
                        {active
                          ? "Checking the details around your change"
                          : waiting
                            ? "Waiting for vendor reply"
                            : state.workflow.status === "failed"
                              ? "This change needs another look"
                              : state.workflow.summary ||
                                "Related details checked"}
                      </strong>
                      {active && (
                        <small>
                          Related drafts will appear here when ready.
                        </small>
                      )}
                    </span>
                    <ChevronDown
                      size={15}
                      className={showProgress ? "rotate-180" : ""}
                    />
                  </button>
                  {showProgress && (
                    <div className="progress-content">
                      <div className="progress-track">
                        {state.workflow.stages.map((stage, i) => (
                          <div
                            key={`${stage.label}-${i}`}
                            className={cname("progress-stage", stage.status)}
                          >
                            <div className="stage-node">
                              {stage.status === "done" ? (
                                <Check size={12} />
                              ) : stage.status === "running" ? (
                                <span className="stage-pulse" />
                              ) : (
                                i + 1
                              )}
                            </div>
                            <span>{stage.label}</span>
                          </div>
                        ))}
                      </div>
                      {state.workflow.error && (
                        <p className="error-copy">{state.workflow.error}</p>
                      )}
                    </div>
                  )}
                </section>
              )}
              <div className="workspace-grid">
                <section className="plan-section">
                  <div className="section-heading">
                    <div>
                      <h2>Event plan</h2>
                      <p>Edit the details below. Changes save automatically.</p>
                    </div>
                  </div>
                  <InlinePlan
                    key={state.project.id}
                    state={state}
                    onSave={(area: Area, patch: FactPatch) =>
                      mutate(url, { area, patch }, "save", undefined, "PATCH")
                    }
                  />
                </section>
                <section className="updates-section">
                  <div className="section-heading">
                    <div>
                      <h2>
                        To send & update{" "}
                        {pending.length > 0 && (
                          <span className="count-bubble">{pending.length}</span>
                        )}
                      </h2>
                      <p>
                        {active
                          ? "Checking the details around your change."
                          : pending.length
                            ? "Review the changes, then approve or deny."
                            : "Emails and plan changes that need your approval."}
                      </p>
                    </div>
                  </div>
                  <div className="proposal-list">
                    {pending.map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={p}
                        proposals={state.proposals}
                        sources={state.sources}
                        busy={busy}
                        onDecision={approve}
                      />
                    ))}
                    {pending.length === 0 && (
                      <div className="empty-updates">
                        <div className="empty-orbits">
                          <div />
                          <div />
                          <div />
                          <span>
                            {active ? (
                              <LoaderCircle size={23} className="spin" />
                            ) : (
                              <Check size={25} />
                            )}
                          </span>
                        </div>
                        <h3>
                          {active
                            ? "Checking the related details"
                            : "No pending actions"}
                        </h3>
                        <p>
                          {active
                            ? "Keep editing. We’ll bring you the decisions."
                            : "Changes to your event prepare vendor emails, staff updates, and guest notices here."}
                        </p>
                      </div>
                    )}
                  </div>
                  {state.activity.length > 0 && (
                    <div className="recent-activity">
                      <div className="recent-heading">
                        <h3>Recent changes</h3>
                        <button onClick={() => setView("activity")}>
                          History
                          <ArrowRight size={13} />
                        </button>
                      </div>
                      {state.activity.slice(0, 3).map((a) => (
                        <div className="recent-row" key={a.id}>
                          <span className={cname("activity-dot", a.status)} />
                          <div>
                            <strong>{a.title}</strong>
                            <small>{when(a.at)}</small>
                          </div>
                          {a.canUndo && a.changeId && (
                            <button
                              className="undo-button"
                              disabled={decisionBusy}
                              onClick={() => undo(a.changeId!)}
                            >
                              <Undo2 size={13} />
                              Undo
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {view === "messages" && (
            <div className="communications-layout">
              <section>
                <div className="section-heading">
                  <h2>Ready for approval</h2>
                  <span className="subtle-count">
                    {
                      pending.filter(
                        (p) => p.kind === "email" || p.kind === "invitation",
                      ).length
                    }
                  </span>
                </div>
                <div className="proposal-list">
                  {pending
                    .filter(
                      (p) => p.kind === "email" || p.kind === "invitation",
                    )
                    .map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={p}
                        proposals={state.proposals}
                        sources={state.sources}
                        busy={busy}
                        onDecision={approve}
                      />
                    ))}
                  {!pending.some(
                    (p) => p.kind === "email" || p.kind === "invitation",
                  ) && (
                    <div className="communication-empty">
                      {active ? (
                        <LoaderCircle size={23} className="spin" />
                      ) : (
                        <Mail size={23} />
                      )}
                      <h3>
                        {active ? "Preparing messages" : "No drafts to review"}
                      </h3>
                      <p>
                        {active
                          ? "Checking the current event details before preparing the drafts."
                          : "Vendor requests, team emails, and guest notices are prepared when the event changes."}
                      </p>
                    </div>
                  )}
                </div>
              </section>
              <section className="surface">
                <div className="surface-header">
                  <h2>Conversation history</h2>
                  <span className="subtle-count">{state.messages.length}</span>
                </div>
                {f.cateringStatus !== "confirmed" && (
                  <div className="vendor-wait">
                    <Clock3 size={16} />
                    <div>
                      <strong>{f.caterer}</strong>
                      <p>
                        {f.cateringStatus === "awaiting_quote"
                          ? "Quote not received. Review and approve any unsent request; the budget updates when the reply arrives."
                          : f.cateringStatus === "awaiting_confirmation"
                            ? "Waiting for booking confirmation before notifying guests and staff."
                            : "Quote received. Review the booking request."}
                      </p>
                    </div>
                  </div>
                )}
                <div className="messages-list">
                  {state.messages.map((m) => (
                    <article key={m.id} className="conversation-message">
                      <div>
                        <span
                          className={cname("message-direction", m.direction)}
                        >
                          {m.direction === "inbound"
                            ? "Received"
                            : "Sent · simulated"}
                        </span>
                        <small>{when(m.at)}</small>
                      </div>
                      <h3>{m.subject}</h3>
                      <span className="message-address">{m.from}</span>
                      <p>{m.body}</p>
                    </article>
                  ))}
                  {!state.messages.length && (
                    <p className="panel-empty">
                      Sent messages and vendor replies will appear here.
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
          {view === "files" && (
            <>
              <div className="files-banner">
                <span className="connection-logo dropbox-logo">
                  <DropboxLogo />
                </span>
                <div>
                  <h2>{state.project.name}</h2>
                  <p>
                    Planning folder · {state.sources.length} source files · Demo
                    Dropbox
                  </p>
                </div>
                <span className="subtle-badge">Local demo files</span>
              </div>
              <div className="source-grid">
                {state.sources.map((s) => (
                  <button
                    className="source-card"
                    key={s.id}
                    onClick={() => setSource(s)}
                  >
                    <span
                      className={cname("area-icon", AREA_CONFIG[s.area].color)}
                    >
                      <FileText size={22} />
                    </span>
                    <h3>{s.title}</h3>
                    <p>
                      {s.content.slice(0, 140)}
                      {s.content.length > 140 && "…"}
                    </p>
                    <div>
                      <span>{AREA_CONFIG[s.area].label}</span>
                      <ArrowUpRight size={15} />
                    </div>
                  </button>
                ))}
              </div>
              {state.sources.length === 0 && (
                <div className="generic-empty">
                  <Folder size={35} />
                  <h3>No planning files yet</h3>
                  <p>Your event’s source documents will appear here.</p>
                </div>
              )}
            </>
          )}
          {view === "activity" && (
            <div className="activity-layout">
              <section className="surface">
                <div className="surface-header">
                  <h2>Changes & decisions</h2>
                  <span className="subtle-count">
                    {state.activity.length} updates
                  </span>
                </div>
                {state.activity.length ? (
                  <div className="activity-list">
                    {state.activity.map((a) => (
                      <div className="activity-item" key={a.id}>
                        <span className={cname("activity-icon", a.status)}>
                          {a.status === "working" ? (
                            <LoaderCircle size={16} className="spin" />
                          ) : a.status === "waiting" ? (
                            <Clock3 size={16} />
                          ) : a.status === "denied" ? (
                            <X size={16} />
                          ) : a.status === "attention" ? (
                            <CircleHelp size={16} />
                          ) : (
                            <Check size={16} />
                          )}
                        </span>
                        <div>
                          <h3>{a.title}</h3>
                          <p>{a.detail}</p>
                          <small>{new Date(a.at).toLocaleString()}</small>
                        </div>
                        {a.canUndo && a.changeId && (
                          <button
                            className="secondary compact"
                            disabled={!!busy}
                            onClick={() => undo(a.changeId!)}
                          >
                            <Undo2 size={14} />
                            Undo
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="generic-empty">
                    <History size={30} />
                    <h3>A fresh start</h3>
                    <p>
                      Your event’s changes and decisions will be recorded here.
                    </p>
                  </div>
                )}
              </section>
              <div className="activity-side">
                <section className="surface">
                  <div className="surface-header">
                    <h2>Action receipts</h2>
                    <span className="subtle-count">
                      {state.receipts.length}
                    </span>
                  </div>
                  <div className="receipts-list">
                    {state.receipts.map((r) => (
                      <div className="receipt" key={r.id}>
                        <div>
                          <span className={cname("receipt-status", r.status)}>
                            {r.status === "failed" ? (
                              <X size={12} />
                            ) : (
                              <Check size={12} />
                            )}
                            {r.status === "simulated"
                              ? "Simulated"
                              : r.status === "local"
                                ? "Saved locally"
                                : "Failed"}
                          </span>
                          <small>{when(r.at)}</small>
                        </div>
                        <h3>{r.title}</h3>
                        <p>{r.detail}</p>
                        <span className="receipt-provider">{r.provider}</span>
                      </div>
                    ))}
                    {!state.receipts.length && (
                      <p className="panel-empty">
                        Completed actions will appear here with their result.
                      </p>
                    )}
                  </div>
                </section>
                <section className="surface">
                  <div className="surface-header">
                    <h2>Event messages</h2>
                    <Mail size={17} />
                  </div>
                  <div className="messages-list">
                    {state.messages.map((m) => (
                      <details key={m.id} className="message-item">
                        <summary>
                          {m.direction === "inbound" ? (
                            <ArrowDownLeft size={15} />
                          ) : (
                            <ArrowUpRight size={15} />
                          )}
                          <span>
                            <strong>{m.subject}</strong>
                            <small>
                              {m.from} · {when(m.at)}
                            </small>
                          </span>
                          <ChevronDown size={13} />
                        </summary>
                        <p>{m.body}</p>
                        {m.simulated && (
                          <span className="subtle-badge">Demo message</span>
                        )}
                      </details>
                    ))}
                    {!state.messages.length && (
                      <p className="panel-empty">
                        Vendor messages and replies will appear here.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}
          {view === "connections" && (
            <>
              <div className="connection-intro">
                <ShieldCheck size={20} />
                <p>
                  This workspace uses demo files, emails, and invitations.
                  External messages are simulated and clearly recorded in
                  Activity.
                </p>
                <button
                  className="secondary compact"
                  onClick={() => setView("files")}
                >
                  <FileText size={15} />
                  Source documents
                </button>
              </div>
              <div className="connections-grid">
                {state.connections.map((c) => (
                  <div key={c.name} className="connection-card">
                    <span
                      className={cname(
                        "connection-logo",
                        c.name.toLowerCase().includes("dropbox")
                          ? "dropbox-logo"
                          : c.name.toLowerCase().includes("email")
                            ? "mail-logo"
                            : "invite-logo",
                      )}
                    >
                      {c.name.toLowerCase().includes("dropbox") ? (
                        <DropboxLogo />
                      ) : c.name.toLowerCase().includes("email") ? (
                        <Mail size={24} />
                      ) : (
                        <CalendarDays size={24} />
                      )}
                    </span>
                    <span className={cname("connection-mode", c.mode)}>
                      {c.mode === "live"
                        ? "Connected"
                        : c.mode === "demo"
                          ? "Demo"
                          : "Unavailable"}
                    </span>
                    <h2>{c.name}</h2>
                    <p>{c.detail}</p>
                  </div>
                ))}
              </div>
              <section className="ai-details surface">
                <div>
                  <span className="area-icon green">
                    <Sparkles size={19} />
                  </span>
                  <div>
                    <h2>Planning intelligence</h2>
                    <p>
                      {state.ai.mode === "live"
                        ? "OpenAI is connected. Changes are checked using your event’s facts and documents."
                        : "Demo planning is active. Event rules and sample documents power this workspace."}
                    </p>
                  </div>
                  <span className={cname("connection-mode", state.ai.mode)}>
                    {state.ai.mode === "live" ? "Live" : "Demo"}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Model</dt>
                    <dd>{state.ai.model || "Demo planner"}</dd>
                  </div>
                  <div>
                    <dt>Fallback</dt>
                    <dd>{state.ai.fallbackModel || "—"}</dd>
                  </div>
                  <div>
                    <dt>Estimated usage</dt>
                    <dd>
                      ${state.ai.estimatedSpendUsd.toFixed(4)} / $
                      {state.ai.spendLimitUsd.toFixed(2)}
                    </dd>
                  </div>
                </dl>
                {state.ai.lastError && (
                  <p className="error-copy">{state.ai.lastError}</p>
                )}
              </section>
            </>
          )}
          <footer className="page-footer">
            Local demo · Emails and invitations are simulated
          </footer>
        </div>
      </main>
      {source && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSource(null);
          }}
        >
          <section
            className="document-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-title"
          >
            <div className="drawer-top">
              <span
                className={cname("area-icon", AREA_CONFIG[source.area].color)}
              >
                <FileText size={20} />
              </span>
              <button
                className="icon-button"
                onClick={() => setSource(null)}
                aria-label="Close file"
              >
                <X size={20} />
              </button>
            </div>
            <span className="section-eyebrow">PLANNING FILE</span>
            <h2 id="source-title">{source.title}</h2>
            <p className="document-path">{source.path}</p>
            <pre>{source.content}</pre>
            <div className="document-footer">
              <ShieldCheck size={14} />
              Included as a source when checking related changes.
            </div>
          </section>
        </div>
      )}
      {showCreate && (
        <CreateProject
          busy={!!busy}
          onClose={() => setShowCreate(false)}
          onCreate={async (name) => {
            const ok = await mutate(
              "/api/projects",
              { name },
              "create",
              "Your new event is ready.",
            );
            if (ok) {
              setShowCreate(false);
              setView("overview");
            }
          }}
        />
      )}
      {toast && (
        <div
          className={cname("toast", toast.error && "toast-error")}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function RippleMark() {
  return (
    <span className="ripple-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function DropboxLogo() {
  return (
    <svg
      viewBox="0 0 40 40"
      width="26"
      height="26"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="m10 6 10 6-10 6L0 12Zm20 0 10 6-10 6-10-6ZM10 19l10 6-10 6L0 25Zm20 0 10 6-10 6-10-6ZM10 33l10-6 10 6-10 6Z"
        transform="translate(3 0) scale(.85)"
      />
    </svg>
  );
}
function ProposalCard({
  proposal: p,
  proposals,
  sources,
  busy,
  onDecision,
}: {
  proposal: Proposal;
  proposals: Proposal[];
  sources: Source[];
  busy: string | null;
  onDecision: (p: Proposal, decision: "approve" | "deny") => Promise<boolean>;
}) {
  const Icon =
    p.kind === "email"
      ? Mail
      : p.kind === "invitation"
        ? Send
        : p.kind === "warning"
          ? CircleHelp
          : AREA_CONFIG[p.area].icon;
  const prerequisites = p.dependencies
    .map((id) => proposals.find((item) => item.id === id))
    .filter((item): item is Proposal => !!item && item.status !== "applied");
  const held = prerequisites.length > 0 || p.status === "blocked";
  const deciding = busy !== null && busy !== "save";
  return (
    <article className={cname("proposal-card", held && "blocked-proposal")}>
      <div className="proposal-top">
        <span
          className={cname(
            "proposal-kind",
            p.kind === "warning" ? "warning-kind" : "",
          )}
        >
          <Icon size={13} />
          {p.kind === "email"
            ? "EMAIL DRAFT"
            : p.kind === "invitation"
              ? "INVITATION UPDATE"
              : p.kind === "warning"
                ? "NEEDS ATTENTION"
                : AREA_CONFIG[p.area].label.toUpperCase()}
        </span>
        {p.costImpactCents !== null && p.costImpactCents !== 0 && (
          <span
            className={cname("cost-impact", p.costImpactCents < 0 && "saving")}
          >
            {p.costImpactCents > 0 ? "+" : "−"}
            {money(Math.abs(p.costImpactCents))}
          </span>
        )}
      </div>
      <h3>{p.title}</h3>
      {![
        "Prepared for your approval. Delivery is simulated in this demo.",
        "Preview the exact invitation update before approving.",
      ].includes(p.description) && (
        <p className="proposal-description">{p.description}</p>
      )}
      {p.kind !== "email" && p.kind !== "warning" && (
        <div className="change-preview">
          <span>{p.before || "Current plan"}</span>
          <ArrowRight size={13} />
          <strong>{p.after || "Updated plan"}</strong>
        </div>
      )}
      {(p.body || p.subject) && (
        <div className="email-preview visible-draft">
          <dl>
            {p.recipient && (
              <div>
                <dt>To</dt>
                <dd>{p.recipient}</dd>
              </div>
            )}
            {p.subject && (
              <div>
                <dt>Subject</dt>
                <dd>{p.subject}</dd>
              </div>
            )}
          </dl>
          <p>{p.body}</p>
          <span className="draft-note">
            {p.kind === "invitation"
              ? "Demo invitation update"
              : "Simulated send"}
          </span>
        </div>
      )}
      {p.kind === "warning" && (
        <p className="warning-acknowledgment">
          Approving records this check in the event history.
        </p>
      )}
      <details className="proposal-sources">
        <summary>
          <FileText size={12} />
          Based on {p.evidence.length || 1}{" "}
          {p.evidence.length <= 1 ? "source" : "sources"}
          <ChevronDown size={12} />
        </summary>
        <div className="evidence">
          {p.evidence.length ? (
            p.evidence.map((e, i) => (
              <p key={i}>
                {sources.find((source) => source.id === e)?.title || e}
              </p>
            ))
          ) : (
            <p>Your current event details</p>
          )}
        </div>
      </details>
      {held && (
        <div className="prerequisite-message">
          <Clock3 size={12} />
          <span>
            {prerequisites.some((item) => item.status === "denied")
              ? "A related update was denied. This suggestion is on hold."
              : `First complete: ${prerequisites.map((item) => item.title).join(", ") || "the related update"}.`}
          </span>
        </div>
      )}
      <div className="proposal-actions">
        <button
          className="approve-button"
          disabled={deciding || held}
          onClick={() => onDecision(p, "approve")}
        >
          {busy === `approve-${p.id}` ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}
          Approve
        </button>
        <button
          className="deny-button"
          disabled={deciding}
          onClick={() => onDecision(p, "deny")}
        >
          {busy === `deny-${p.id}` ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <X size={14} />
          )}
          Deny
        </button>
        <span className="proposal-time">{when(p.createdAt)}</span>
      </div>
    </article>
  );
}

function CreateProject({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
      >
        <div className="drawer-top">
          <span className="area-icon green">
            <CalendarDays size={21} />
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close new event"
          >
            <X size={20} />
          </button>
        </div>
        <h2 id="create-title">Something to look forward to.</h2>
        <p>
          Give your event a name. We’ll start with a complete sample plan you
          can make your own.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void onCreate(name.trim());
          }}
        >
          <label className="field">
            <span>Event name</span>
            <input
              autoFocus
              maxLength={100}
              placeholder="e.g. Christmas dinner"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="create-note">
            <Folder size={15} />
            Includes demo planning files, budget, and vendors.
          </div>
          <button className="primary" disabled={!name.trim() || busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
            Create event
          </button>
        </form>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
