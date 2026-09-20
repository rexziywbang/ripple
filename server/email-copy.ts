import type { Facts } from '../shared/types.js';

export type EmailContext = {
  name: string;
  facts: Facts;
  staffCount?: number;
  vendor?: { oldVendor: string; newVendor: string; oldTotalCents: number; depositCents: number; quoteCents?: number };
};
export type EmailDraft = { subject: string; body: string; keys: Array<keyof Facts> };
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const sentence = (value: string) => `${value.trim().replace(/[.!?]+$/, '')}.`;

/** Format the event's wall-clock time, not the server's time zone. */
export function eventWhen(f: Pick<Facts, 'date' | 'time' | 'timezone'>): string {
  const date = new Date(`${f.date}T12:00:00Z`);
  const day = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : f.date;
  const match = /^(\d{2}):(\d{2})$/.exec(f.time);
  const time = match ? `${Number(match[1]) % 12 || 12}${match[2] === '00' ? '' : `:${match[2]}`} ${Number(match[1]) >= 12 ? 'PM' : 'AM'}` : f.time;
  const zone = ({ 'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Los_Angeles': 'Pacific' } as Record<string, string>)[f.timezone] ?? f.timezone;
  return `${day} at ${time} ${zone} time`;
}

/** These drafts are the actual send payload, not a cosmetic rewrite of the preview. */
export function writeEmail(title: string, context: EmailContext): EmailDraft | undefined {
  const { name, facts: f, vendor: v } = context;
  const when = eventWhen(f);
  const location = [f.venue, f.venueAddress].filter(Boolean).join(', ');
  const schedule: Array<keyof Facts> = ['date', 'time', 'timezone'];
  const place: Array<keyof Facts> = ['venue', 'venueAddress'];
  const food: Array<keyof Facts> = ['caterer', 'dietary', 'attendance'];
  const requirement=f.dietary.trim().replace(/^(?:we\s+)?(?:need|require)\s+/i,'').replace(/\s+(?:are\s+)?(?:needed|required)[.!]?$/i,'').replace(/[.!]+$/,'');
  const dietary = requirement ? `Can you accommodate ${requirement}? Please let us know which menu options would work.` : '';
  const quoteDetails = 'Could you send a menu and itemized quote, including the per-person price, delivery, taxes or other fees, and the total? Please confirm availability and include the event date and guest count in your reply. We’ll review the quote before booking.';
  const staff = context.staffCount ?? f.staffCount;
  const staffGreeting = 'Hi team,';
  const vendorGreeting = `Hi ${f.caterer} team,`;
  const draft = (subject: string, greeting: string, paragraphs: string[], keys: Array<keyof Facts>): EmailDraft => ({
    subject: `${name}: ${subject}`,
    body: [greeting, ...paragraphs.filter(Boolean), 'Thanks!'].join('\n\n'),
    keys: [...new Set(keys)],
  });
  const event = `${name} is on ${when} at ${location}.`;

  if (title.startsWith('Request a quote from ')) return draft(title, vendorGreeting, [
    `We’re planning ${name} for ${f.attendance} guests on ${when} at ${location}. Are you available to cater?`, dietary, quoteDetails,
  ], [...schedule, ...place, ...food]);
  if (title.startsWith('Cancel ') && title.endsWith(' catering') && v) return draft('Catering cancellation', `Hi ${v.oldVendor} team,`, [
    `We need to cancel our catering for ${name} on ${when}.`,
    `Our current agreement lists ${money(v.oldTotalCents)} in total, including a ${money(v.depositCents)} non-refundable deposit. Could you confirm the cancellation and that the remaining ${money(v.oldTotalCents - v.depositCents)} will be released?`,
  ], [...schedule, 'caterer']);
  if (title.startsWith('Request booking with ') && v?.quoteCents !== undefined) return draft('Catering booking', vendorGreeting, [
    `We’d like to go ahead with your ${money(v.quoteCents)} quote, including delivery, for ${f.attendance} guests. ${event}`,
    dietary, 'Please confirm the booking and agreed menu in writing.',
  ], [...schedule, ...place, ...food, 'cateringPerPersonCents', 'cateringDeliveryCents']);
  if (title === 'Cancel the duplicate AV rental') return draft('Cancel the duplicate AV rental', 'Hi Bright AV team,', [
    `${f.venue} includes the projector, sound system and microphones for ${name} on ${when}, so we no longer need the separate rental.`,
    `Please cancel it under the no-penalty terms in our agreement and confirm that the ${money(f.equipmentCostCents)} charge will be released.`,
  ], [...schedule, 'venue', 'venueIncludesAV', 'equipmentCostCents']);
  if (title === 'Confirm the new catering headcount') return draft(`Catering for ${f.attendance} guests`, vendorGreeting, [
    `Our guest count for ${name} is now ${f.attendance}. We’re still planning for ${when}.`,
    `Can you accommodate the new count at the current ${money(f.cateringPerPersonCents)} per-person rate? Please let us know if the menu, price or delivery arrangements need to change.`,
  ], [...schedule, 'attendance', 'caterer', 'cateringPerPersonCents']);
  if (title === 'Confirm catering details') return draft('Confirm the menu and dietary needs', vendorGreeting, [
    `Could we confirm the menu for ${f.attendance} guests? ${event}`, dietary,
    'Please flag any price changes before we go ahead.',
  ], [...schedule, ...place, ...food]);
  if (title === 'Confirm catering delivery at the new venue') return draft('New delivery location', vendorGreeting, [
    `We’ve moved ${name} to ${location}. The event is on ${when}, with ${f.attendance} guests.`,
    'Can you deliver and set up there? Please let us know about any access requirements or extra charges before changing the order.',
  ], [...schedule, ...place, 'attendance', 'caterer']);
  if (title === 'Confirm catering for the updated schedule') return draft('Catering for the new event schedule', vendorGreeting, [
    `We’ve changed the schedule for ${name}: ${when}, at ${location}. We’re planning a ${f.format.toLowerCase()} for ${f.attendance} guests.`,
    'Are you available at the new time, and would this change the price?',
  ], [...schedule, ...place, 'format', 'attendance', 'caterer']);
  if (title === 'Confirm catering arrangements') return draft(`Catering details for ${f.attendance} guests`, vendorGreeting, [
    `Could you confirm the updated arrangements for ${name}? We’re expecting ${f.attendance} guests on ${when} at ${location}.`, dietary,
    `We’ve budgeted ${money(f.cateringPerPersonCents)} per guest${f.cateringDeliveryCents ? ` plus ${money(f.cateringDeliveryCents)} for delivery` : ', with no separate delivery charge'}. Please confirm the menu, delivery access and any price changes before adjusting the order.`,
  ], [...schedule, ...place, ...food, 'cateringPerPersonCents', 'cateringDeliveryCents']);
  if (['Update staff on the guest count', 'Confirm the staffing arrangement', 'Confirm staff arrangements'].includes(title)) return draft(`Staffing for ${f.attendance} guests`, staffGreeting, [
    `We’re expecting ${f.attendance} guests for ${name}, so the plan calls for ${staff} staff. ${event}`,
    `Can you confirm coverage and who will handle setup and dinner service? We’ve allowed ${money(staff * f.staffCostEachCents)} for staffing; please flag any additional cost.`,
    ...(f.dietary.trim() ? [`For meal service: ${sentence(f.dietary)}`] : []),
  ], [...schedule, ...place, 'attendance', 'staffCount', 'staffCostEachCents', 'caterer', 'cateringStatus', 'dietary']);
  if (title === 'Update staff on the new venue') return draft('New venue and setup arrangements', staffGreeting, [
    `${name} has moved to ${location}. We’re scheduled for ${when}.`,
    'Please adjust your arrival and setup plans, and let me know if the move changes anything you need for service.',
  ], [...schedule, ...place]);
  if (title === 'Update staff on the event schedule') return draft('New event schedule', staffGreeting, [
    `We’ve changed ${name} to ${when} at ${location}. We’re planning a ${f.format.toLowerCase()}.`,
    'Can you confirm you’re available and flag any changes needed for setup or service?',
  ], [...schedule, ...place, 'format']);
  if (title === 'Tell staff about the confirmed meal') return draft(`Meal confirmed with ${f.caterer}`, staffGreeting, [
    `${f.caterer} has confirmed catering for ${f.attendance} guests. ${event}`,
    f.dietary.trim() ? `Please keep this dietary note in the service plan: “${sentence(f.dietary)}”` : '',
    'Please adjust the meal service arrangements and let me know if you need anything else from the caterer.',
  ], [...schedule, ...place, ...food]);
  if (title === 'Confirm venue availability for the updated schedule') return draft('Availability for our new event schedule', `Hi ${f.venue} team,`, [
    `We’d like to move ${name} to ${when}. We’re planning a ${f.format.toLowerCase()} for ${f.attendance} guests.`,
    'Is the room available and suitable for this setup? Please confirm any change in fees before we change the booking.',
  ], [...schedule, 'venue', 'format', 'attendance']);
  if (title === 'Confirm the equipment plan') return draft('Confirm equipment and pricing', 'Hi Bright AV team,', [
    `${event} We’ve set aside ${money(f.equipmentCostCents)} for external equipment.`,
    'Could you confirm what equipment this covers and the itemized cost? Please flag any changes before adjusting the rental.',
  ], [...schedule, ...place, 'equipmentCostCents']);
  if (title.startsWith('Correct the previous update:')) return draft('Correction to our previous update', 'Hi,', [
    `Please disregard our previous message about “${title.slice('Correct the previous update:'.length).trim()}”.`,
    `The current plan is ${name} on ${when} at ${location}, for ${f.attendance} guests.`,
    'If you’ve already acted on the earlier message, please let me know so we can work through any changes.',
  ], [...schedule, ...place, 'attendance']);
  return undefined;
}
