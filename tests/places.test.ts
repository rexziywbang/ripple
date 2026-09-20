import { describe, expect, it } from 'vitest';
import { searchPlaces } from '../server/places.js';

describe('public Cambridge-area place directory', () => {
  it('finds Shahs despite apostrophes and labels its actual Boston address', () => {
    for (const query of ['Shah Halal', 'Shah’s Halal', 'shahs', 'shahs halal cambridge']) {
      const result = searchPlaces({ query, kind: 'catering' });
      expect(result.mode).toBe('verified_directory');
      expect(result.results[0]).toMatchObject({
        id: 'shahs-halal-cambridge-street-boston', locality: 'Boston',
        address: '106 Cambridge Street, Boston, MA 02114',
        sourceUrl: 'https://www.shahshalalfood.com/boston-ma/',
      });
    }
  });

  it('finds typed venue prefixes and common spelling mistakes', () => {
    for (const query of ['marr', 'Marriot', 'marriot cambridge', '50 Broadway']) {
      const result = searchPlaces({ query, kind: 'venue' });
      expect(result.results.some(place => place.id === 'boston-marriott-cambridge')).toBe(true);
    }
    expect(searchPlaces({ query: 'CAVA', kind: 'catering' }).results[0].address).toBe('22 Brattle Street, Cambridge, MA 02138');
  });

  it('keeps categories separate and unknown places available for manual entry', () => {
    expect(searchPlaces({ query: 'Shahs', kind: 'venue' }).results).toEqual([]);
    expect(searchPlaces({ query: 'Marriott', kind: 'catering' }).results).toEqual([]);
    const unknown = searchPlaces({ query: 'A place not in this directory', kind: 'venue' });
    expect(unknown.results).toEqual([]);
    expect(unknown.message).toContain('keep your own place name');
  });

  it('returns bounded sourced identities with no fabricated booking details', () => {
    for (const kind of ['venue', 'catering'] as const) {
      const response = searchPlaces({ query: '', kind });
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.length).toBeLessThanOrEqual(6);
      expect(response.results[0].locality).toBe('Cambridge');
      for (const place of response.results) {
        expect(new URL(place.sourceUrl).protocol).toBe('https:');
        expect(place.sourceCheckedAt).toBe('2026-09-20');
        expect(Object.keys(place).filter(key=>!['capacity','av','roomLimit'].includes(key)).sort()).toEqual(['address', 'id', 'locality', 'name', 'sourceCheckedAt', 'sourceUrl', 'website']);
      }
    }
  });

  it('does not mutate the directory through returned results and bounds query input', () => {
    searchPlaces({ query: 'CAVA', kind: 'catering' }).results[0].name = 'Changed';
    expect(searchPlaces({ query: 'CAVA', kind: 'catering' }).results[0].name).toBe('CAVA — Harvard Square');
    expect(() => searchPlaces({ query: 'x'.repeat(161), kind: 'venue' })).toThrow('Place search');
    expect(() => searchPlaces({ query: '', kind: 'invalid' as 'venue' })).toThrow('Choose venue');
    searchPlaces({query:'Marriott',kind:'venue'}).results.find(place=>place.capacity)!.capacity!.guests=1;
    expect(searchPlaces({query:'Marriott',kind:'venue'}).results.find(place=>place.capacity)!.capacity!.guests).toBe(600);
  });
});
