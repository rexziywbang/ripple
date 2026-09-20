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
  ShieldCheck,
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
import type { Area, FactPatch, ProjectState } from "../../shared/types";
import "./styles.css";
import InlinePlan from "./InlinePlan";
import ReviewQueue, { reviewGroups } from "./ReviewQueue";
import EventConnections from "./EventConnections";
import GmailApiConnection from "./GmailApiConnection";
import InvitationPreview from "./InvitationPreview";
import OperatingPlans from "./OperatingPlans";
import WorkflowProgress from "./WorkflowProgress";
import { type OnPlanCardAction } from "./PlanCardDeck";
import CommunicationsHistory, { VendorStatus } from "./CommunicationsHistory";
import { createMutationQueue } from "./mutation-queue";
import { buildPlanEdit } from "./plan-edit";
import { prepareEditedReview, type DraftReview, type LocalEmailDraft } from "./review-drafts";
import { changeSurface } from "./motion";
import EventWorkspace, { hasRemainingReviewWork, visibleReviewItems, visibleReviewSlides, type BatchReview } from "./EventWorkspace";
import WorkspaceHome, { type WorkspaceIndex, type PlanningFile } from "./WorkspaceHome";

const money = (cents: number, decimals = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(cents / 100);
const date = (value: string) => {
  if (!value) return "Date not set";
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
type View = "overview" | "messages" | "activity" | "connections";
type Toast = { message: string; error?: boolean } | null;

function revealSection(id: string) {
  // Wait for the saved state and its expanding surface to enter the layout.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }));
}

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
  const [demoSession] = useState(() => new URLSearchParams(window.location.search).get("demo") === "1");
  const [showHome, setShowHome] = useState(() => new URLSearchParams(window.location.search).get("demo") === "1");
  const [workspace, setWorkspace] = useState<WorkspaceIndex | null>(null);
  const [overviewMode, setOverviewMode] = useState<"edit" | "review" | "complete">("edit");
  const [state, setState] = useState<ProjectState | null>(null);
  const [view, setCurrentView] = useState<View>("overview");
  const setView = (next: View) => { if (next !== view) changeSurface(() => setCurrentView(next)); };
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [emailDrafts, setEmailDrafts] = useState<Record<string, LocalEmailDraft>>({});
  const [showCreate, setCreateVisible] = useState(false);
  const setShowCreate = (next: boolean) => changeSurface(() => setCreateVisible(next));
  const [settledWorkflow, setSettledWorkflow] = useState<string | null>(null);
  const observedPlanning = useRef<string | null>(null);
  const [projectSwitch, setProjectSwitch] = useState(false);
  const busyRef = useRef(false);
  const mutationQueue = useRef(createMutationQueue());
  const epoch = useRef(0);
  const activeProject = useRef<string | undefined>(undefined);
  const refreshWorkspace = useCallback(async () => {
    const response = await fetch("/api/workspace");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Your workspace couldn’t be opened.");
    setWorkspace(result as WorkspaceIndex);
    return result as WorkspaceIndex;
  }, []);
  const initialLoad = useCallback(async () => {
    try {
      if (demoSession) { await refreshWorkspace(); setLoadError(null); return; }
      let remembered: string | null = null;
      try { remembered = window.sessionStorage.getItem("ripple.activeProject"); } catch { /* Storage is optional. */ }
      const result = await request(remembered ? `/api/state?projectId=${encodeURIComponent(remembered)}` : "/api/state", undefined, "GET");
      activeProject.current = result.project.id;
      setState(result);
      setLoadError(null);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, [demoSession, refreshWorkspace]);
  useEffect(() => {
    void initialLoad();
  }, [initialLoad]);
  useEffect(() => {
    if (demoSession || !state?.project.id) return;
    try { window.sessionStorage.setItem("ripple.activeProject", state.project.id); } catch { /* Keep the open event usable without storage. */ }
  }, [demoSession, state?.project.id]);
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
        setShowCreate(false);
        setProjectSwitch(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const workflow = state?.workflow;
    const identity = workflow ? `${state?.project.id}:${workflow.id}` : null;
    if (workflow?.status === "planning") {
      observedPlanning.current = identity;
      setSettledWorkflow(null);
      return;
    }
    if (identity && observedPlanning.current === identity &&
        (workflow?.status === "review" || workflow?.status === "complete")) {
      observedPlanning.current = null;
      setSettledWorkflow(identity);
      return;
    }
    observedPlanning.current = null;
    setSettledWorkflow(null);
  }, [state?.project.id, state?.workflow?.id, state?.workflow?.status]);

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
        setOverviewMode("edit");
        changeSurface(() => setShowHome(false));
        setView("overview");
      } catch (error) {
        setToast({ message: (error as Error).message, error: true });
      }
    });
  }
  async function importFolder(files: PlanningFile[]) {
    return enqueue("import", async () => {
      const result = await request("/api/workspace/import", { files, ...(demoSession ? { demo: true } : {}) });
      activeProject.current = result.project.id;
      setState(result);
      setOverviewMode("edit");
      setCurrentView("overview");
      setLoadError(null);
      changeSurface(() => setShowHome(false));
    });
  }
  function openHome() {
    changeSurface(() => setShowHome(true));
    void refreshWorkspace().catch(error => setLoadError((error as Error).message));
  }
  if (showHome) return <>
    <WorkspaceHome workspace={workspace} demo={demoSession} busy={!!busy} error={loadError} onImport={importFolder} onOpen={switchProject} onNew={() => setShowCreate(true)} onRefresh={refreshWorkspace} />
    {showCreate && <CreateProject busy={!!busy} onClose={() => setShowCreate(false)} onCreate={async name => { const result = await enqueue("create", () => request("/api/projects", { name })); activeProject.current = result.project.id; setState(result); setOverviewMode("edit"); setShowCreate(false); changeSurface(() => setShowHome(false)); }} />}
  </>;
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
  const decisionCount = demoSession ? visibleReviewItems(state).length : visibleReviewSlides(state).length;
  const communicationDecisions = reviewGroups(state.proposals, true);
  const active = state.workflow?.status === "planning";
  const workflowIdentity = state.workflow ? `${state.project.id}:${state.workflow.id}` : null;
  const finishingNow = !!state.workflow && observedPlanning.current === workflowIdentity && ["review", "complete"].includes(state.workflow.status);
  const justSettled = !!state.workflow && (settledWorkflow === workflowIdentity || finishingNow);
  const waiting = state.workflow?.status === "waiting";
  const pendingEmailCount = Math.max(0, state.emailDelivery?.pendingCount ?? 0);
  const latestUndo = state.activity.find((a) => a.canUndo && a.changeId && !a.automatic);
  const decisionBusy = busy !== null && busy !== "save";
  const budgetLeft = f.budgetLimitCents - state.budget.totalCents;
  const url = `/api/projects/${encodeURIComponent(state.project.id)}`;
  const planCardAction: OnPlanCardAction = (proposalId, cardId, action, revisionToken, instruction) => {
    const projectId = state.project.id;
    return enqueue(`card-${action}`, async () => {
      if (activeProject.current !== projectId) throw new Error("The selected event changed. Open its latest plan before continuing.");
      const result = await request(`${url}/proposals/${encodeURIComponent(proposalId)}/cards/${encodeURIComponent(cardId)}/${action}`, { revisionToken, ...(action === "rewrite" ? { instruction } : {}) });
      if (activeProject.current === projectId) {
        setState(result);
        if (action !== "rewrite" && view === "overview" && overviewMode === "review" && !hasRemainingReviewWork(result)) changeSurface(() => { setOverviewMode("complete"); revealSection("event-review"); });
      }
      return result;
    });
  };
  const decideBundle = (
    proposalIds: string[],
    decision: "approve" | "deny",
    approvalTokens: Record<string, string>,
    review?: DraftReview,
  ) => {
    const projectId = state.project.id;
    return enqueue(`bundle-${decision}`, async () => {
      if (activeProject.current !== projectId) throw new Error("The selected event changed. Review its latest decisions before approving.");
      let prepared = { proposalIds, approvalTokens };
      if (decision === "approve" && review) {
        prepared = await prepareEditedReview(projectId, review, {
          readState: () => request(`/api/state?projectId=${encodeURIComponent(projectId)}`, undefined, "GET"),
          saveDraft: async (proposalId, input) => {
            const next = await request(`${url}/proposals/${encodeURIComponent(proposalId)}/draft`, input, "PATCH");
            if (activeProject.current === projectId) setState(next);
            return next;
          },
        });
      }
      const result = await request(`${url}/decisions`, { ...prepared, decision });
      if (activeProject.current === projectId) {
        setState(result);
        if (view === "overview" && overviewMode === "review" && !hasRemainingReviewWork(result)) changeSurface(() => { setOverviewMode("complete"); revealSection("event-review"); });
      }
      return true;
    });
  };
  const acceptAll = (review: BatchReview) => {
    const projectId = state.project.id;
    return enqueue("accept-all", async () => {
      if (activeProject.current !== projectId) throw new Error("The selected event changed. Review its latest suggestions before accepting them.");
      let preparedState: ProjectState | undefined;
      const prepared = await prepareEditedReview(projectId, review, {
        readState: async () => {
          const latest = await request(`/api/state?projectId=${encodeURIComponent(projectId)}`, undefined, "GET");
          if (latest.project.revision !== review.revision) throw new Error("The event changed. Review the latest suggestions before accepting them.");
          preparedState = latest;
          return latest;
        },
        saveDraft: async (proposalId, input) => {
          const next = await request(`${url}/proposals/${encodeURIComponent(proposalId)}/draft`, input, "PATCH");
          preparedState = next;
          if (activeProject.current === projectId) setState(next);
          return next;
        },
      });
      if (!preparedState || activeProject.current !== projectId) throw new Error("Open the event’s latest suggestions before accepting them.");
      const result = await request(`${url}/accept-all`, { ...prepared, revision: preparedState.project.revision, planCardTokens: review.planCardTokens });
      if (activeProject.current === projectId) {
        setState(result);
        if (!hasRemainingReviewWork(result)) changeSurface(() => { setOverviewMode("complete"); revealSection("event-review"); });
      }
      return true;
    });
  };
  const undo = (id: string) =>
    mutate(
      `${url}/undo/${id}`,
      {},
      `undo-${id}`,
      "The earlier plan has been restored.",
    );
  const openIndividualDetails = (area: Area) => {
    const sectionNames: Record<Area, string> = { guests: "Guests", venue: "Venue", catering: "Catering", budget: "Budget", staff: "Staff", equipment: "Equipment", brief: "When" };
    setOverviewMode("edit");
    window.requestAnimationFrame(() => {
      const details = document.getElementById("individual-event-details") as HTMLDetailsElement | null;
      if (!details) return;
      details.open = true;
      const section = details.querySelector<HTMLElement>(`section[aria-label="${sectionNames[area]}"]`);
      if (!section) return;
      section.querySelectorAll("details").forEach(nested => { nested.open = true; });
      section.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            openHome();
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
            aria-label="Event plan"
            title="Event plan"
            className={cname(view === "overview" && "selected")}
            onClick={() => setView("overview")}
          >
            <LayoutGrid size={18} />
            <span>Event plan</span>
            {decisionCount > 0 && <b>{decisionCount}</b>}
          </button>
          <button
            aria-label="Communications"
            title="Communications"
            className={cname(view === "messages" && "selected")}
            onClick={() => setView("messages")}
          >
            <Mail size={18} />
            <span>Messages</span>
          </button>
          <button
            aria-label="Activity"
            title="Activity"
            className={cname(view === "activity" && "selected")}
            onClick={() => setView("activity")}
          >
            <History size={18} />
            <span>History</span>
          </button>
        </nav>
        <div className="nav-label events-label">
          YOUR EVENTS
          <button aria-label="Create event" onClick={() => setShowCreate(true)}>
            <Plus size={15} />
          </button>
        </div>
        <nav className="events-nav">
          {state.projects.filter(p => !demoSession || p.id === state.project.id).map((p) => (
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
            aria-label="Event settings"
            title="Event settings"
            className="presenter-toggle"
            onClick={() => setView("connections")}
          >
            <Link2 size={16} />
            <span>Connections</span>
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{view === "overview" ? "Event plan" : view === "messages" ? "Messages" : view === "activity" ? "History" : "Connections"}</span>
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
            <button
              className="icon-button"
              aria-label="View event settings"
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
                    : view === "activity"
                        ? "Event activity"
                        : "Event settings"}
              </h1>
              {view === "overview" && <p>
                  <>
                    <CalendarDays size={14} />
                    {date(f.date)}
                    <span className="separator">·</span>
                    <MapPin size={14} />
                    {f.venue || "Venue not set"}
                  </>
              </p>}
            </div>
            <div className="heading-actions">
              {latestUndo && (
                <button
                  className="secondary compact quick-undo"
                  disabled={decisionBusy}
                  title={latestUndo.title}
                  aria-label="Undo last change"
                  onClick={() => undo(latestUndo.changeId!)}
                >
                  <Undo2 size={15} />
                  Undo
                </button>
              )}
            </div>
          </div>
          {view === "overview" && (
            <>
              <section className="plan-summary" aria-label="Event at a glance">
                <span>
                  <Users size={16} />
                  <strong>{f.attendance > 0 ? `${f.attendance} guests` : "Guest count not set"}</strong>
                </span>
                <span>
                  <Wallet size={16} />
                  <strong>{state.budget.totalCents > 0 ? `${money(state.budget.totalCents)} estimated` : "Costs to confirm"}</strong>
                  {f.budgetLimitCents > 0 && budgetLeft < 0 && <small className="over-text">{money(Math.abs(budgetLeft))} over budget</small>}
                </span>
                {decisionCount > 0 && <a className="review-jump" href="#event-review" onClick={event => { event.preventDefault(); setOverviewMode("review"); revealSection("event-review"); }}>{decisionCount} to review<ArrowRight size={13} /></a>}
              </section>
              <div id="event-progress" style={{ scrollMarginTop: 24 }} className={cname("progress-presence", !!state.workflow && (active || justSettled || (waiting && pendingEmailCount === 0) || state.workflow.status === "failed") && "is-visible")}
                aria-hidden={!(state.workflow && (active || justSettled || (waiting && pendingEmailCount === 0) || state.workflow.status === "failed"))}>
                <div>{state.workflow && <WorkflowProgress workflow={state.workflow} impact={state.impact} settled={justSettled} hasDecisions={decisionCount > 0} onVisualComplete={workflowId => { if (state.workflow?.id === workflowId) setSettledWorkflow(null); }} />}</div>
              </div>
              <div className={cname("ew-content-presence", (active || justSettled) && "is-hidden")} aria-hidden={active || justSettled} inert={active || justSettled}>
                <div id="event-review" style={{ scrollMarginTop: 24 }}>
                  <EventWorkspace key={state.project.id} state={state} busy={!!busy} mode={overviewMode}
                    onSave={async (area, note, patch) => { const ok = await mutate(url, { area, ...(note.trim() ? { note } : {}), ...(patch ? { patch } : {}) }, "save", undefined, "PATCH"); if (ok) { setOverviewMode("review"); revealSection("event-progress"); } return ok; }}
                    onDecide={decideBundle} onPlanCardAction={planCardAction} onAcceptAll={acceptAll} reviewOverview={demoSession} emailDrafts={emailDrafts} setEmailDrafts={setEmailDrafts} onDetails={openIndividualDetails} onEdit={() => changeSurface(() => setOverviewMode("edit"))} />
                  {overviewMode === "edit" && decisionCount > 0 && <div className="ew-review-access"><button className="secondary" disabled={!!busy} onClick={() => changeSurface(() => { setOverviewMode("review"); revealSection("event-review"); })}>Review changes<ArrowRight size={15} /></button></div>}
                  {overviewMode === "edit" && <details className="ew-all-details" id="individual-event-details"><summary>All event details<ChevronDown size={13} /></summary><div><InlinePlan key={state.project.id} state={state} onSave={async (area: Area, patch: FactPatch) => { const ok = await mutate(url, buildPlanEdit(area, patch), "save", undefined, "PATCH"); if (ok) { setOverviewMode("review"); revealSection("event-progress"); } return ok; }} /><OperatingPlans key={`operating-plans:${state.project.id}`} state={state} /></div></details>}
                </div>
              </div>
            </>
          )}
          {view === "messages" && (
            <div className="communications-layout">
              <section>
                <VendorStatus state={state} />
                <div className="section-heading">
                  <h2>To send</h2>
                  <span className="subtle-count">
                    {communicationDecisions.length} {communicationDecisions.length === 1 ? "decision" : "decisions"}
                  </span>
                </div>
                <ReviewQueue
                  key={state.project.id}
                  state={state}
                  busy={busy}
                  onDecide={decideBundle}
                  emailDrafts={emailDrafts}
                  setEmailDrafts={setEmailDrafts}
                  communicationsOnly
                />
              </section>
              <div className="communications-side">
                <InvitationPreview state={state} />
                <CommunicationsHistory state={state} />
              </div>
            </div>
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
                {state.workflow?.error && <details className="workflow-diagnostics">
                  <summary>Technical details</summary>
                  <p>{state.workflow.error}</p>
                </details>}
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
                            {r.status === "delivered"
                              ? /^Gmail\b/i.test(r.provider) ? "Sent" : "Delivered"
                              : r.status === "simulated"
                                ? "Recorded"
                                : r.status === "local"
                                  ? "Saved locally"
                                  : "Failed"}
                          </span>
                          <small>{when(r.at)}</small>
                        </div>
                        <h3>{r.title}</h3>
                        <p>{r.detail}</p>
                        <span className="receipt-provider">{r.provider}</span>
                        {r.url && /^https:\/\//.test(r.url) && <a className="text-button" href={r.url} target="_blank" rel="noreferrer">{/^Gmail\b/i.test(r.provider) ? "View sent email" : "View delivery"}<ExternalLink size={12} /></a>}
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
                        <span className="subtle-badge">{m.simulated ? "Recorded" : m.direction === "outbound" ? "Sent" : "Received"}</span>
                        {m.url && /^https:\/\//.test(m.url) && <a className="text-button" href={m.url} target="_blank" rel="noreferrer">Open in Gmail<ExternalLink size={12} /></a>}
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
              <EventConnections key={state.project.id} projectId={state.project.id} gmailConnection={<GmailApiConnection />} />
            </>
          )}
        </div>
      </main>
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
        <h2 id="create-title">Create event</h2>
        <p>
          Name your event, then add its details.
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
              placeholder="Event name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="create-note">
            <Folder size={15} />
            Includes an editable event plan and budget.
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
