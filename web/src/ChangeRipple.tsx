import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, Check, ClipboardList, Clock3, MapPin, Monitor, Users, Utensils, Wallet } from "lucide-react";
import type { Area, ChangeImpact } from "../../shared/types";
import "./change-ripple.css";

export type RippleNode = ChangeImpact["nodes"][number];
export type RippleImpact = ChangeImpact;
type Props = { impact: RippleImpact; compact?: boolean; activeProposalId?: string; animate?: boolean };
type Bounds = { left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };
type Geometry = { width: number; height: number; boxes: Record<string, Bounds> };
const icons = { venue: MapPin, guests: Users, catering: Utensils, budget: Wallet, staff: Users, equipment: Monitor, brief: ClipboardList };
const areaNames: Record<Area, string> = { venue: "Venue", guests: "Guests", catering: "Catering", budget: "Budget", staff: "Staff", equipment: "Equipment", brief: "Event plan" };
const statusLabels: Record<RippleNode["status"], string> = { checking: "Checking", updated: "Updated", review: "For review", waiting: "Waiting" };
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Preserve real branches, merge points and stable positions as statuses change. */
export function rippleLevels(impact: Pick<RippleImpact, "nodes" | "edges">) {
  const nodes = [...new Map(impact.nodes.filter(node => node.id !== "change").map(node => [node.id, node])).values()];
  const known = new Set(["change", ...nodes.map(node => node.id)]);
  const edges = [...new Map(impact.edges.filter(edge => known.has(edge.from) && known.has(edge.to) && edge.to !== "change" && edge.from !== edge.to).map(edge => [`${edge.from}:${edge.to}`, edge])).values()];
  const depth = new Map<string, number>([["change", 0]]);
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    // Invalid cyclic data stays readable; it must not hang the event workspace.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter(edge => edge.to === id);
    const level = Math.max(1, ...parents.map(edge => visit(edge.from) + 1));
    visiting.delete(id);
    depth.set(id, level);
    return level;
  };
  nodes.forEach(node => visit(node.id));
  const levels = [...new Set(nodes.map(node => depth.get(node.id)!))].sort((a, b) => a - b)
    .map(level => ({ depth: level, nodes: nodes.filter(node => depth.get(node.id) === level) }));
  return { nodes, edges, levels, depth };
}

/** A signal reaches each causal layer before the cards settle into view. */
export function rippleArrivalMs(depth: number, position = 0) {
  return Math.min(4900, 1250 * Math.max(1, depth) + Math.min(position, 3) * 130);
}

/** Shared row buses and column gaps keep wrapped branches out of the cards. */
export function rippleRoute(from: Bounds, to: Bounds, width: number, obstacles: Bounds[] = []): Point[] {
  const x1 = from.left + from.width / 2;
  const y1 = from.top + from.height;
  const x2 = to.left + to.width / 2;
  const y2 = to.top;
  const nextRow = Math.min(y2, ...obstacles.filter(box => box.top >= y1 && box !== from).map(box => box.top));
  const previousRow = Math.max(y1, ...obstacles.filter(box => box.top + box.height <= y2 && box !== to).map(box => box.top + box.height));
  const exit = y1 + Math.min(16, Math.max(4, (nextRow - y1) / 2));
  const enter = y2 - Math.min(16, Math.max(4, (y2 - previousRow) / 2));
  const blocked = obstacles.filter(box => box !== from && box !== to && box.top < enter && box.top + box.height > exit);
  const intervals = blocked.map(box => ({ left: Math.max(0, box.left - 4), right: Math.min(width, box.left + box.width + 4) })).sort((a, b) => a.left - b.left);
  const candidates = [x1, x2];
  let right = 0;
  for (const interval of intervals) {
    if (interval.left > right) candidates.push((right + interval.left) / 2);
    right = Math.max(right, interval.right);
  }
  if (right < width) candidates.push((right + width) / 2);
  const clear = candidates.filter(x => !intervals.some(interval => x > interval.left && x < interval.right));
  const spine = clear.sort((a, b) => (Math.abs(a - x1) + Math.abs(a - x2)) - (Math.abs(b - x1) + Math.abs(b - x2)))[0] ?? 2;
  return [{ x: x1, y: y1 }, { x: x1, y: exit }, { x: spine, y: exit }, { x: spine, y: enter }, { x: x2, y: enter }, { x: x2, y: y2 }]
    .filter((point, index, points) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

export function rippleConnector(from: Bounds, to: Bounds, width: number, obstacles: Bounds[] = []) {
  const points = rippleRoute(from, to, width, obstacles);
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1], corner = points[index], after = points[index + 1];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2);
    const start = { x: corner.x + (before.x - corner.x) * radius / incoming, y: corner.y + (before.y - corner.y) * radius / incoming };
    const end = { x: corner.x + (after.x - corner.x) * radius / outgoing, y: corner.y + (after.y - corner.y) * radius / outgoing };
    path += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y} ${end.x} ${end.y}`;
  }
  return `${path} L ${points.at(-1)!.x} ${points.at(-1)!.y}`;
}

export function rippleNodeCopy(node: RippleNode) {
  const localRecord = node.status === "updated" && / · \d+ files? updated locally$/.test(node.detail);
  return {
    detail: localRecord ? node.detail.replace(/ · \d+ files? updated locally$/, "") : node.detail,
    status: localRecord ? "Plan updated" : statusLabels[node.status],
  };
}

function StatusMark({ status }: { status: RippleNode["status"] }) {
  return <span className={`cr-status-mark cr-status-${status}`} aria-hidden="true">
    {status === "updated" ? <Check size={11} strokeWidth={1.8} /> : status === "waiting" ? <Clock3 size={11} strokeWidth={1.7} /> : <span />}
  </span>;
}

function ChangeSeed({ impact, compact }: { impact: RippleImpact; compact?: boolean }) {
  const Icon = icons[impact.area];
  const hasDifference = Boolean(impact.before || impact.after);
  return <>
    <span className="cr-seed-icon" aria-hidden="true"><Icon size={compact ? 16 : 19} strokeWidth={1.65} /></span>
    <div className="cr-seed-copy">
      <h3>{impact.title}</h3>
      {hasDifference ? <p className="cr-change-values">{impact.before && <span className="cr-before">{impact.before}</span>}{impact.before && impact.after && <ArrowRight size={14} aria-label="changed to" />}{impact.after && <span className="cr-after">{impact.after}</span>}</p>
        : impact.note && impact.note !== impact.title ? <p className="cr-seed-note">{impact.note}</p> : null}
    </div>
  </>;
}

export default function ChangeRipple({ impact, compact = false, activeProposalId, animate = true }: Props) {
  const layout = useMemo(() => rippleLevels(impact), [impact]);
  const surface = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const gradientId = `cr-gradient-${useId().replace(/:/g, "")}`;
  const geometryKey = `${impact.id}:${layout.nodes.map(node => `${node.id}:${node.label}:${node.detail}`).join("|")}:${layout.edges.map(edge => `${edge.from}>${edge.to}`).join("|")}`;
  useBrowserLayoutEffect(() => {
    if (compact || !surface.current) return;
    const host = surface.current;
    const measure = () => {
      const boxes: Record<string, Bounds> = {};
      for (const [id, element] of elements.current) {
        // Layout coordinates deliberately ignore the arrival animation's transform.
        let left = 0;
        let top = 0;
        let ancestor: HTMLElement | null = element;
        while (ancestor && ancestor !== host) {
          left += ancestor.offsetLeft;
          top += ancestor.offsetTop;
          ancestor = ancestor.offsetParent as HTMLElement | null;
        }
        boxes[id] = { left, top, width: element.offsetWidth, height: element.offsetHeight };
      }
      const next = { width: host.clientWidth, height: host.clientHeight, boxes };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    elements.current.forEach(element => observer?.observe(element));
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [compact, geometryKey]);

  if (compact) return <section className="change-ripple cr-compact" aria-label="What this decision follows from">
    <div className="cr-compact-seed"><ChangeSeed impact={impact} compact /></div>
    {layout.nodes.length > 0 && <ul className="cr-affected" aria-label="Affected parts of your event">{layout.nodes.map(node => {
      const active = Boolean(activeProposalId && node.proposalIds.includes(activeProposalId));
      return <li key={node.id} className={`cr-affected-node cr-${node.status}${active ? " cr-current" : ""}`} aria-current={active ? "step" : undefined} title={node.detail}>
        <StatusMark status={node.status} /><span>{node.label}</span><span className="cr-sr"> — {statusLabels[node.status]}{active ? ", current decision" : ""}</span>
      </li>;
    })}</ul>}
  </section>;

  const labels = new Map<string, string>([["change", impact.title], ...layout.nodes.map(node => [node.id, node.label] as const)]);
  return <section className={`change-ripple cr-full${animate ? " cr-animate" : ""}`} aria-label="How this change affects your event">
    <div className="cr-heading"><span className="cr-ripple-glyph" aria-hidden="true"><i /><i /><i /></span><span>Following the change</span></div>
    <div className="cr-map" ref={surface} key={impact.id}>
      <svg className="cr-connectors" width="100%" height="100%" viewBox={geometry ? `0 0 ${geometry.width} ${geometry.height}` : undefined} aria-hidden="true">
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a57496" /><stop offset="100%" stopColor="#ce9b86" /></linearGradient></defs>
        {geometry && layout.edges.map(edge => {
          const from = geometry.boxes[edge.from];
          const to = geometry.boxes[edge.to];
          const node = layout.nodes.find(item => item.id === edge.to)!;
          if (!from || !to) return null;
          const path = rippleConnector(from, to, geometry.width, Object.values(geometry.boxes));
          const active = Boolean(activeProposalId && node.proposalIds.includes(activeProposalId));
          const delay = Math.max(0, rippleArrivalMs(layout.depth.get(node.id)!) - 950);
          return <g key={`${edge.from}:${edge.to}`} data-from={edge.from} data-to={edge.to} className={`cr-edge cr-edge-${node.status}${active ? " cr-current" : ""}`} style={{ "--cr-edge-delay": `${delay}ms` } as CSSProperties}>
            <path className="cr-edge-track" d={path} /><path className="cr-edge-line" stroke={`url(#${gradientId})`} d={path} pathLength={1} />
            {node.status === "checking" && <path className="cr-edge-signal" d={path} pathLength={1} />}
          </g>;
        })}
      </svg>
      <div className="cr-seed" ref={element => { if (element) elements.current.set("change", element); else elements.current.delete("change"); }}><ChangeSeed impact={impact} /></div>
      <div className="cr-branches">
        {layout.levels.map(level => <div className="cr-layer" key={level.depth} data-depth={level.depth}>
          {level.nodes.map((node, position) => {
            const Icon = icons[node.area];
            const active = Boolean(activeProposalId && node.proposalIds.includes(activeProposalId));
            const copy = rippleNodeCopy(node);
            return <article key={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }} className={`cr-node cr-${node.status}${active ? " cr-current" : ""}`} data-node-id={node.id} data-status={node.status} aria-label={`${node.label}: ${copy.status}`} aria-current={active ? "step" : undefined} style={{ "--cr-arrival": `${rippleArrivalMs(level.depth, position)}ms` } as CSSProperties}>
              <span className="cr-node-port" aria-hidden="true" />
              <div className="cr-node-heading"><Icon size={16} strokeWidth={1.7} aria-hidden="true" /><h4>{node.label}</h4></div>
              <p className="cr-node-detail" title={node.detail}><span aria-hidden="true">{copy.detail || areaNames[node.area]}</span><span className="cr-sr">{node.detail || areaNames[node.area]}</span></p>
              <span className="cr-node-status"><StatusMark status={node.status} />{copy.status}</span>
            </article>;
          })}
        </div>)}
      </div>
    </div>
    <ul className="cr-sr" aria-label="Connections between changes">{layout.edges.map(edge => <li key={`${edge.from}:${edge.to}`}>{labels.get(edge.from)} affects {labels.get(edge.to)}.</li>)}</ul>
  </section>;
}
