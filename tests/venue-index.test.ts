import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACE_DIRECTORY, placeById, searchPlaces, verifiedVenueByIdentity } from '../server/places.js';
import { cosineSimilarity, rankVenueVectors, searchVenueIndex, validVenueSnapshot, VENUE_EMBEDDING_MODEL, type VenueEmbeddingSnapshot } from '../server/venue-index.js';

const snapshot = JSON.parse(readFileSync(new URL('../fixtures/venue-embeddings.json', import.meta.url), 'utf8')) as VenueEmbeddingSnapshot;
const evaluation = JSON.parse(readFileSync(new URL('../fixtures/venue-search-evaluation.json', import.meta.url), 'utf8')) as { model: string; cases: { query: string; vector: number[] }[] };

describe('local Cambridge venue retrieval', () => {
  it('puts MIT Johnson first for ice rink without a network or embedding warmup', async () => {
    const result = await searchVenueIndex('ice rink');
    expect(result.mode).toBe('verified_directory');
    expect(result.results.slice(0, 2).map(place => place.id)).toEqual(['mit-johnson-athletic-center', 'simoni-skating-rink']);
    expect(result.results[0]).toMatchObject({ address: '120 Vassar Street, Cambridge, MA 02139', sourceUrl: 'https://calendar.mit.edu/building_w34' });
    expect(result.results[0].capacity).toBeUndefined();
    expect(result.results[0].av).toBeUndefined();
  });
  it('finds aliases, abbreviations and partial names across the full sourced catalog', () => {
    for (const query of ['johnson', 'MIT ice rink', 'w34', 'johnson ice r']) expect(searchPlaces({ query, kind: 'venue' }).results[0]?.id, query).toBe('mit-johnson-athletic-center');
    expect(searchPlaces({ query: 'Simoni', kind: 'venue' }).results[0].id).toBe('simoni-skating-rink');
    expect(searchPlaces({ query: 'Foundry', kind: 'venue' }).results[0].id).toBe('cambridge-foundry');
  });
  it('resolves every catalog identity even when absent from the six autocomplete defaults', () => {
    const defaults = searchPlaces({ query: '', kind: 'venue' }).results;
    const outsideDefault = PLACE_DIRECTORY.filter(place => place.kind === 'venue' && !defaults.some(shown => shown.id === place.id));
    expect(outsideDefault.length).toBeGreaterThan(5);
    for (const place of outsideDefault) {
      expect(placeById(place.id)?.name).toBe(place.name);
      expect(verifiedVenueByIdentity(place)?.id).toBe(place.id);
    }
    expect(placeById('invented-venue')).toBeUndefined();
    expect(verifiedVenueByIdentity({ name: 'MIT Johnson Athletic Center — Ice Rink', address: 'Wrong address' })).toBeUndefined();
  });
  it('returns copies so selection cannot overwrite the indexed identity', () => {
    placeById('mit-johnson-athletic-center')!.name = 'Changed';
    expect(placeById('mit-johnson-athletic-center')!.name).toContain('Johnson');
  });
  it('ships actual 384-dimensional model vectors bound to the current catalog', () => {
    expect(snapshot.model).toBe(VENUE_EMBEDDING_MODEL);
    expect(validVenueSnapshot(snapshot)).toBe(true);
    expect(snapshot.entries.length).toBe(PLACE_DIRECTORY.filter(place => place.kind === 'venue').length);
    for (const entry of snapshot.entries) expect(cosineSimilarity(entry.vector, entry.vector)).toBeCloseTo(1, 6);
    expect(validVenueSnapshot({ ...snapshot, catalogHash: 'old' })).toBe(false);
    expect(validVenueSnapshot({ ...snapshot, entries: snapshot.entries.slice(1) })).toBe(false);
    expect(validVenueSnapshot({ ...snapshot, entries: snapshot.entries.map((entry, index) => index ? entry : { ...entry, vector: [NaN] }) })).toBe(false);
  });
  it('retrieves semantic paraphrases from model embeddings rather than shared query words', () => {
    expect(evaluation.model).toBe(VENUE_EMBEDDING_MODEL);
    const expected: Record<string, string[]> = {
      'an evening of skating with colleagues': ['simoni-skating-rink', 'mit-johnson-athletic-center'],
      'a gallery surrounded by paintings': ['harvard-art-museums'],
      'a lecture hall for a keynote': ['mit-kresge-auditorium'],
    };
    for (const [query, ids] of Object.entries(expected)) {
      expect(searchPlaces({ query, kind: 'venue' }).results, 'These queries must exercise semantic retrieval').toEqual([]);
      const vector = evaluation.cases.find(item => item.query === query)!.vector;
      expect(rankVenueVectors(query, vector, snapshot).slice(0, ids.length).map(place => place.id)).toEqual(ids);
    }
  });
  it('does not fabricate matches from empty, malformed, or unrelated vectors', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(rankVenueVectors('unknown', Array(384).fill(0), snapshot)).toEqual([]);
    expect(() => searchPlaces({ query: 'x'.repeat(161), kind: 'venue' })).toThrow('Place search');
  });
});
