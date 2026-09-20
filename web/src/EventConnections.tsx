import { useEffect, useState } from 'react';
import { CalendarDays, Check, ExternalLink, Folder, LoaderCircle, Mail, PartyPopper, Ticket } from 'lucide-react';
import DropboxConnection from './DropboxConnection';
import './event-connections.css';

type Provider = 'email' | 'google_calendar' | 'dropbox' | 'partiful' | 'evite';
export type EventIntegrationConfig = {
  mailMode?: 'rehearsal' | 'live';
  emailAccount?: string;
  calendarEventUrl?: string;
  dropboxFolderUrl?: string;
  partifulEventUrl?: string;
  eviteEventUrl?: string;
  providers?: Partial<Record<Provider, { status: 'configured' | 'not_configured' }>>;
};
const providers = [
  { id: 'email', name: 'Email', role: 'Vendor conversations', Icon: Mail },
  { id: 'google_calendar', name: 'Google Calendar', role: 'Event schedule', Icon: CalendarDays },
  { id: 'dropbox', name: 'Dropbox', role: 'Planning documents', Icon: Folder },
  { id: 'partiful', name: 'Partiful', role: 'Event page', Icon: PartyPopper },
  { id: 'evite', name: 'Evite', role: 'Guest invitations', Icon: Ticket },
] as const;
const hosts: Record<Exclude<Provider, 'email'>, string[]> = {
  google_calendar: ['calendar.google.com'],
  dropbox: ['dropbox.com', 'www.dropbox.com'],
  partiful: ['partiful.com', 'www.partiful.com'],
  evite: ['evite.com', 'www.evite.com', 'evite.me', 'www.evite.me'],
};
function savedUrl(provider: Provider, config: EventIntegrationConfig): string | undefined {
  if (provider === 'email') return;
  const raw = { google_calendar: config.calendarEventUrl, dropbox: config.dropboxFolderUrl, partiful: config.partifulEventUrl, evite: config.eviteEventUrl }[provider];
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts[provider].includes(url.hostname)) return url.href;
  } catch { /* A malformed saved target cannot become an external link. */ }
}
export function connectionRows(config: EventIntegrationConfig) {
  return providers.map(provider => {
    const url = savedUrl(provider.id, config);
    const linked = config.providers?.[provider.id]?.status === 'configured' && (provider.id === 'email' ? Boolean(config.emailAccount) : Boolean(url));
    return { ...provider, url: linked ? url : undefined, status: linked ? 'Linked' : provider.id === 'email' && config.mailMode === 'rehearsal' ? 'Ready locally' : 'Not linked' };
  });
}
export default function EventConnections({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<EventIntegrationConfig | null>(null);
  const [loadedProject, setLoadedProject] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load your saved connections.');
        return response.json() as Promise<EventIntegrationConfig>;
      })
      .then(value => { if (!controller.signal.aborted) { setConfig(value); setLoadedProject(projectId); } })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load your saved connections.'); });
    return () => controller.abort();
  }, [projectId, attempt]);
  const current = loadedProject === projectId ? config : null;
  return (
    <section className="ec-panel" aria-labelledby="ec-title">
      <header className="ec-heading"><h2 id="ec-title">Connections</h2></header>
      <DropboxConnection key={projectId} projectId={projectId} onSaved={() => setAttempt(value => value + 1)} />
      {error && <div className="ec-error" role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
      <div className="ec-providers" aria-busy={!current && !error}>
        {connectionRows(current || {}).filter(provider => provider.id !== 'dropbox').map(({ id, name, role, Icon, status, url }) => (
          <div className="ec-provider" key={id}>
            <span className="ec-icon"><Icon size={17} strokeWidth={1.65} aria-hidden="true" /></span>
            <div className="ec-provider-copy"><h3>{name}</h3><p>{role}</p></div>
            <div className="ec-actions">
              {!current ? <span className="ec-loading">{!error && <LoaderCircle size={15} className="ec-spinner" aria-label="Loading connection" />}</span>
                : <span className={`ec-status${status === 'Linked' ? ' ec-status-linked' : ''}`} title={status === 'Linked' ? 'A saved account or event destination; updates use the local browser bridge.' : status === 'Ready locally' ? 'Email works inside Ripple; no external delivery is implied.' : 'No account or event destination is configured.'}>{status === 'Linked' && <Check size={12} aria-hidden="true" />}{status}</span>}
              {url && <a className="ec-open" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name}`}><ExternalLink size={13} /></a>}
            </div>
          </div>
        ))}
      </div>
      <p className="ec-footnote">{current?.mailMode === 'rehearsal' ? 'Email stays in Ripple. Linked event pages use the local browser bridge.' : 'Linked destinations update through the local browser bridge.'}</p>
    </section>
  );
}
