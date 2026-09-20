# Ripple Mail (local demo)

This unpacked extension makes **Approve → Gmail send → verified receipt → matching reply capture** run while Ripple and the selected Gmail tab stay open. It sends only already-approved email jobs to the signed-in account or the explicitly configured demo address rexziyw@gmail.com and reads replies only in tracked delivered-email conversations. It does not generate messages, extract Google credentials, or use Gmail private APIs. No cloud service or additional package is required.

## Install and pair once

1. Start Ripple with `npm run dev` from the repository root.
2. In Brave, open `brave://extensions` (Chrome: `chrome://extensions`), enable Developer mode, and choose **Load unpacked** → this `extensions/ripple-mail` directory. Installing grants the new extension access to Gmail; get the user's installation approval before doing this on their computer.
3. Open a dedicated Gmail tab, sign in to the account configured in Ripple, and **reload that tab** after installation. Keep other drafts out of this worker tab, including minimized drafts. English Gmail is currently required. Ripple expands its own newly opened composer if Gmail starts it minimized.
4. Open **Ripple Mail** from the browser's extension menu. Use **Open local pairing page**, copy the `token` value from that local page, paste it into the extension, and select the dedicated Gmail tab. Do not paste this token into chat or commit it.
5. Choose **Pair & enable**. This immediately allows existing and future approved emails to the configured demo recipient to run. Use **Pause** to stop claiming work. A message already clicked in Gmail may finish.

The server stores a random pairing capability in ignored `data/mail-extension-token` with mode `0600`; the extension stores it in trusted extension-local storage, inaccessible to its Gmail content script. The extension's HTTP requests are fixed to `http://127.0.0.1:8787/api/mail-worker`. Chrome host permissions cannot restrict ports, so the manifest requests loopback-host access but the code fixes port 8787. Gmail uses its existing normal browser session.

## Rehearsal and proof

Configure a separate rehearsal event's `emailAccount` and `testRecipient` to the same signed-in Gmail address. Review and approve one concrete email in Ripple. Within a few seconds in an active tab (or a later browser alarm), the worker opens its own compose, fills the pinned approved content, rechecks the current approval, and clicks Send. The job becomes completed only after a fresh visible **Message sent** confirmation and the compose window closing. Verify the first test in Gmail Sent as well. Gmail confirmation proves Gmail accepted the send, not delivery to an outside recipient.

The extension also handles approved Evite title, venue and description updates on the linked invitation’s **Review** page. Keep that page open. After saving, it revisits the editor and verifies the persisted fields before completing the job. This venue-demo adapter does not alter the Evite date/time or send guest notifications. Reload the extension after updating its files, accept its Evite host permission, and reload Gmail and Evite. A save with an uncertain outcome pauses instead of being replayed.

The worker never claims Calendar, Dropbox or Partiful jobs. Those integrations keep their existing execution boundaries.

Every 15 seconds while idle, the monitor checks one delivered Ripple conversation using Gmail's visible search and message controls. It requires an exact subject and a visible copy of the original approved email before accepting a later, distinct message from the expected recipient. Outbound echoes and already captured IDs are excluded. The raw visible body, message ID, sender, thread link, displayed timestamp and browser timezone are preserved. The subject is explicitly sourced from Gmail's thread heading; Gmail timestamps have minute precision. Captured replies enter the existing parser and event review flow; only a valid matching quote changes the forecast. A self-inbox rehearsal reply is identified by its later position and distinct message ID, not represented as a verified external vendor identity.

The server router must receive `ingestReply: service.ingestReply` to activate capture. Ambiguous matching threads, missing outbound anchors, unexpected senders and unavailable metadata stop that scan without importing unrelated mail. The monitor persists captured IDs and the server also deduplicates. Reading a tracked conversation may mark that conversation read in Gmail.

If Gmail changes its controls, a draft is already open, the account differs, or approval changes, the worker stops. A failure after Send or an interrupted claim is **not retried automatically**. Check Gmail Sent and the specific Ripple job before an operator reconciles it. A saved confirmation whose backend receipt failed may retry the receipt only. Do not clear extension storage or reapprove the same message to resolve an uncertain send.

Implementation is locally tested; installation and a real extension-driven send must be verified separately. This is a small browser-dependent demo adapter, not a Gmail API integration. The durable alternative requires a Google Cloud OAuth client and a Gmail API grant.

Primary references: [Chrome extension network permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms), [Gmail server OAuth setup](https://developers.google.com/workspace/gmail/api/auth/web-server).
