export type PlaceKind = 'venue' | 'catering';
export type VenueCapacity = {guests:number;room:string;layout:'banquet'|'seated_dinner'|'reception'|'theater'|'classroom'|'other';sourceUrl:string;excerpt:string};
export type VenueAV = {included:boolean;room:string;items:string[];sourceUrl:string;excerpt:string};
export type VenueRoomLimit = {guests:number;room:string;sourceUrl:string;excerpt:string};
export type PlaceCandidate = {
  id: string;
  name: string;
  address: string;
  locality: 'Cambridge' | 'Boston';
  sourceUrl: string;
  website: string;
  sourceCheckedAt: string;
  capacity?:VenueCapacity|null;
  av?:VenueAV|null;
  roomLimit?:VenueRoomLimit|null;
};
export type PlaceSearchResult = {
  query: string;
  kind: PlaceKind;
  area: 'Cambridge, MA';
  mode: 'verified_directory' | 'local_embeddings';
  results: PlaceCandidate[];
  message: string;
};

export type DirectoryEntry = PlaceCandidate & { kind: PlaceKind; aliases: string[]; description?: string };
const checkedAt = '2026-09-20';

// Bounded hackathon directory, checked against the linked public sources.
// Published room facts below are tied to exact rooms and layouts, never availability or bookings.
// No runtime geocoding/autocomplete service, account access, or API key is needed.
const originalDirectory: DirectoryEntry[] = [
  {
    id: 'boston-marriott-cambridge', kind: 'venue', name: 'Boston Marriott Cambridge',
    address: '50 Broadway, Cambridge, MA 02142', locality: 'Cambridge',
    sourceUrl: 'https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/overview/',
    website: 'https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/overview/',
    sourceCheckedAt: checkedAt, aliases: ['marriott hotel', 'kendall square hotel', 'meeting venue'],
    capacity:{guests:600,room:'Grand Ballroom',layout:'banquet',sourceUrl:'https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/events/',excerpt:'Grand Ballroom capacity chart: Banquet 600.'},
  },
  {
    id: 'charles-hotel-cambridge', kind: 'venue', name: 'The Charles Hotel',
    address: '1 Bennett Street, Cambridge, MA 02138', locality: 'Cambridge',
    sourceUrl: 'https://www.charleshotel.com/pdf/meeting-space-floorplans.pdf',
    website: 'https://www.charleshotel.com/', sourceCheckedAt: checkedAt,
    aliases: ['charles hotel harvard square', 'meeting venue'],
  },
  {
    id: 'hyatt-regency-cambridge', kind: 'venue', name: 'Hyatt Regency Boston / Cambridge',
    address: '575 Memorial Drive, Cambridge, MA 02139', locality: 'Cambridge',
    sourceUrl: 'https://www.hyatt.com/hyatt-regency/en-US/bosrc-hyatt-regency-boston-cambridge/hotel-info',
    website: 'https://www.hyatt.com/hyatt-regency/en-US/bosrc-hyatt-regency-boston-cambridge',
    sourceCheckedAt: checkedAt, aliases: ['hyatt hotel', 'meeting venue'],
  },
  {
    id: 'courtyard-boston-cambridge', kind: 'venue', name: 'Courtyard by Marriott Boston Cambridge',
    address: '777 Memorial Drive, Cambridge, MA 02139', locality: 'Cambridge',
    sourceUrl: 'https://www.marriott.com/en-us/hotels/boscy-courtyard-boston-cambridge/rooms/',
    website: 'https://www.marriott.com/en-us/hotels/boscy-courtyard-boston-cambridge/overview/',
    sourceCheckedAt: checkedAt, aliases: ['courtyard hotel', 'marriott hotel', 'meeting venue'],
  },
  {
    id:'warrior-ice-arena',kind:'venue',name:'Warrior Ice Arena',address:'90 Guest Street, Boston, MA 02135',locality:'Boston',
    sourceUrl:'https://www.warrioricearena.com/private-special-events/private-events/',website:'https://www.warrioricearena.com/private-special-events/',sourceCheckedAt:checkedAt,aliases:['warrior arena'],
    capacity:null,
    roomLimit:{guests:197,room:'Standard Event Room',sourceUrl:'https://www.warrioricearena.com/private-special-events/private-events/',excerpt:'Event room: capacity of 197 guests. The published page does not specify a seated-dinner layout.'},
    av:{included:true,room:'Standard Event Room',items:['Two 75-inch televisions','Microphone and speakers','AV connections','Podium'],sourceUrl:'https://www.warrioricearena.com/private-special-events/private-events/',excerpt:'Rental inclusions list televisions, AV connections, a microphone, speakers and a podium.'},
  },
  {
    id: 'cava-harvard-square', kind: 'catering', name: 'CAVA — Harvard Square',
    address: '22 Brattle Street, Cambridge, MA 02138', locality: 'Cambridge',
    // Current address from Cambridge Office for Tourism, corroborated by CAVA's own
    // opening post: https://www.linkedin.com/posts/cava-_harvard-square-we-have-arrived-you-can-activity-7065376224172224512-sl-W
    sourceUrl: 'https://cambridgeusa.org/listings/cava-harvard-square/',
    website: 'https://cava.com/', sourceCheckedAt: checkedAt,
    aliases: ['cava', 'mediterranean bowls', 'restaurant catering'],
  },
  {
    id: 'shahs-halal-cambridge-street-boston', kind: 'catering', name: "Shah's Halal Food — Boston (Cambridge Street)",
    // Cambridge Street is in Boston. Do not relabel it as Cambridge, MA.
    address: '106 Cambridge Street, Boston, MA 02114', locality: 'Boston',
    sourceUrl: 'https://www.shahshalalfood.com/boston-ma/',
    website: 'https://www.shahshalalfood.com/boston-ma/', sourceCheckedAt: checkedAt,
    aliases: ['shah halal', 'shahs halal', 'shahs', 'halal restaurant catering'],
  },
];

export const PLACE_DIRECTORY: readonly DirectoryEntry[] = [
  ...originalDirectory,
  ...VENUE_CATALOG.filter(place => !originalDirectory.some(existing => existing.id === place.id)).map(place => ({ ...place, kind: 'venue' as const })),
];
function publicPlace({ kind: _kind, aliases: _aliases, description: _description, ...place }: DirectoryEntry): PlaceCandidate {
  return structuredClone(place);
}
export function placeById(id: string): PlaceCandidate | undefined {
  const place = PLACE_DIRECTORY.find(place => place.id === id);
  return place ? publicPlace(place) : undefined;
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** One insert/delete/substitution helps partial names without inventing a result. */
function oneEditAway(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

export function searchPlaces(input: { query: string; kind: PlaceKind }): PlaceSearchResult & { mode: 'verified_directory' } {
  if (input.kind !== 'venue' && input.kind !== 'catering') throw new Error('Choose venue or catering.');
  if (typeof input.query !== 'string' || input.query.length > 160) throw new Error('Place search must be text under 161 characters.');
  const query = input.query.trim();
  const normalized = normalize(query);
  const tokens = normalized.split(' ').filter(token => token && !['in', 'near', 'me', 'the'].includes(token));
  const results = PLACE_DIRECTORY.filter(place => place.kind === input.kind).map(place => {
    const name = normalize(place.name);
    const words = normalize([place.name, place.address, ...place.aliases].join(' ')).split(' ');
    let score = place.locality === 'Cambridge' ? 2 : 0;
    for (const token of tokens) {
      if (words.includes(token)) score += 10;
      else if (words.some(word => word.startsWith(token))) score += 6;
      else if (token.length >= 4 && words.some(word => word.length >= 4 && oneEditAway(token, word))) score += 3;
      else return { place, score: -1 };
    }
    if (normalized && (name === normalized || place.aliases.some(alias => normalize(alias) === normalized))) score += 30;
    return { place, score };
  }).filter(match => match.score >= 0).sort((a, b) => b.score - a.score).slice(0, 6)
    .map(({ place }) => publicPlace(place));
  return {
    query, kind: input.kind, area: 'Cambridge, MA', mode: 'verified_directory', results,
    message: results.length
      ? 'Selected places around Cambridge, MA. Check the source for current details; availability and prices are not verified.'
      : 'No match in this small Cambridge-area directory. You can keep your own place name.',
  };
}

/** Unknown layouts never become a dinner seating promise. */
export function capacityFitsEvent(capacity:VenueCapacity,facts?:Pick<import('../shared/types.js').Facts,'format'|'notes'>){
  const format=facts?.format.toLowerCase()??'';
  if(!format||/dinner|banquet|meal|lunch|breakfast|gala|seated/.test(format))return ['banquet','seated_dinner'].includes(capacity.layout);
  if(/cocktail|standing|reception/.test(format))return capacity.layout==='reception';
  if(/classroom|workshop|training/.test(format))return capacity.layout==='classroom';
  if(/theat(?:er|re)|presentation|conference|lecture/.test(format))return capacity.layout==='theater';
  return false;
}

export function verifiedVenueByIdentity(place:{name:string;address:string}){
  const known = PLACE_DIRECTORY.find(known => known.kind === 'venue' && normalize(known.name) === normalize(place.name) && normalize(known.address) === normalize(place.address));
  return known ? publicPlace(known) : undefined;
}
import { VENUE_CATALOG } from './venue-catalog.js';
