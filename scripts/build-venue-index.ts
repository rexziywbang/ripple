import { buildVenueIndex, searchVenueIndex, warmVenueIndex } from '../server/venue-index.js';
import { writeFileSync } from 'node:fs';

const start = performance.now();
const snapshot = await buildVenueIndex(true);
const { embed } = await warmVenueIndex();
console.log(`Prepared ${snapshot.entries.length} venues using ${snapshot.model} (${snapshot.dimensions} dimensions) in ${Math.round(performance.now() - start)} ms.`);
const queries = ['ice rink', 'an evening of skating with colleagues', 'a gallery surrounded by paintings', 'a lecture hall for a keynote'];
const vectors = await embed(queries);
writeFileSync(new URL('../fixtures/venue-search-evaluation.json', import.meta.url), JSON.stringify({ model: snapshot.model, cases: queries.map((query, index) => ({ query, vector: vectors[index].map(value => Math.round(value * 1e7) / 1e7) })) }) + '\n');
for (const query of queries) {
  const before = performance.now(); const result = await searchVenueIndex(query);
  console.log(`${query}: ${result.results.slice(0, 3).map(place => place.name).join(' · ')} (${Math.round(performance.now() - before)} ms; ${result.mode})`);
}
