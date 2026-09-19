# Ripple

Ripple is a corporate-event planning collaborator that **remembers consequences**. Tell it one thing changed — attendance, venue, caterer, budget, staff, schedule, equipment — and it follows the ripple through every other planning area, reads the source documents for evidence, drafts the updates and messages, and waits for your explicit approval before anything is written or sent.

Sample event: the *Northwind Christmas Dinner* (240 guests, 18 Dec 2026, Garden Hall, $18,000 ceiling), imported from a Dropbox-style folder of briefs, contracts, quotes, guest lists and rosters under `fixtures/christmas-dinner`.

## Quick start

```bash
npm install
cp .env.example .env.local     # optional — everything runs in demo mode without it
npm run dev                    # web (http://localhost:3000) + worker, in one terminal
```

On first start the SQLite database (`data/ripple.db`) is created, migrated and seeded with the sample event. The web app and the worker are separate Node processes sharing that file: the web app only records requests and approvals; the worker does all planning, execution and inbound processing, so a browser refresh, a worker restart or a laptop sleep never loses state.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev:web` / `npm run dev:worker` | run either process on its own |
| `npm run build && npm start` + `npm run worker` | production web server and worker |
| `npm run db:reset` | discard the sample project's history and re-import the fixtures |
| `npm run db:generate` | regenerate Drizzle migrations after editing `lib/db/schema.ts` |
| `npm run check` | typecheck + lint + Vitest engine tests |
| `npm run test:e2e` | production build + Playwright critical journeys (uses `data/e2e.db`) |

Requires Node 20+ (developed on Node 22).

## Three-minute demo

1. **Home** → *Explore sample event*. The dashboard shows the $15,960 forecast with committed / sunk / estimated money kept apart, and the three integrations (Dropbox, Gmail, Invitations) each in demo mode.
2. Open **Catering and vendors**. Facts (caterer, price per guest, dietary options) link to the documents they came from — click one to read the source.
3. Type or pick the example **“Cancel catering from Shah Halal and contact CAVA instead.”** and press *Follow the consequences*. The progress path runs Understand → Check sources → Follow consequences → Prepare updates → Ready to review.
4. The **review report** is grouped by area: a cancellation notice to Shah Halal, a quote request to CAVA, a wait for the quote, a note that the **$600 deposit is sunk** (non-refundable per the agreement) and a prospective release of the $5,160 balance held until Shah acknowledges. Nothing has changed yet. Untick anything you don't want, then *Apply*.
5. Both emails are sent through the demo Gmail adapter with a **simulated receipt**; the workflow moves to *Waiting on others*. Reload the page — it is still waiting.
6. **Activity → Demo controls** → *Receive* “CAVA quote (240 guests)”. The quote is parsed as evidence, cross-checked against attendance and date, and stored with provenance. The forecast updates honestly: until Shah acknowledges, it shows $22,440 with a *$5,160 prospective saving pending confirmation*.
7. *Receive* “Shah Halal cancellation acknowledgement” → the balance is released, the deposit stays sunk, the forecast is **$17,280 / $18,000**.
8. Approve **Accept the CAVA quote** → the acceptance email goes out and the booking is *awaiting confirmation*. *Receive* “CAVA booking confirmation” → the caterer of record flips to CAVA, staff are told, and the file/budget/invitation updates that were gated on confirmation come up for review.
9. Try the others: “Attendance is now 300.” (capacity warning, staffing 4 → 5, caterer count update), “The venue has changed to Marriott Hotel.” (duplicate AV, cancellation gated on the new booking), “Two staff members are no longer available.”, “Move the dinner back one hour.”, “Reduce the total budget to $15,000.”.
10. Rehearse failure: in Demo controls set Gmail's *next send* to *transient*, *uncertain* or *permanent* and apply a change with an email. Transient → retry succeeds with exactly one send; uncertain → Ripple asks the provider whether it went out before ever resending; permanent → *Needs attention*. Bump the Dropbox revision to see a file write refuse to overwrite a changed document.

## How it is built

```
app/            Next.js 16 App Router: pages + JSON API (app/api/**)
components/     UI (project list, workspace, area panel, workflow review, activity/inbox, demo controls)
lib/db          Drizzle schema, SQLite client (WAL), migrations, fixture seed
lib/domain      areas, facts, money, file projections
lib/planner     interpretation (LLM or deterministic fallback), entity resolution, consequence rules
lib/workflows   workflow state machine, review/approval, execution, inbound-evidence processing
lib/jobs        durable job queue (leases, idempotency keys) and worker loop
lib/integrations demo + live adapters for Gmail, Dropbox, invitations; LLM client
worker/         the separate worker process
fixtures/       the sample event's documents and the inbound vendor-reply fixtures
tests/          Vitest engine tests · e2e/  Playwright journeys
```

**Deterministic where it matters.** Arithmetic, versions, ordering, dependencies, approvals, idempotency and execution are plain code. Model reasoning is confined to interpreting the request, reading evidence and drafting text. Without `LLM_API_KEY` (or when the model call fails validation) the bounded deterministic interpreter runs instead and the UI labels the result **Demo reasoning**.

**Proposals, not actions.** Every consequence becomes a proposal with its evidence, before/after, cost effect and dependencies. External messages, cancellations, bookings, invitation changes and file writes require an approval whose scope (recipients, content hash) is checked again at send time. Proposals go **stale** if the facts they were based on change before approval.

**Money is never blurred.** Each line carries a status — *Unknown, Estimated, Quoted, Committed, Sunk, Prospective, Released* — and the dashboard totals them separately. An unknown cost is shown as unknown, not zero; an estimate never becomes a quote by itself; a non-refundable deposit stays sunk after cancellation.

**Evidence is not instruction.** Imported documents and inbound emails are quoted as evidence only. Replies are matched to the vendor thread and verified sender; a reply from an unexpected address is held, and text like “ignore previous instructions…” inside an email changes nothing.

**Durable and idempotent.** Workflows, tasks, approvals, external actions and jobs all live in SQLite. Jobs are leased with a timeout so a crashed worker's job is reclaimed; external sends have idempotency keys and an *uncertain* state that is reconciled against the provider before any retry.

## Integrations — what is real

| Provider | Demo mode (default) | Live mode |
| --- | --- | --- |
| **Dropbox** | Fixture folder is the "remote"; writes are recorded as new revisions; a bumped remote revision produces a real conflict. | `files/upload` in *update* mode with the last known `rev`, so a changed remote file is a conflict, never an overwrite. Needs `DROPBOX_ACCESS_TOKEN`. Reading/syncing changes from Dropbox is **not** implemented. |
| **Gmail** | Simulated sends with receipts; vendor replies are fixtures fed through the same inbound pipeline. | Sends via `users.messages.send` with an OAuth refresh token; reconciliation searches Sent mail by idempotency key. Needs the four `GMAIL_*` variables. **Inbound polling is not implemented** — replies must arrive via `POST /api/projects/:id/inbound`. Fixture `.example` addresses are always refused live. |
| **Invitations** | Simulated update with a receipt. | No provider is bundled; live mode turns the step into a *manual* task with the approved text to paste, which you mark done. |
| **LLM** | Deterministic "Demo reasoning". | Any OpenAI-compatible endpoint with JSON-schema output (`LLM_*`). Output is Zod-validated; on failure Ripple falls back and says so. |

Switch a project's connection between demo and live in **Demo controls**; switching to live without the credentials in the environment is refused (HTTP 409) rather than silently simulated.

## API

`GET/POST /api/projects` · `POST /api/projects/sample` (reset) · `GET/PATCH /api/projects/:id` · `POST /api/projects/:id/workflows` · `POST /api/projects/:id/inbound` · `PATCH /api/projects/:id/connections` · `GET /api/projects/:id/documents/:docId` · `POST /api/workflows/:id/review` · `POST /api/workflows/:id/clarify` · `POST /api/workflows/:id/retry` · `POST /api/actions/:id` (mark manual step done). All bodies are Zod-validated; the UI polls `GET /api/projects/:id` (faster while work is in flight).

## Limitations

- The deterministic interpreter understands a bounded set of changes (attendance, budget ceiling, venue, vendor cancel/quote, dietary options, schedule shifts, format, venue-provided equipment, staff availability, extra equipment, date). Anything else asks you to rephrase.
- Single-user; no authentication. Approvals are recorded as "you".
- Live Dropbox is write-only and live Gmail is send-only (see table above). No calendar, payment or invitation vendor integrations.
- Consequence rules are the sample policies in the fixtures (1 staff per 60 guests at $300, etc.), not a general rules engine.
- Polling rather than SSE; the UI shows worker-offline when the worker heartbeat goes stale.
