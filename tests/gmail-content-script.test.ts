import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../extensions/ripple-mail/gmail.js', import.meta.url), 'utf8');
const account = 'ripple-test@gmail.com';
const job = { id: 'approved-one', provider: 'email', action: 'send_email', status: 'running', workerId: 'ripple-mail-extension', payload: { account, recipient: account, subject: 'Approved dinner request', body: 'Please confirm the dinner arrangements.' } };

/** Small DOM fixture executes the shipped content script; no browser or network is involved. */
class ElementFixture {
  children: ElementFixture[] = []; parent: ElementFixture | null = null; hidden = false; clicks = 0;
  content = ''; onClick?: () => void; onEvent?: (event: any) => void;
  constructor(public tag = 'div', public attributes: Record<string, string> = {}) {}
  get isConnected(): boolean { return this.tag === 'document' || !!this.parent?.isConnected; }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; }
  get innerText() { return this.textContent; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  append(child: ElementFixture) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  contains(child: ElementFixture): boolean { return child === this || this.children.some(value => value.contains(child)); }
  matches(selector: string) {
    const tag = /^[a-z]+/i.exec(selector)?.[0]; if (tag && tag !== this.tag) return false;
    return [...selector.matchAll(/\[([^\]^=]+)(\^=|=)"([^"]*)"\]/g)].every(([, name, operator, value]) => operator === '^=' ? this.getAttribute(name)?.startsWith(value) : this.getAttribute(name) === value);
  }
  querySelectorAll(selector: string): ElementFixture[] {
    const selectors = selector.split(',').map(value => value.trim());
    return this.children.flatMap(child => [...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  getElementById(id: string) { return this.querySelectorAll(`[id="${id}"]`)[0] ?? null; }
  closest(selector: string): ElementFixture | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  getClientRects(): unknown[] { return !this.isConnected || this.hidden || (this.parent && !this.parent.getClientRects().length) ? [] : [{}]; }
  click() { this.clicks++; this.onClick?.(); }
  focus() {} blur() {}
  dispatchEvent(event: unknown) { this.onEvent?.(event); return true; }
}
class InputFixture extends ElementFixture {
  private inputValue = '';
  constructor(attributes: Record<string, string>) { super('input', attributes); }
  get value() { return this.inputValue; }
  set value(value: string) { this.inputValue = value; }
}
class EventFixture {
  constructor(public type: string, values: Record<string, unknown> = {}) { Object.assign(this, values); }
}

function setup(options: { minimized?: boolean; existing?: 'dialog' | 'hidden-editors'; maximizeLabel?: string; duplicateMaximize?: boolean; duplicateComposer?: boolean; neverExpand?: boolean; beforeSend?: () => Promise<unknown> } = {}) {
  vi.useFakeTimers();
  const document = new ElementFixture('document');
  document.append(new ElementFixture('button', { 'aria-label': `Google Account: Test (${account})` }));
  const compose = document.append(new ElementFixture('div', { role: 'button' })); compose.textContent = 'Compose';
  const created: { dialog: ElementFixture; region: ElementFixture; maximize: ElementFixture; subject: InputFixture; to: InputFixture; body: ElementFixture; send: ElementFixture }[] = [];
  const addComposer = () => {
    const headingId = `:compose-${created.length}`;
    const dialog = document.append(new ElementFixture('div', { role: 'dialog', 'aria-labelledby': headingId }));
    const heading = dialog.append(new ElementFixture('div', { role: 'heading', id: headingId })); heading.textContent = 'Compose: New Message';
    const maximize = dialog.append(new ElementFixture('button', { 'aria-label': options.maximizeLabel ?? 'Maximize', 'aria-expanded': options.minimized ? 'false' : 'true' }));
    const region = dialog.append(new ElementFixture('div', { role: 'region', 'aria-label': 'New Message' })); region.hidden = !!options.minimized;
    maximize.onClick = () => { if (!options.neverExpand) region.hidden = false; };
    if (options.duplicateMaximize) dialog.append(new ElementFixture('button', { ...maximize.attributes }));
    const subject = region.append(new InputFixture({ name: 'subjectbox' })) as InputFixture;
    const to = region.append(new InputFixture({ 'aria-label': 'To recipients' })) as InputFixture;
    const body = region.append(new ElementFixture('div', { contenteditable: 'true', 'aria-label': 'Message Body' }));
    to.onEvent = event => {
      if (event.type === 'keydown' && event.key === 'Enter') { region.append(new ElementFixture('div', { role: 'option', 'data-hovercard-id': to.value })); to.value = ''; }
    };
    const send = region.append(new ElementFixture('div', { role: 'button', 'aria-label': 'Send (Ctrl-Enter)' }));
    send.onClick = () => { dialog.remove(); const toast = document.append(new ElementFixture('div', { role: 'alert' })); toast.textContent = 'Message sent'; };
    const result = { dialog, region, maximize, subject, to, body, send }; created.push(result); return result;
  };
  compose.onClick = () => { addComposer(); if (options.duplicateComposer) addComposer(); };
  if (options.existing === 'dialog') {
    const existing = document.append(new ElementFixture('div', { role: 'dialog', 'aria-labelledby': ':existing-heading' }));
    existing.append(new ElementFixture('div', { id: ':existing-heading', role: 'heading' })).textContent = 'Compose: Existing draft';
  }
  if (options.existing === 'hidden-editors') {
    const region = document.append(new ElementFixture()); region.hidden = true;
    region.append(new InputFixture({ name: 'subjectbox' }));
    region.append(new ElementFixture('div', { contenteditable: 'true', 'aria-label': 'Message Body' }));
  }
  let listener: (value: object, sender: object, reply: (result: any) => void) => unknown = () => {};
  const beforeSend = vi.fn(options.beforeSend ?? (async () => ({ allowed: true })));
  runInNewContext(script, { document, HTMLElement: ElementFixture, HTMLInputElement: InputFixture, Event: EventFixture, KeyboardEvent: EventFixture, InputEvent: EventFixture,
    getComputedStyle: () => ({ visibility: 'visible' }), location: { pathname: '/mail/u/0/' }, Date, setTimeout, clearTimeout, setInterval: () => 0,
    chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage: (value: { type: string }) => value.type === 'ripple:before-send' ? beforeSend() : Promise.resolve({ ok: true }) } } });
  const message = (type: string) => new Promise<any>(resolve => listener({ type, job }, { id: 'fixture-extension' }, resolve));
  return { compose, created, beforeSend, message };
}
afterEach(() => vi.useRealTimers());

describe('Gmail compose ownership and expansion', () => {
  it('refuses preexisting minimized dialogs and hidden draft editors without opening or changing compose', async () => {
    for (const existing of ['dialog', 'hidden-editors'] as const) {
      const ctx = setup({ existing });
      expect(await ctx.message('ripple:ready')).toMatchObject({ ready: false, reason: expect.stringContaining('Close existing drafts') });
      expect(await ctx.message('ripple:send')).toMatchObject({ sent: false, clicked: false });
      expect(ctx.compose.clicks).toBe(0); expect(ctx.beforeSend).not.toHaveBeenCalled();
    }
  });

  it('resolves the new dialog’s aria-labelledby title and clicks its native Maximize button once', async () => {
    const ctx = setup({ minimized: true }); const result = ctx.message('ripple:send');
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toMatchObject({ sent: true, verification: { subject: job.payload.subject, recipient: account } });
    expect(ctx.created[0].maximize.clicks).toBe(1); expect(ctx.created[0].send.clicks).toBe(1);
    expect(ctx.created[0].subject.value).toBe(job.payload.subject); expect(ctx.created[0].body.innerText).toBe(job.payload.body);
    expect(ctx.beforeSend).toHaveBeenCalledTimes(1);
  });

  it('leaves an already expanded new composer expanded without touching titlebar controls', async () => {
    const ctx = setup();
    expect(await ctx.message('ripple:send')).toMatchObject({ sent: true });
    expect(ctx.created[0].maximize.clicks).toBe(0);
  });

  it('does not guess a Full screen control when the observed Maximize control is absent', async () => {
    const ctx = setup({ minimized: true, maximizeLabel: 'Full screen' }); const result = ctx.message('ripple:send');
    await vi.advanceTimersByTimeAsync(10100);
    expect(await result).toMatchObject({ sent: false, clicked: false, error: expect.stringContaining('expected visible state') });
    expect(ctx.created[0].maximize.clicks).toBe(0); expect(ctx.created[0].send.clicks).toBe(0); expect(ctx.beforeSend).not.toHaveBeenCalled();
  });

  it('stops when new composers or their expansion controls are ambiguous', async () => {
    for (const option of [{ duplicateComposer: true }, { duplicateMaximize: true }]) {
      const ctx = setup({ minimized: true, ...option });
      expect(await ctx.message('ripple:send')).toMatchObject({ sent: false, clicked: false });
      expect(ctx.created.every(composer => composer.maximize.clicks === 0 && composer.send.clicks === 0 && composer.subject.value === '')).toBe(true);
      expect(ctx.beforeSend).not.toHaveBeenCalled();
    }
  });

  it('times out after one failed expansion and cannot send later when that composer becomes visible', async () => {
    const ctx = setup({ minimized: true, neverExpand: true }); const result = ctx.message('ripple:send');
    await vi.advanceTimersByTimeAsync(10100);
    expect(await result).toMatchObject({ sent: false, clicked: false });
    expect(ctx.created[0].maximize.clicks).toBe(1);
    ctx.created[0].region.hidden = false; await vi.advanceTimersByTimeAsync(20000);
    expect(ctx.created[0].send.clicks).toBe(0); expect(ctx.beforeSend).not.toHaveBeenCalled();
    expect(await ctx.message('ripple:ready')).toMatchObject({ ready: false });
  });

  it('times out an unanswered final approval and never sends if a late response arrives', async () => {
    let allow: (result: object) => void = () => {};
    const approval = new Promise(resolve => { allow = resolve; });
    const ctx = setup({ beforeSend: () => approval }); const result = ctx.message('ripple:send');
    await vi.advanceTimersByTimeAsync(10100);
    expect(await result).toMatchObject({ sent: false, clicked: false, error: expect.stringContaining('confirm approval in time') });
    allow({ allowed: true }); await vi.advanceTimersByTimeAsync(100);
    expect(ctx.created[0].send.clicks).toBe(0);
  });
});
