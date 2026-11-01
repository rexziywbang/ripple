# Ripple

**An event planning workspace that shows how one change affects the whole plan.**

Change a venue or guest count in plain language, review the effects on catering, staffing, equipment, and budget, then approve the next steps. Ripple combines a React interface with an AI planning assistant, persistent event state, and local semantic venue search.

Built as a HackMIT project. My contribution focused on the landing page and product demo.

**Stack:** TypeScript · React · Vite · Node.js · Express · SQLite · OpenAI Agents SDK · MiniLM

[Quick start](#quick-start) · [Try the demo](#try-the-demo) · [Architecture](#architecture) · [Development notes](docs/development.md)

## What it demonstrates

- **Changes with context.** Follow dependencies across the event rather than updating isolated fields.
- **Review before action.** Inspect proposed edits, budget changes, and message drafts before accepting them. Stale reviews are rejected.
- **Persistent workflows.** Keep event facts, approvals, jobs, and communication history across restarts, with Undo for eligible local edits.
- **Local semantic search.** Match venues using a 384-dimensional MiniLM index alongside exact names and aliases.
- **Planning with source documents.** Import a folder of event materials and retain the provenance of facts and quotes.

## Quick start

Requires **Node.js 22.11 or newer**. SQLite uses Node's experimental SQLite module.

```sh
git clone https://github.com/rexziywbang/ripple.git
cd ripple
npm ci
npm run dev
```

Open **[http://127.0.0.1:5173](http://127.0.0.1:5173)**. The API runs on port `8787`; local state is saved in `data/`.

The staged planning flow works without an API key. To enable embedding-based venue search, run `npm run venue:index` once to download and cache the model; exact-name matching remains available without it.

For AI planning, copy `.env.example` to `.env` if you do not already have one, set `OPENAI_API_KEY`, and restart the API. AI requests use the configured paid API; the app's default estimated spending cap is $6. See [AI configuration](docs/development.md#ai-configuration) for details.

## Try the demo

1. Open **[the demo home](http://127.0.0.1:5173/?demo=1)** after starting the app.
2. Choose **Upload folder** and select [`fixtures/demo-event-folder`](fixtures/demo-event-folder).
3. Open **Venue**, enter `venue has changed to marriot`, and confirm **Boston Marriott Cambridge — 50 Broadway**.
4. Review the resulting changes and proposed messages, then accept the plan to see the updated event.

The prepared packet uses fictional planning documents and a deterministic planning path, with no paid AI request. The Dropbox shortcut uses a prepared local packet; folder upload reads the files you select.

## Architecture

```text
React event workspace
        ↓
Express API → event rules, approvals, and dependency tracking
        ↓
SQLite state + persistent integration jobs

Planning: source documents + AI tools + local MiniLM venue index
```

| Area | Start here |
| --- | --- |
| Event rules and durable state | [`server/domain.ts`](server/domain.ts), [`server/store.ts`](server/store.ts) |
| AI planning and venue search | [`server/planner.ts`](server/planner.ts), [`server/venue-index.ts`](server/venue-index.ts) |
| Event editing and review UI | [`web/src/EventWorkspace.tsx`](web/src/EventWorkspace.tsx), [`web/src/ReviewQueue.tsx`](web/src/ReviewQueue.tsx) |
| Integration queue and rehearsal replies | [`server/live-bridge.ts`](server/live-bridge.ts), [`server/rehearsal-mail.ts`](server/rehearsal-mail.ts) |
| Shared data contracts | [`shared/types.ts`](shared/types.ts) |

## Project status

Ripple is a **local prototype**. Event editing, review workflows, persistent state, and rehearsal replies are implemented. AI planning requires an API key.

Email defaults to local rehearsal. Live integrations need separate configuration and execution, and some provider paths remain unverified. Accepting a plan is not evidence of external delivery. Team authentication and hosted multi-user operation are outside the current implementation.

The [development and integration notes](docs/development.md) retain the detailed provider status, validation history, and operating instructions.

## Development checks

```sh
npm test
npm run build
```

The test suite covers dependencies, approvals, budgets, quote handling, persistence, Undo, integration jobs, and reply provenance. Tests inject planner responses; live API smoke checks are separate.
