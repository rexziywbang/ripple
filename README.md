# Ripple

A corporate event workspace with an ambient planning assistant. Change the plan normally; Ripple follows the consequences, prepares reviewable updates, waits for replies, and remembers what needs to happen next.

## Run

Requires Node 22.11 or newer (the local demo uses Node's experimental SQLite module).

```sh
git clone https://github.com/rexziywbang/ripple.git
cd ripple
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The API/background worker listens on 127.0.0.1:8787. Both processes start with the one command. Data persists in `data/ripple.sqlite` (`RIPPLE_DATA_DIR` can select a separate demo directory); the AI usage ledger is separate in `data/ai.sqlite`. Stopping and restarting the app retains projects, decisions, vendor waits, and receipts.

For a built frontend:

```sh
npm run build
npm start
```

Then open http://127.0.0.1:8787. The app binds to loopback and is a local demo, not a deployed multi-user service.

## OpenAI

The real planner uses the OpenAI Agents SDK for TypeScript, `@openai/agents`. The configured primary model is **gpt-6-astra**, with medium reasoning, bounded tools and structured output. Read-only tools retrieve event facts and source documents and calculate budget arithmetic. Trusted application code controls proposals, approvals, state versions, outbound simulations, and Undo.

Copy `.env.example` to `.env` only if you have not already configured a key. Set `OPENAI_API_KEY` in that ignored server-side file. Never put it in frontend code or commit it. The server reads the file at startup. A restricted key needs Responses API write permission; model listing read permission is useful for account checks. External trace export is disabled.

`RIPPLE_AI_SPEND_LIMIT_USD` defaults to $2. The SQLite ledger reserves a conservative amount before a run and settles the estimate using reported input/output tokens, including billed reasoning output. Unknown failed-call usage keeps its reservation. This is an app-side estimate and guard, not an authoritative view of the account balance. Other apps' spending is outside this ledger.

Run one explicit, billable fixture check with:

```sh
npm run smoke:ai
```

No-key mode uses a clearly labeled deterministic demo interpreter. A configured key that fails does not silently fall back to pretend AI. A live failure leaves the event saved and shows the issue. The harness distinguishes rejected configuration/access/quota requests, temporary network failures, and invalid/ungrounded model results. Recovery is bounded and cannot dispatch external side effects or bypass approval.

## Three-minute demo

1. Open **Christmas dinner**: 240 guests, $15,960 forecast, $18,000 ceiling.
2. Change Expected guests to 300 directly on the event plan. Press Enter or move to the next field to save. Keep working while related updates are prepared. See the 260-seat room constraint, increased catering forecast, and a proposed fifth staff member. Approve the staffing change; use Undo last change at the top of the event plan to reverse it.
3. Reset the sample event from the separately labeled presenter controls.
4. Change Catering partner to CAVA directly on the event plan. It saves when you leave the field.
5. Review the visible cancellation and quote-request drafts beside the plan, then approve or deny. Communications keeps the vendor replies and sent-message history together. Their receipts explicitly say simulated. The replacement's price remains unknown.
6. In presenter controls, inject the cancellation acknowledgement and quote. The $600 deposit remains; the new quote is $6,480. The full forecast becomes $17,280.
7. Approve the booking request; inject booking confirmation. Review the resulting staff, invitation, and planning-file updates. No quote is treated as a booking.
8. Optionally change the venue to the supplied Marriott proposal to show included AV and a redundant rental, or inject an older quote to show that it cannot overwrite current facts.

All prices, addresses, contacts, availability, staffing ratios, and vendor replies are fictional fixtures. `.example` addresses never leave the application.

## What is real and what is simulated

| Component | State |
|---|---|
| Planning UI, editing, project creation, persistence | Implemented locally |
| Astra interpretation and read-only evidence tools | Real OpenAI API when configured |
| Budget arithmetic, dependencies, approvals, denials, Undo | Implemented in application code |
| Background jobs and quote/confirmation resumption | Persisted in SQLite; processed by the API process |
| Dropbox folder and document updates | Organized sample documents, simulated sync; no Dropbox OAuth connection |
| Email and vendor replies | Persisted simulated inbox/outbox; no Gmail/Outlook delivery |
| Invitations | Simulated previews and receipts; no Evite API |
| Hosting, team authentication, account billing controls | Not implemented in this local demo |

Undo restores eligible local values and document projections without overwriting unrelated later edits. Prior sent-message simulations remain in history, with corrective proposals where needed. Undo does not unsend a real email or reinstate a real vendor contract.

## Verification

```sh
npm test
npm run build
```

The regression suite covers inline value validation, queued edit serialization, integer-cent budgeting, capacity/staffing consequences, all planning areas, proposal dependencies, denied/stale work, quote/cancellation/booking sequencing, restart/idempotency, and Undo. Planner tests use injected fake SDK runs; they are separate from the opt-in real API smoke check. Browser QA exercises inline autosave, focus during polling, approvals, and Undo. UI regressions cover serialized saves without dropped edits and numeric/date validation.

## Main implementation

- `shared/types.ts`: the UI/API state contract.
- `server/domain.ts`: event rules, proposals, waits, decisions, and Undo.
- `server/store.ts`: durable SQLite storage and job handling.
- `server/planner.ts`: Agents SDK, tool boundaries, validation, and usage guard.
- `server/index.ts`: local HTTP API and background job loop.
- `server/fixtures.ts`: fictional organized event documents.
- `web/src/main.tsx` and `styles.css`: the planning workspace.

The supplied corporate HTML reference has not been modified or published.
