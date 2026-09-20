import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ChangeRipple, { rippleArrivalMs, rippleConnector, rippleLevels, rippleNodeCopy, rippleRoute, type RippleImpact } from "../web/src/ChangeRipple";

const impact: RippleImpact = {
  id: "venue-change-1", title: "Venue changed", area: "venue", before: "Garden Hall", after: "Boston Marriott Cambridge",
  nodes: [
    { id: "equipment", area: "equipment", label: "Equipment", detail: "Venue AV replaces the $1,800 rental.", status: "review", proposalIds: ["remove-rental"] },
    { id: "catering", area: "catering", label: "Catering", detail: "New delivery entrance for the caterer.", status: "checking", proposalIds: ["vendor-email"] },
    { id: "budget", area: "budget", label: "Budget", detail: "$15,000 → $14,000 forecast", status: "updated", proposalIds: [] },
    { id: "staff", area: "staff", label: "Staff", detail: "Setup timing follows the delivery window.", status: "waiting", proposalIds: ["staff-plan"] },
  ],
  edges: [{ from: "change", to: "equipment" }, { from: "change", to: "catering" }, { from: "equipment", to: "budget" }, { from: "catering", to: "staff" }],
};

describe("causal change ripple", () => {
  it("preserves two real branches and their consequences instead of a canned linear checklist", () => {
    const result = rippleLevels(impact);
    expect(result.edges).toEqual(impact.edges);
    expect(result.levels.map(level => ({ depth: level.depth, ids: level.nodes.map(node => node.id) }))).toEqual([
      { depth: 1, ids: ["equipment", "catering"] }, { depth: 2, ids: ["budget", "staff"] },
    ]);
    expect(result.edges).not.toContainEqual({ from: "equipment", to: "catering" });
  });

  it("places a merge after all its parents and does not invent links for an isolated node", () => {
    const merged: RippleImpact = { ...impact, nodes: [...impact.nodes, { id: "brief", area: "brief", label: "Event brief", detail: "Updated event details", status: "updated", proposalIds: [] }], edges: [...impact.edges, { from: "staff", to: "budget" }] };
    const result = rippleLevels(merged);
    expect(result.depth.get("budget")).toBe(3);
    expect(result.depth.get("brief")).toBe(1);
    expect(result.edges.some(edge => edge.to === "brief")).toBe(false);
  });

  it("keeps graph positions stable when live statuses change and filters invalid edges", () => {
    const later: RippleImpact = { ...impact, nodes: impact.nodes.map(node => ({ ...node, status: "updated" })), edges: [...impact.edges, { from: "missing", to: "staff" }, { from: "staff", to: "staff" }, impact.edges[0]] };
    expect(rippleLevels(later).levels.map(level => level.nodes.map(node => node.id))).toEqual(rippleLevels(impact).levels.map(level => level.nodes.map(node => node.id)));
    expect(rippleLevels(later).edges).toEqual(impact.edges);
    expect(() => rippleLevels({ nodes: impact.nodes, edges: [{ from: "catering", to: "staff" }, { from: "staff", to: "catering" }] })).not.toThrow();
  });

  it("renders the exact before and after with actual status evidence and accessible causality", () => {
    const html = renderToStaticMarkup(createElement(ChangeRipple, { impact }));
    expect(html.indexOf("Garden Hall")).toBeLessThan(html.indexOf("Boston Marriott Cambridge"));
    expect(html).toContain("Equipment affects Budget.");
    expect(html).toContain("Catering affects Staff.");
    expect(html).not.toContain("Equipment affects Catering.");
    expect(html).toContain('data-node-id="catering" data-status="checking"');
    expect(html).toContain('data-node-id="staff" data-status="waiting"');
    expect(html).toContain('aria-label="Budget: Updated"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<strong");
    expect(html).not.toContain("All done");
  });

  it("keeps the cause and the exact current proposal visible in compact review mode", () => {
    const html = renderToStaticMarkup(createElement(ChangeRipple, { impact, compact: true, activeProposalId: "vendor-email" }));
    expect(html).toContain("Boston Marriott Cambridge");
    expect(html).toContain('class="cr-affected-node cr-checking cr-current" aria-current="step"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("Checking, current decision");
    expect(html).not.toContain('class="cr-connectors"');
    expect(html).not.toContain("<button");
  });

  it("stages arrival by causal depth without changing backend statuses", () => {
    expect(rippleArrivalMs(2) - rippleArrivalMs(1)).toBe(1250);
    expect(rippleArrivalMs(3) - rippleArrivalMs(2)).toBe(1250);
    expect(rippleArrivalMs(4)).toBeLessThanOrEqual(4900);
    expect(rippleArrivalMs(1, 1)).toBeGreaterThan(rippleArrivalMs(1));
    const html = renderToStaticMarkup(createElement(ChangeRipple, { impact: { ...impact, nodes: impact.nodes.map(node => ({ ...node, status: "checking" as const })) } }));
    expect(html).not.toContain("Updated</span>");
    expect(html.match(/data-status="checking"/g)).toHaveLength(4);
    expect(html).toContain("--cr-arrival:2500ms");
  });

  it("routes wrapped branches and budget merges through clear row and column gaps", () => {
    for (const columns of [2, 3]) {
      const width = columns === 3 ? 510 : 330;
      const cardWidth = (width - 16 - (columns - 1) * 18) / columns;
      const seed = { left: (width - 280) / 2, top: 0, width: 280, height: 70 };
      const cards = Array.from({ length: 5 }, (_, index) => ({ left: 8 + (index % columns) * (cardWidth + 18), top: 98 + Math.floor(index / columns) * 118, width: cardWidth, height: 94 }));
      const budget = { left: (width - 280) / 2, top: cards.at(-1)!.top + 122, width: 280, height: 94 };
      const boxes = [seed, ...cards, budget];
      for (const [from, to] of [...cards.map(card => [seed, card]), ...cards.map(card => [card, budget])]) {
        const route = rippleRoute(from, to, width, boxes);
        expect(route[0]).toEqual({ x: from.left + from.width / 2, y: from.top + from.height });
        expect(route.at(-1)).toEqual({ x: to.left + to.width / 2, y: to.top });
        for (let index = 1; index < route.length; index++) {
          const a = route[index - 1], b = route[index];
          expect(a.x === b.x || a.y === b.y).toBe(true);
          for (const box of boxes.filter(box => box !== from && box !== to)) {
            const intersects = a.x === b.x
              ? a.x > box.left && a.x < box.left + box.width && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.top + box.height
              : a.y > box.top && a.y < box.top + box.height && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.left + box.width;
            expect(intersects).toBe(false);
          }
        }
        expect(rippleConnector(from, to, width, boxes)).not.toMatch(/NaN|Infinity/);
        expect(rippleConnector(from, to, width, boxes)).toContain(" Q ");
      }
    }
  });

  it("uses a concise local-record status while retaining the full accessible detail", () => {
    const node = { ...impact.nodes[2], detail: "$15,000 forecast · 2 files updated locally" };
    expect(rippleNodeCopy(node)).toEqual({ detail: "$15,000 forecast", status: "Plan updated" });
    expect(rippleNodeCopy({ ...node, status: "waiting" }).status).toBe("Waiting");
    const html = renderToStaticMarkup(createElement(ChangeRipple, { impact: { ...impact, nodes: [node] } }));
    expect(html).toContain('title="$15,000 forecast · 2 files updated locally"');
    expect(html).toContain('<span class="cr-sr">$15,000 forecast · 2 files updated locally</span>');
    expect(html).toContain('aria-label="Budget: Plan updated"');
  });

  it("turns off motion for reduced-motion preferences and allows an immediate settled graph", () => {
    const css = readFileSync(new URL("../web/src/change-ripple.css", import.meta.url), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important; transition: none !important;");
    expect(css).toContain(".cr-edge-signal { display: none; }");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain("@container (min-width: 480px)");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    const html = renderToStaticMarkup(createElement(ChangeRipple, { impact, animate: false }));
    expect(html).not.toContain("cr-full cr-animate");
    expect(html).toContain("$15,000 → $14,000 forecast");
  });
});
