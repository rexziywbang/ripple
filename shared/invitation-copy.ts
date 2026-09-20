import type { Facts, Proposal } from './types.js';

export type GuestInvitation = NonNullable<Proposal['invitationSnapshot']>;

/** A requirement is not a promise to guests. Availability must be explicitly recorded. */
export function guestDietaryCopy(value: string): string {
  const statements = value.split(/[;\n]+|(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
  return statements.filter(part => /\b(?:available|provided|confirmed|included|will be served)\b/i.test(part)
    && !/\b(?:not|unconfirmed|unavailable|pending|needed|required|request|may|might|check|ask|cannot)\b/i.test(part))
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).replace(/[.!?]+$/, '') + '.').join(' ');
}

export function dietaryNeedsKey(value: string): string {
  return value.toLowerCase().replace(/\b(?:are|is|needed|required|available|confirmed|provided)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function writeGuestInvitation(snapshot: GuestInvitation): string {
  const day = new Date(`${snapshot.date}T12:00:00Z`);
  const date = Number.isFinite(day.getTime()) ? new Intl.DateTimeFormat('en-US', {weekday:'long',month:'long',day:'numeric',timeZone:'UTC'}).format(day) : snapshot.date;
  const match = /^(\d{2}):(\d{2})$/.exec(snapshot.time);
  const time = match ? `${Number(match[1]) % 12 || 12}${match[2] === '00' ? '' : ':' + match[2]} ${Number(match[1]) >= 12 ? 'PM' : 'AM'}` : snapshot.time;
  const location = [snapshot.venue, snapshot.venueAddress.replace(/\s*\(demo\)$/, '')].filter(Boolean).join(', ');
  return [
    `You’re invited to ${snapshot.name}.`,
    `Join us on ${date} at ${time}${location ? ` at ${location}` : ''}.`,
    [snapshot.caterer ? `Dinner will be provided by ${snapshot.caterer}.` : '', guestDietaryCopy(snapshot.dietary)].filter(Boolean).join(' '),
    'We look forward to seeing you there.',
  ].filter(Boolean).join('\n\n');
}
