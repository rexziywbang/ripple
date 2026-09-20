const rippleGmailReplyReader = (() => {
  const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const subjectKey = value => value.replace(/^(?:\s*re\s*:\s*)+/i,'').trim().replace(/\s+/g,' ').toLowerCase();
  async function wait(check, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('The tracked Gmail thread is not currently available.');
  }
  function pressEnter(element) {
    for (const type of ['keydown','keypress','keyup']) element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  async function read(target) {
    if (typeof target?.subject !== 'string' || typeof target?.body !== 'string' || typeof target?.account !== 'string') throw new Error('Invalid tracked email.');
    const query = `in:anywhere subject:"${target.subject.replace(/["\\\r\n]/g,' ')}"`;
    const search = all('input[aria-label="Search mail"]')[0];
    if (!search) throw new Error('The Gmail search control is unavailable.');
    search.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search, query);
    search.dispatchEvent(new Event('input',{bubbles:true})); pressEnter(search);
    await wait(() => location.hash.startsWith('#search/') && all('[role="row"] [data-thread-id]').length);
    const matches = all('[role="row"] [data-thread-id]').filter(element => subjectKey(element.textContent || '') === subjectKey(target.subject));
    if (matches.length !== 1) throw new Error('The delivered email does not have one unambiguous matching Gmail thread.');
    const threadId = matches[0].getAttribute('data-thread-id');
    const link = matches[0].closest('[role="link"]');
    if (!link || !threadId) throw new Error('The tracked Gmail conversation link is unavailable.');
    link.click();
    await wait(() => all('h2.hP').some(element => subjectKey(element.textContent || '') === subjectKey(target.subject)) && all('[data-message-id]').length);
    const expand = all('[role="button"]').find(element => [element.getAttribute('aria-label'),element.getAttribute('data-tooltip'),element.textContent?.trim()].includes('Expand all'));
    if (expand) { expand.click(); await wait(() => !visible(expand) || ![expand.getAttribute('aria-label'),expand.getAttribute('data-tooltip'),expand.textContent?.trim()].includes('Expand all')); }
    const subject = all('h2.hP')[0]?.textContent || '';
    if (subjectKey(subject) !== subjectKey(target.subject)) throw new Error('The opened Gmail thread subject changed.');
    const messages = all('[data-message-id]').map((element,messageIndex) => {
      const sender = all('.gD[email]',element)[0]?.getAttribute('email');
      const recipientAddresses = Array.from(new Set(all('.g2[email]',element).map(value => value.getAttribute('email')).filter(Boolean)));
      const receivedAtLabel = all('.g3[title]',element)[0]?.getAttribute('title');
      const timestamp = receivedAtLabel ? Date.parse(receivedAtLabel.replace(/[\u202f\u00a0]/g,' ')) : NaN;
      const body = all('.a3s',element)[0]?.innerText;
      if (!sender || !recipientAddresses.length || !receivedAtLabel || !Number.isFinite(timestamp) || !body || body.length > 16000) return null;
      return { externalId: element.getAttribute('data-message-id'), sender, recipientAddresses, receivedAt: new Date(timestamp).toISOString(), receivedAtLabel, body, messageIndex };
    }).filter(Boolean);
    return { subject, url: location.href, threadId, browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, messages };
  }
  return { read };
})();
