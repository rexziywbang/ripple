import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, ExternalLink, LoaderCircle, Mail, RefreshCw } from 'lucide-react';
import './gmail-connection.css';

type GmailConnectionProps = { projectId: string; onSaved: () => void };
type GmailConfig = { emailAccount?: string; testRecipient?: string };
type ConnectionValues = { emailAccount: string; testRecipient: string };
const emptyValues: ConnectionValues = { emailAccount: '', testRecipient: '' };
const normalize = (config: GmailConfig): ConnectionValues => ({
  emailAccount: typeof config.emailAccount === 'string' ? config.emailAccount : '',
  testRecipient: typeof config.testRecipient === 'string' ? config.testRecipient : '',
});
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export default function GmailConnection({ projectId, onSaved }: GmailConnectionProps) {
  const accountId = useId();
  const recipientId = useId();
  const [configProjectId, setConfigProjectId] = useState(projectId);
  const [values, setValues] = useState<ConnectionValues>(emptyValues);
  const [saved, setSaved] = useState<ConnectionValues>(emptyValues);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<'save' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    busy.current = false;
    mutation.current?.abort();
    setConfigProjectId(projectId);
    setValues(emptyValues);
    setSaved(emptyValues);
    setLoading(true);
    setLoaded(false);
    setSaving(null);
    setError('');
    setNotice('');
    async function load() {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Couldn’t load the Gmail configuration.');
        if (controller.signal.aborted || generation.current !== current) return;
        const config = normalize(result);
        setValues(config);
        setSaved(config);
        setLoaded(true);
      } catch (cause) {
        if (controller.signal.aborted || generation.current !== current) return;
        setError(cause instanceof Error ? cause.message : 'Couldn’t load the Gmail configuration.');
      } finally {
        if (!controller.signal.aborted && generation.current === current) setLoading(false);
      }
    }
    void load();
    return () => { controller.abort(); mutation.current?.abort(); generation.current++; };
  }, [projectId, reload]);

  async function save(disconnect = false) {
    if (busy.current || !loaded || loading || configProjectId !== projectId) return;
    const next = disconnect ? emptyValues : { emailAccount: values.emailAccount.trim(), testRecipient: values.testRecipient.trim() };
    if (!disconnect && (!validEmail(next.emailAccount) || !validEmail(next.testRecipient))) {
      setError('Enter a valid Gmail account and delivery email address.');
      return;
    }
    const current = generation.current;
    const controller = new AbortController();
    mutation.current = controller;
    busy.current = true;
    setSaving(disconnect ? 'disconnect' : 'save');
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Couldn’t save the Gmail configuration.');
      if (controller.signal.aborted || generation.current !== current) return;
      const config = normalize(result);
      setValues(config);
      setSaved(config);
      setNotice(disconnect ? 'Gmail configuration removed.' : 'Gmail configuration saved.');
      onSaved();
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== current) return;
      setError(cause instanceof Error ? cause.message : 'Couldn’t save the Gmail configuration.');
    } finally {
      if (!controller.signal.aborted && generation.current === current) {
        busy.current = false;
        mutation.current = null;
        setSaving(null);
      }
    }
  }

  const currentProject = configProjectId === projectId;
  const configured = currentProject && !!saved.emailAccount && !!saved.testRecipient;
  const changed = values.emailAccount.trim() !== saved.emailAccount || values.testRecipient.trim() !== saved.testRecipient;
  const disabled = loading || !loaded || !!saving || !currentProject;
  return <section className="gmail-connection" aria-labelledby={`${accountId}-heading`}>
    <header className="gc-heading"><span className="gc-icon"><Mail size={20} strokeWidth={1.7} /></span><div><h2 id={`${accountId}-heading`}>Gmail</h2><p>Uses the signed-in Gmail browser on this computer. Delivery is recorded after Gmail confirms it.</p></div>{configured && <span className="gc-configured"><Check size={11} />Configured</span>}</header>
    {loading || !currentProject ? <div className="gc-loading" role="status"><LoaderCircle size={15} className="gc-spin" />Loading configuration…</div> : <form className="gc-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="gc-fields"><label htmlFor={accountId}><span>Gmail account</span><input id={accountId} type="email" autoComplete="off" placeholder="you@company.com" value={values.emailAccount} disabled={disabled} required onChange={event => { setValues(current => ({ ...current, emailAccount: event.target.value })); setNotice(''); }} /></label><label htmlFor={recipientId}><span>Delivery recipient</span><input id={recipientId} type="email" autoComplete="off" placeholder="recipient@company.com" value={values.testRecipient} disabled={disabled} required aria-describedby={`${recipientId}-help`} onChange={event => { setValues(current => ({ ...current, testRecipient: event.target.value })); setNotice(''); }} /><small id={`${recipientId}-help`}>Approved vendor messages go to this address.</small></label></div>
      {error && <div className="gc-error" role="alert"><CircleAlert size={14} /><span>{error}</span>{!loaded && <button type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={12} />Retry</button>}</div>}
      <footer className="gc-footer"><div className="gc-buttons"><button type="submit" className="gc-save" disabled={disabled || !values.emailAccount.trim() || !values.testRecipient.trim() || (configured && !changed)}>{saving === 'save' && <LoaderCircle size={13} className="gc-spin" />}{saving === 'save' ? 'Saving…' : configured ? 'Save connection' : 'Configure'}</button>{configured && <button type="button" className="gc-disconnect" disabled={disabled} onClick={() => void save(true)}>{saving === 'disconnect' ? 'Removing…' : 'Disconnect'}</button>}</div><a className="gc-open" href="https://mail.google.com/" target="_blank" rel="noreferrer">Open Gmail<ExternalLink size={12} /></a></footer>
      {notice && <p className="gc-notice" role="status"><Check size={12} />{notice}</p>}
    </form>}
  </section>;
}
