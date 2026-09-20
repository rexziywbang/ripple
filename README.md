# Ripple

A corporate event workspace with an ambient planning assistant. Edit the event, review the consequences, and let the next step resume when a reply arrives. Planning uses real AI when configured; the default email transport and vendor replies are a local rehearsal.

## Run

Requires Node 22.11 or newer (the demo uses Node's experimental SQLite module).

```sh
git clone https://github.com/rexziywbang/ripple.git
cd ripple
npm ci
npm run venue:index # one-time local embedding model setup
npm run dev
```

Open **http://127.0.0.1:5173**. The same command starts the API/background worker on **127.0.0.1:8787**. Project state persists in `data/ripple.sqlite`, integration jobs in `data/live-bridge.sqlite`, and AI usage estimates in `data/ai.sqlite`. Set `RIPPLE_DATA_DIR` to use a separate workspace without resetting the existing event.

The API deliberately runs **without file watching**, so a source edit does not interrupt a paid AI request. Restart it after backend or environment changes, preferably after current planning finishes. `npm run dev:api:watch` is available for backend development; the frontend already hot reloads under `npm run dev`.

For a built frontend, run `npm run build` followed by `npm start`, then open **http://127.0.0.1:8787**. This is a loopback-only local demo, not a hosted multi-user service.

## AI configuration

Copy `.env.example` to `.env` only if no environment file exists, then set `OPENAI_API_KEY` in that ignored server-side file. Never put a key in frontend code or commit it. Restart the API to load changes.

The planner uses the OpenAI Agents SDK for TypeScript with **gpt-6-astra** by default. Event planning and card rewrites currently use **high reasoning**; public place research uses **low reasoning**. These settings are defined in code, not an `OPENAI_REASONING_EFFORT` variable. External trace export is disabled. A restricted key needs Responses API write access.

The model reads event facts, source documents, decisions, messages, delivery receipts, and Undo history through bounded read-only tools. Trusted application code owns integer-cent budgets, dependencies, approvals, outbound payloads, and state changes. Documents and replies are treated as evidence, not instructions. Tool reads are paginated within a 100,000-character planning context budget.

`RIPPLE_AI_SPEND_LIMIT_USD` defaults to **$6**, shared by planning and live place research. The local ledger reserves before a request and settles from reported token usage; place research also records web-search fees. Interrupted or unconfirmed requests retain reservations separately from known usage. This is an app-side estimate and spending guard, not the OpenAI account balance.

With no key, the staged event has a deterministic interpreter. Semantic web research and AI card rewrites need a working key. A configured key that fails does not silently fall back to pretend AI. The event remains saved and the failure is surfaced. `npm run smoke:ai` is an optional, explicitly billable fixture check.

## Demo walkthrough

Open **http://127.0.0.1:5173/?demo=1** for the empty presentation home. Existing events remain saved and accessible from the normal workspace.

1. Choose **Connect Dropbox**, then the prepared event folder, or **Upload folder** with `fixtures/demo-event-folder`.
2. Open **Venue**, type `venue has changed to marriot`, and confirm **Boston Marriott Cambridge — 50 Broadway**.
3. Watch the continuous consequence path (~7 seconds for a fast run), then review the compact changes and choose **Accept all**.
4. The updated event details appear. One approved vendor message targets **rexziyw@gmail.com**. The linked Evite receives the approved venue and guest description without notifying guests.

The presentation import uses explicit fictional planning documents and a repeatable local planning path; it makes no paid AI request. Other events retain their normal configured AI planner. The Dropbox folder shortcut reads the prepared local packet associated with the saved folder; it is not a new Dropbox OAuth or remote-download flow. A local folder upload reads the files actually selected.

Real delivery requires the **Ripple Mail** extension loaded/reloaded and paired, with a Gmail tab and the linked Evite Review page open. Accepting in Ripple queues approved external writes; it does not by itself prove Gmail sent or Evite saved. The extension records those outcomes only after provider verification. Current external setup status is described below.

## Using the workspace

Each event opens with component boxes for guests, venue, catering, budget, staff, equipment, schedule and the event brief. Select a box and describe the change. Venue changes first show a specific place for confirmation. The compact review accepts the exact displayed proposals and plan-card versions together; stale reviews are rejected. Detailed fields remain under **All event details**, and email drafts remain editable in **Messages**.

**Connections** puts Dropbox first. Choose the already configured event folder, review the two generated documents, or import selected local planning files from Details. Other saved service destinations appear as Linked. Linking a destination is distinct from a verified upload or delivery.

Venue autocomplete uses a local 384-dimensional MiniLM embedding index, with exact-name and alias matches taking an immediate path. The checked-in catalog currently contains 16 sourced Cambridge-area venues, including MIT Johnson and Simoni ice rinks; it is not exhaustive. Run `npm run venue:index` once to cache the small model. Queries then stay local, with no API charge. Named matches remain available when the model is unavailable. Catering can use public web research. Venue selection imports its address and any published, layout-matched room capacity or AV evidence; it never establishes availability, price or a booking.

Catering prices are taken from matching imported documents or previously accepted event replies. Vendor, date, guest count, currency and arithmetic must match. A current inquiry is reused rather than drafted twice; a quote updates the forecast but never books a supplier. Fictional quotes are accepted only in rehearsal mode, with their provenance retained. The UI displays source-backed quotes or a recorded rate rather than asking the organizer to enter normal quote fields.

Guest invitations contain complete guest-facing copy. An unresolved dietary request is not turned into an availability promise. Once availability is explicitly recorded, it is included in the invitation and event description. Subsequent meal-only description updates do not create another guest email; pending invitation edits consolidate into one current draft.

Dropbox output is deliberately small: `Ripple event plan.md` contains the budget, approved operating sections and invitation status; `Leadership brief.md` summarizes the useful facts and open decisions. The invitation artwork is separate. Explicitly imported background documents stay in the planning library and become model-readable sources with provenance. `fixtures/event-folder` contains the fictional Northstar PRD, supplier notes and operating references. `POST /api/projects/:id/dropbox-materials` imports selected text files; `GET /api/projects/:id/dropbox-manifest` stages immutable files and reports per-file browser jobs. Staging is local until a browser upload is visibly verified.

The Christmas dinner invitation includes generated artwork stored locally in `web/public/invite-art/northstar-holiday.png`. Date, time, location, and meal details are rendered from the invitation's working or approved snapshot; unapproved changes stay separate from an approved version. The artwork is not regenerated for each edit or automatically uploaded to Evite or Partiful.

## Email modes and external integrations

**Default: `RIPPLE_MAIL_MODE=rehearsal`.** Approved emails to the planned event identities are recorded inside Ripple, with simulated receipts and staged vendor replies. They do not go to Gmail, even when a Gmail target is configured. This mode does not turn off real AI planning, and it does not claim real vendor agreements. Automatic replies are persisted and deduplicated across restarts.

**Opt-in: `RIPPLE_MAIL_MODE=live`.** Restart the API with this setting to queue approved emails for a local browser executor. Existing operator-configured account and recipient settings are used; changing configuration later cannot reroute an already approved payload. The optional [Ripple Mail extension](extensions/ripple-mail/README.md) implements persistent sending and tracked-reply capture, but installation, pairing, and a real extension-driven send remain **unverified**. Its Gmail adapter allows the signed-in account or the explicitly configured demo recipient rexziyw@gmail.com. The new Evite adapter updates the linked invitation’s title, venue and description; date/time editing is outside this adapter’s current scope. Do not treat prior supervised Gmail tests as proof that this worker is running.

New presentation imports have a persisted per-event live-email setting; other events keep their previous mode. Email mode affects email only. Calendar, Dropbox, and invitation metadata can still be staged for configured destinations. `npm run dev` alone does **not** execute those browser writes. No browser cookies, passwords, or Google refresh tokens are extracted or stored.

Verified session outcomes and limits as of September 20, 2026:

| Component | Current state |
|---|---|
| Event editing, persisted jobs, budgets, approvals, Undo, and plan cards | Implemented locally; AI planning and rewrites use the configured API |
| Rehearsal email and vendor replies | Automatic local simulation; no external delivery |
| Gmail | Supervised own-inbox sends and a captured sample quote verified; optional extension execution still unverified |
| Google Calendar | A private event and a metadata update were created, reopened, and verified; future queued updates need a browser executor |
| Dropbox | Signed-in browser and private folder configured. Upload/retry stalled and the attempt was canceled and marked failed; no file uploaded. Current plan changes stage two reports, artwork and imported reference files; remote uploads still require the browser executor |
| Partiful | Private Christmas dinner event saved and verified, with zero invited guests; saved event URL configured |
| Evite | Christmas dinner draft saved and reopened to verify details and an empty guest list; saved draft URL configured |
| Invitation updates | Only approved-and-applied snapshots queue metadata updates, with no guest lists or notifications. Subsequent queued event-edit jobs remain unverified |
| Invitation artwork | Local in-app artwork and logistics preview; no provider upload verified |
| Hosting, team authentication, account billing controls | Not implemented |

The initial Partiful event and Evite draft use the fictional dinner's planning details. No invitations or guest notifications were sent. Partiful also has a pinned optional CLI; its separate authentication and account reads remain unverified. See [CLI setup](docs/partiful-cli.md).

Undo restores eligible local values without overwriting unrelated later edits. Superseded queued sends are canceled; running jobs retain their outcome for reconciliation. Prior deliveries and simulations remain in history. Undo cannot unsend an email or reinstate a real vendor contract.

## Advanced browser execution and captured replies

For the optional live path, an operator can configure saved targets through `PUT /api/projects/:id/integrations`; normal Settings does not expose technical configuration fields. The supervised local browser executor uses:

- `GET /api/bridge/jobs?projectId=...` to inspect work.
- `POST /api/bridge/claim` with `{ "workerId": "local-browser" }` to claim the oldest queued job. Inspect its provider, destination, and immutable payload before acting.
- The signed-in browser UI to execute that exact job, then `POST /api/bridge/jobs/:id/complete` with observed `detail`, optional `url` and `externalId`, or `/fail` with an `error`.

Only record completion after visible success. A running or uncertain send is not retried automatically; reconcile it in Gmail first to avoid duplicates. Calendar and invitation metadata jobs do not add guests or notify them. Initial configuration without an applied invitation snapshot queues no invitation update.

Captured Gmail replies enter `POST /api/projects/:id/mail-replies` with observed message ID, plain-text body, subject, sender, timestamp, and optional Gmail thread URL. A valid quote must match an actual delivered request, current vendor/date/headcount, expected sender, and conversation. The parser requires explicit USD Vendor, Event date, Guests, Per person, Delivery, and Total fields with reconciled amounts. Missing or ambiguous amounts never become zero. An accepted quote can update the forecast and prepare a booking request; it cannot confirm a booking.

A matched current ordinary reply can instead become a source for a qualitative AI review, without automatically changing facts or money. Unsafe, ambiguous, or unmatched replies stay available for review. Accepted external message IDs are deduplicated. The extension's tracked-thread capture remains locally tested rather than externally verified.

## Verification and implementation

```sh
npm test
npm run build
```

Tests cover budgeting, dependencies, stale/denied work, quote/cancellation/booking sequencing, repeated card rewrites, serialization, restart/idempotency, Undo, rehearsal scheduling, durable bridge claims, and reply provenance. Planner tests inject SDK results; they are separate from the optional live API smoke check.

Prior real transport evidence: supervised Gmail sends were followed by a self-addressed sample quote of **240 × $27.50 + $180 = $6,780**. The forecast became **$22,740**, retaining the old $5,760 catering commitment until cancellation confirmation; booking remained unapproved. These were fictional terms transported through real Gmail. A private Google Calendar event for December 11, 2026, 6–9 PM Eastern was reopened after its venue/address and 200-guest planning note were updated. No guests or notifications were added.

Key files:

- `server/domain.ts`, `server/store.ts`, `shared/types.ts`: event rules, durable state, and the UI/API contract.
- `server/planner.ts`, `server/place-research.ts`, `server/venue-index.ts`, `server/places.ts`: planning, web research, usage guard, and local semantic search.
- `server/rehearsal-mail.ts`, `server/live-bridge.ts`, `server/mail-extension.ts`: simulated reply scheduling and the separate live execution paths.
- `web/src/PlanCardDeck.tsx`, `ReviewQueue.tsx`, `EventConnections.tsx`, `InvitationPreview.tsx`: review cards, communications, settings, and invitation preview.
- `server/index.ts`: local HTTP API and background loop.
- `server/fixtures.ts`: fictional event documents and agreements.

The supplied corporate HTML reference has not been modified or published.
