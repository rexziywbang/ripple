# Current demo guide

Open **http://127.0.0.1:5173/?demo=1**. The presentation starts on an empty home without deleting existing events. Use **`~/Downloads/Ripple Christmas dinner`**, the six-file copy of [`fixtures/demo-event-folder`](../fixtures/demo-event-folder).

## The walkthrough

1. Choose **Connect Dropbox**, then **Upload folder**. Select **Ripple Christmas dinner** in Downloads and allow the browser to read its six files. The event opens with component boxes.
2. Briefly show **200 guests**, **Garden Hall**, **December 11 at 6 PM Eastern**, and the **$15,000** forecast against an **$18,000** limit.
3. Open **Venue** and enter exactly **`venue has changed to marriot`**. Choose **Update**, then confirm **Boston Marriott Cambridge — 50 Broadway, Cambridge, MA 02142** with **Yes, this venue**. Do not choose the Courtyard result.
4. Let the consequence path finish. It checks the planning files and selected venue, reconciles equipment, recalculates the budget, and prepares the vendor email and invitation update. These labels describe preparation, not external delivery.
5. Review the compact summary, including the equipment adjustment and vendor message, then choose **Accept all**. Individual items remain available for inspection or editing. Acceptance applies only the displayed proposals and card versions; it does not approve future changes.
6. Show the updated event details and **$14,000** forecast. One approved vendor message is routed to **rexziyw@gmail.com**. The approved guest details queue an update to the linked Evite. Verify both external results before describing either as completed.

The known-folder shortcut after **Connect Dropbox** is an alternative to uploading: in `?demo=1` it imports the same prepared packet from the server. Neither path downloads files through the Dropbox API. Upload reads the files actually selected; the shortcut reads the local staged folder associated with the saved connection.

## Expected numbers

| Planning cost | Garden Hall | Marriott before review | After approved equipment adjustment |
|---|---:|---:|---:|
| Venue | $7,200 | $8,000 | $8,000 |
| Catering: 200 × $24 | $4,800 | $4,800 | $4,800 |
| Staff: 4 × $300 | $1,200 | $1,200 | $1,200 |
| Equipment allowance | $1,800 | $1,800 | $0 |
| **Forecast** | **$15,000** | **$15,800** | **$14,000** |

The published Grand Ballroom banquet capacity is **600**, so the selected room accommodates this scenario's 200 guests. The **$8,000 price, included AV, and penalty-free equipment adjustment are fictional planning assumptions supplied by the packet**, not a Marriott quote, availability confirmation, or booking. Removing the duplicate allowance changes the local plan; it does not cancel a real rental contract.

## Setup before presenting

From the `ripple` directory, run `npm run dev` if the app is not already running. Vite serves the interface on **5173** and the API on **8787**. Do not start a second instance or restart during the walkthrough. Backend changes require a deliberate restart; frontend edits can interrupt a presentation through hot reload.

- Keep the prepared six-file folder available in Downloads. It matches the repository packet: `00 Event.json`, event brief, Garden Hall agreement, Marriott proposal, catering/staffing document, and equipment allowance.
- Keep the saved Dropbox folder, Gmail account, and Evite destination configured. A new demo import copies the existing service destinations into a **new project**, enables that project's live email route, and uses **rexziyw@gmail.com**. Existing projects and their delivery settings are preserved.
- Load or reload **Ripple Mail**, pair it, and **resume/enable** it before expecting delivery. Keep the intended signed-in Gmail tab and linked Evite **Review** page open. Reload provider tabs after extension changes. See the [extension setup](../extensions/ripple-mail/README.md); never paste its pairing token into chat or source control.
- The deterministic imported scenario makes no paid planning request. Other events retain their configured AI behavior. The demo should not be presented as a live model run.

## What counts as verified

| Capability | Evidence needed |
|---|---|
| Folder import | The new event shows the six selected documents and their parsed planning facts. This proves a local import, not a Dropbox download. |
| Consequence review | The selected Marriott identity, equipment decision, exact email draft, invitation snapshot, and forecast are visible before acceptance. |
| Gmail | The exact approved recipient, subject, and body appear in Gmail Sent, and Ripple records a verified receipt. An approved or queued item alone is not delivery. |
| Evite | Reopen the linked invitation and verify the saved venue and description against the approved snapshot, with a matching completed receipt. This adapter updates metadata only; it does not send guest invitations or change the event's date/time. |
| Dropbox output | Open the configured remote folder and verify the intended file/version. Local exports, staged files, and queued bridge jobs do not prove upload. |

The browser rehearsal verified folder import, the exact `marriot` sentence, selection of Boston Marriott Cambridge, the animated dependency path, the four-item summary, **Accept all**, updated planning files, and the final **$14,000** forecast. The full test suite passed: **682 tests in 60 files**, followed by a successful production build.

This walkthrough's approved Gmail and Evite jobs remain **queued**, so neither external result is verified yet. Gmail Sent had no matching message, and Evite still showed Garden Hall. Reloading and resuming the paired extension is the remaining live-delivery prerequisite. A configured URL is not evidence that synchronization has finished.

## If something pauses

- **Venue search:** the exact sentence above is normalized to `marriot`; the local named lookup returns Boston Marriott Cambridge first. The presentation does not wait for a paid web search.
- **No Dropbox connection:** use the offered local folder upload. Do not imply that a new OAuth connection occurred.
- **A review becomes stale:** return to the latest summary and inspect it again. Do not retry acceptance with old tokens or approve unseen follow-up work.
- **Email/Evite remains queued:** check that the extension is paired and enabled and that its selected tabs are signed in. Leave the work queued until execution is verified.
- **An external save/send is uncertain:** inspect the provider and the exact job before retrying. Do not fabricate completion receipts or reapprove a message to force progress; a send may already have happened.

Use the new imported event for each rehearsal. Do not reset or delete the user's existing events.
