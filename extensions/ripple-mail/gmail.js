(() => {
  let busy = false;
  const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const composeSurfaces = () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(node => {
      const label = node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      return label.trim().startsWith('Compose:');
    });
    return [...dialogs, ...document.querySelectorAll('[role="region"][aria-label="New Message"]')];
  };
  const existingDrafts = () => [...document.querySelectorAll('input[name="subjectbox"], [contenteditable="true"][aria-label="Message Body"]'), ...composeSurfaces()];
  const normalized = value => String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const account = () => {
    const label = all('[aria-label^="Google Account:"]').map(element => element.getAttribute('aria-label')).join(' ');
    return label.match(/\(([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})\)/i)?.[1].toLowerCase() || '';
  };
  const ready = () => {
    const current = account();
    if (!current) return { ready: false, reason: 'Sign in to the paired Gmail account. English Gmail is required.' };
    if (busy || existingDrafts().length) return { ready: false, account: current, reason: 'Close existing drafts in the paired Gmail tab. Ripple will not overwrite them.' };
    if (notifications().length) return { ready: false, account: current, reason: 'Waiting for the previous Gmail send confirmation to disappear.' };
    return { ready: true, account: current };
  };
  const message = async value => {
    let timer;
    try {
      const response = await Promise.race([chrome.runtime.sendMessage(value), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Ripple did not confirm approval in time. No send was attempted.')), 10000);
      })]);
      if (response?.error) throw new Error(response.error); return response;
    } finally { clearTimeout(timer); }
  };
  async function waitFor(check, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Gmail did not reach the expected visible state.');
  }
  function fillInput(input, value) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const notifications = () => all('[role="alert"], [role="status"]').filter(element => /\bMessage sent\b/.test(element.textContent || ''));
  async function send(job) {
    let clicked = false;
    const deadline = Date.now() + 45000;
    try {
      const state = ready(); const payload = job?.payload;
      if (!state.ready || !payload || job.provider !== 'email' || job.action !== 'send_email' || job.status !== 'running' || job.workerId !== 'ripple-mail-extension') throw new Error(state.reason || 'Invalid approved email.');
      if (payload.account?.toLowerCase() !== state.account || ![state.account, 'rexziyw@gmail.com'].includes(payload.recipient?.toLowerCase())) throw new Error('This recipient is not enabled for the demo.');
      if (typeof payload.subject !== 'string' || /[\r\n]/.test(payload.subject) || typeof payload.body !== 'string') throw new Error('Invalid approved content.');
      // A previous send toast must disappear before starting, so it cannot verify this send.
      if (notifications().length) throw new Error('Wait for the previous Gmail send confirmation to disappear.');
      busy = true;
      const compose = all('[role="button"]').filter(element => element.textContent.trim() === 'Compose');
      if (compose.length !== 1) throw new Error('Gmail Compose control could not be identified safely.');
      const previousSurfaces = new Set(composeSurfaces());
      compose[0].click();
      let composer; let expanded = false;
      const subject = await waitFor(() => {
        const added = composeSurfaces().filter(node => !previousSurfaces.has(node));
        // The expanded region may be nested inside the new Compose dialog.
        const surfaces = added.filter(node => !added.some(parent => parent !== node && parent.contains(node)));
        if (surfaces.length > 1) throw new Error('More than one new Gmail composer appeared. Nothing was changed.');
        if (!composer && surfaces.length === 1) composer = surfaces[0];
        if (!composer) return false;
        if (!composer.isConnected) throw new Error('The new Gmail composer was closed.');
        if (surfaces.some(node => node !== composer && !composer.contains(node))) throw new Error('The new Gmail composer changed unexpectedly.');
        const subjects = all('input[name="subjectbox"]', composer);
        if (subjects.length > 1) throw new Error('The new Gmail composer is ambiguous.');
        if (subjects.length === 1) return subjects[0];
        const maximize = all('button[aria-label="Maximize"][aria-expanded="false"], [role="button"][aria-label="Maximize"][aria-expanded="false"]', composer);
        if (maximize.length > 1) throw new Error('The new Gmail composer expansion control is ambiguous.');
        if (!expanded && maximize.length === 1) { expanded = true; maximize[0].click(); }
        return false;
      });
      const region = subject.closest('[role="region"]');
      if (!region || (region !== composer && !composer.contains(region))) throw new Error('Gmail compose region was not found.');
      const to = all('input[aria-label="To recipients"]', region)[0];
      const body = all('[contenteditable="true"][aria-label="Message Body"]', region)[0];
      if (!to || !body) throw new Error('Gmail recipient or body editor is unavailable.');
      fillInput(to, payload.recipient);
      for (const type of ['keydown', 'keypress', 'keyup']) to.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      subject.focus();
      await waitFor(() => all('[role="option"][data-hovercard-id]', region).length > 0);
      fillInput(subject, payload.subject);
      body.focus(); body.textContent = payload.body;
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.body }));
      body.dispatchEvent(new Event('change', { bubbles: true })); body.blur();
      const checkContent = () => {
        const recipients = all('[role="option"][data-hovercard-id]', region).map(element => element.getAttribute('data-hovercard-id')?.toLowerCase());
        return account() === state.account && all('input[name="subjectbox"]').length === 1 && recipients.length === 1 && recipients[0] === payload.recipient.toLowerCase() && !to.value.trim() && subject.value === payload.subject && normalized(body.innerText) === normalized(payload.body);
      };
      if (!checkContent()) throw new Error('The Gmail draft does not exactly match the approved email.');
      const sendButton = all('[role="button"][aria-label^="Send "]', region).filter(element => /^Send\s/.test(element.getAttribute('aria-label')));
      if (sendButton.length !== 1) throw new Error('Gmail Send control is ambiguous.');
      const approved = await message({ type: 'ripple:before-send', jobId: job.id });
      if (Date.now() >= deadline) throw new Error('Gmail preparation timed out. No send was attempted.');
      if (!approved?.allowed || !checkContent()) throw new Error('Approval or draft changed before sending.');
      clicked = true; sendButton[0].click();
      await waitFor(() => notifications().length > 0 && (!subject.isConnected || !visible(subject)), 15000);
      return { sent: true, clicked: true, verification: { method: 'gmail_sent_confirmation', subject: payload.subject, recipient: payload.recipient }, url: `https://mail.google.com${location.pathname}#sent`, detail: 'Verified the sole recipient, subject, and message body against the approved payload, then observed a new visible Gmail “Message sent” confirmation and the compose window close.' };
    } catch (error) {
      return { sent: false, clicked, error: error instanceof Error ? error.message : 'Gmail automation stopped.' };
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((value, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (value?.type === 'ripple:ready') { reply(ready()); return false; }
    if (value?.type === 'ripple:send') { send(value.job).then(reply); return true; }
    if (value?.type === 'ripple:scan-replies') {
      const state = ready();
      if (!state.ready || state.account !== value.target?.account?.toLowerCase()) { reply({ error: state.reason || 'The paired Gmail account changed.' }); return false; }
      busy = true;
      rippleGmailReplyReader.read(value.target).then(reply, error => reply({ error: error.message || 'Unable to inspect the tracked thread.' })).finally(() => { busy = false; });
      return true;
    }
    return false;
  });
  const heartbeat = () => chrome.runtime.sendMessage({ type: 'ripple:heartbeat' }).catch(() => {});
  setInterval(heartbeat, 3000); heartbeat();
})();
