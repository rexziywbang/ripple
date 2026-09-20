# Gmail API setup

Ripple sends approved email through the Gmail API while its local server is running; no Gmail tab is required. Email sending through the extension is disabled in the running server (`sendingEnabled: false`). Reply monitoring and Evite updates still use the separate [Ripple Mail browser bridge](../extensions/ripple-mail/README.md).

**Current setup:** OAuth consent is complete and Gmail is connected with no attention state. On **2026-09-20 at 07:57:42.495 UTC**, worker `ripple-gmail-api` completed job `0666e8f7-2aa4-4809-8564-01e41f0375e5` for **rexziyw@gmail.com**, subject **Christmas dinner: New delivery location**. Google returned message ID `1a0bdd22923b9e3e`: the approved message was accepted for sending once. Gmail Sent was independently checked: sender, recipient, subject and full body matched the approved Marriott/50 Broadway/200-guest snapshot. Recipient delivery is not verified. Earlier failed extension attempts were not retried. The setup steps below cover a fresh installation.

## One-time Google setup

1. Select your Google Cloud project, enable the **Gmail API**, and configure its OAuth consent screen. For an external app in testing, add the Gmail account you will connect as a test user.
2. In [Google Cloud credentials](https://console.cloud.google.com/apis/credentials), create an OAuth client with application type **Web application**. Add this exact authorized redirect URI, including the IP address and port:

   ```text
   http://127.0.0.1:8787/api/gmail/callback
   ```

3. Store the client values in the existing, ignored server `.env` without replacing its other settings:

   ```dotenv
   GOOGLE_CLIENT_ID=your-web-client-id
   GOOGLE_CLIENT_SECRET=your-web-client-secret
   ```

4. Restart the API to load those values. Open [backend readiness](http://127.0.0.1:8787/api/gmail/status): `configured: true` means both server values are present; it does **not** mean an account is connected.
5. In Ripple's **Event settings**, choose **Connect Gmail** and finish Google consent in the same browser. After the callback, check that the displayed connected account is the intended sender.

Google requires the redirect URI to match the registered value exactly. The requested scopes are `https://www.googleapis.com/auth/gmail.send`, `openid`, and `email`; the latter two verify the sender's identity. See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Live routing and verification

Connecting Gmail does not itself approve a message. The event integration configuration must have `emailDelivery: "live"` and `emailAccount` matching the connected Google account. The current demo sender permits mail to that account, or to `rexziyw@gmail.com` when the event's configured `testRecipient` is exactly that address. It does not enable arbitrary-recipient sending. All ten existing projects now use the live test route to **rexziyw@gmail.com**; new manually created projects inherit the configured route, as do demo imports. Previously approved immutable payloads are not rerouted by a configuration change.

Inspect the exact recipient, subject and body before approving. The API worker checks the approved proposal and immutable job again before claiming it. The running server does not allow the extension to claim email sends; its Evite and reply-monitoring capabilities remain separate.

For a live check, approve one intended message, inspect the resulting Gmail receipt in Activity, and confirm the message in Gmail Sent. Successful API responses contain a message ID. Count these as **sent/API accepted**, not delivered to the recipient or read; Gmail's [send method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send) does not provide a recipient-delivery receipt. Local automated tests use mocked Google responses and prove behavior, not an actual send.

## Storage and uncertain outcomes

OAuth tokens are stored server-side in `data/gmail-oauth.json` and the send journal in `data/gmail-send-journal.json`, both with file mode **0600** under ignored `data/`. The journal records an attempt before issuing the send request. Do not expose or commit either file, client secrets, or OAuth callback codes.

Each claimed job has at most one send attempt. An interrupted or uncertain attempt is not automatically replayed, even after restart. The worker pauses further sends until the outcome is reconciled. Check Gmail Sent and the specific job before operator recovery; never delete the journal or reapprove the same message to force a retry. A confirmed message ID whose local receipt is pending can have its receipt recorded without sending again.

`GET /api/gmail/status` exposes only readiness/account state: `configured`, `connected`, `busy`, `needsAttention`, and an optional error. `connected` alone does not prove a recent send succeeded. If consent expires or the token cannot refresh, reconnect deliberately and inspect any unresolved send before continuing.

The static [setup page](http://127.0.0.1:8787/api/gmail/setup) contains no credentials or scripts. It is safe to open before OAuth is configured.
