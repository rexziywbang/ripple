(() => {
  const visible = node => node instanceof HTMLElement && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const nodes = selector => [...document.querySelectorAll(selector)].filter(visible);
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const button = label => nodes('button').find(node => text(node.getAttribute('aria-label') || node.textContent) === label);
  const editor = () => nodes('[contenteditable="true"][data-qa-id="event-notes"]')[0];
  async function wait(check, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); }
    throw new Error('Evite did not show the expected editor.');
  }
  function input(node, value) {
    node.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const locationButton = () => nodes('button').find(node => /Location$/.test(text(node.textContent)) && !/^Remove/.test(text(node.textContent)));
  const saveButton = () => button('Finish') || button('Next');
  function fields() { return { title: nodes('input#title')[0]?.value || '', location: locationButton()?.textContent || '', description: editor()?.innerText || '' }; }
  function verify(job) {
    const current = fields(); const snapshot = job.payload.snapshot;
    return { verified: text(current.title) === text(snapshot.name) && text(current.location).includes(text(snapshot.venue)) && text(current.description) === text(job.payload.description), fields: current };
  }
  async function save(job) {
    try {
      if (job.provider !== 'evite' || job.action !== 'update_event' || job.workerId !== 'ripple-evite-extension' || job.payload.notifyGuests !== false) throw new Error('Invalid invitation update.');
      const snapshot = job.payload.snapshot;
      const title = nodes('input#title')[0]; const note = editor(); const locationControl = locationButton();
      if (!title || !note || !locationControl || !saveButton()) throw new Error('Open this invitation’s Review screen in Evite.');
      // This adapter changes metadata only. Date/time remain at their imported values.
      locationControl.click();
      await wait(() => button('Done'));
      let search = nodes('input#event-location-input')[0];
      if (!search) {
        const current = nodes('button[data-qa-id="event-address"]')[0];
        if (current) current.click();
        search = await wait(() => nodes('input#event-location-input')[0]);
      }
      input(search, snapshot.venue);
      const option = await wait(() => nodes('[role="option"][data-qa-id="address-option"]').find(node =>
        text(node.querySelector('[data-qa-id="bold-address"]')?.textContent).toLowerCase() === snapshot.venue.toLowerCase() &&
        /Cambridge, MA/.test(text(node.querySelector('[data-qa-id="gray-address"]')?.textContent))));
      option.click();
      button('Done').click();
      await wait(() => locationButton() && !nodes('input#event-location-input').length);
      input(nodes('input#title')[0], snapshot.name);
      const currentNote = editor(); currentNote.focus();
      const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(currentNote); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('insertText', false, job.payload.description);
      currentNote.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: job.payload.description })); currentNote.blur();
      if (!verify(job).verified) throw new Error('Evite editor contents differ from the approved invitation.');
      const approved = await chrome.runtime.sendMessage({ type: 'ripple:evite-before-save', jobId: job.id });
      if (!approved?.allowed || !verify(job).verified) throw new Error(approved?.error || 'The invitation approval changed before saving.');
      saveButton().click();
      return { saveStarted: true };
    } catch (error) { return { saved: false, error: error.message || 'Evite update paused.' }; }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'ripple:evite-save') { save(message.job).then(reply); return true; }
    if (message?.type === 'ripple:evite-verify') { reply(verify(message.job)); return false; }
  });
  const heartbeat = () => chrome.runtime.sendMessage({ type: 'ripple:evite-heartbeat', eventUrl: location.href }).catch(() => {});
  setInterval(heartbeat, 2500); heartbeat();
})();
