/** Static operator instructions; credentials and connection state are never embedded. */
export function gmailSetupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Set up Gmail · Ripple</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #302b31; background: #faf9f7; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 48px 20px; font-size: 15px; line-height: 1.55; }
    main { max-width: 650px; margin: 0 auto; padding: 32px; border: 1px solid #e4e0e4; border-radius: 8px; background: #fffefd; }
    .brand { color: #706a72; font-size: 13px; letter-spacing: .04em; }
    h1 { margin: 12px 0 8px; font-size: 27px; line-height: 1.25; font-weight: 500; }
    h2 { margin: 0 0 5px; font-size: 16px; font-weight: 500; }
    p { margin: 0 0 12px; }
    .intro, .note { color: #706a72; }
    ol { margin: 26px 0 22px; padding-left: 23px; }
    li { padding-left: 8px; margin-bottom: 22px; }
    code { padding: 2px 4px; background: #f6f4f3; border-radius: 3px; font-size: 12px; overflow-wrap: anywhere; }
    .callback { display: block; padding: 10px 12px; margin: 10px 0; }
    a { color: #79566f; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid #79566f; outline-offset: 4px; border-radius: 2px; }
    footer { display: flex; flex-wrap: wrap; gap: 12px 22px; padding-top: 20px; border-top: 1px solid #e4e0e4; font-size: 13px; }
    .note { margin: 0 0 22px; font-size: 13px; }
    @media (max-width: 480px) { body { padding: 20px 12px; } main { padding: 24px 20px; } }
  </style>
</head>
<body>
  <main>
    <div class="brand">ripple.</div>
    <h1>Set up Gmail</h1>
    <p class="intro">Add Google's server credentials once, then connect your Gmail account in Ripple. This page does not connect an account or send email.</p>
    <ol>
      <li><h2>Create a Google OAuth client</h2><p>Enable the Gmail API and configure the consent screen in your Google Cloud project. Create an OAuth client of type <em>Web application</em> with this exact authorized redirect URI:</p><code class="callback">http://127.0.0.1:8787/api/gmail/callback</code><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud credentials</a></li>
      <li><h2>Configure the local server</h2><p>Put the client values in the server's ignored <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart the API. Keep the secret out of the browser and source control.</p><a href="/api/gmail/status">Check backend readiness</a></li>
      <li><h2>Connect Gmail in Ripple</h2><p>Return to Event settings and choose <em>Connect Gmail</em>. Sign in and approve the requested send permission. If your OAuth app is in testing, add this account as a test user first.</p></li>
    </ol>
    <p class="note">Permissions: Gmail send, OpenID and email identity. Ripple sends only approved messages. A successful send receipt is not proof of recipient delivery. Reply monitoring and Evite still use the separate browser bridge.</p>
    <footer><a href="http://127.0.0.1:5173/">Return to Ripple</a><a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noreferrer">Google OAuth documentation</a></footer>
  </main>
</body>
</html>`;
}
