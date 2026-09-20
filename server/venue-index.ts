import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACE_DIRECTORY, placeById, searchPlaces, type DirectoryEntry, type PlaceSearchResult } from './places.js';

export const VENUE_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const root = fileURLToPath(new URL('../', import.meta.url));
const snapshotPath = path.join(root, 'fixtures/venue-embeddings.json');
const modelCache = path.join(root, 'data/venue-models');
type Embedder = (texts: string[]) => Promise<number[][]>;
export type VenueEmbeddingSnapshot = { model: string; dtype: 'q8'; dimensions: number; catalogHash: string; entries: { id: string; vector: number[] }[] };
const venues = PLACE_DIRECTORY.filter(place => place.kind === 'venue');
const normalize = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const venueEmbeddingText = (place: DirectoryEntry) => `${place.name}. ${place.locality}, Massachusetts. ${place.description || ''} ${place.aliases.join('. ')}.`;
export function venueCatalogHash(catalog: readonly DirectoryEntry[] = venues) {
  return createHash('sha256').update(JSON.stringify(catalog.map(place => [place.id, venueEmbeddingText(place)]))).digest('hex');
}
export function cosineSimilarity(a: readonly number[], b: readonly number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function validVenueSnapshot(snapshot: VenueEmbeddingSnapshot, catalog: readonly DirectoryEntry[] = venues) {
  return snapshot?.model === VENUE_EMBEDDING_MODEL && snapshot.dtype === 'q8' && snapshot.dimensions === 384
    && snapshot.catalogHash === venueCatalogHash(catalog) && snapshot.entries?.length === catalog.length
    && new Set(snapshot.entries.map(entry => entry.id)).size === catalog.length
    && catalog.every(place => snapshot.entries.some(entry => entry.id === place.id && entry.vector.length === 384 && entry.vector.every(Number.isFinite)));
}

let extractor: Promise<Embedder> | undefined;
async function localEmbedder(allowDownload = false): Promise<Embedder> {
  if (!extractor) extractor = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = modelCache;
    // Normal autocomplete only reads the prepared local cache. Downloads are an
    // explicit setup step; queries never leave this process or spend API credits.
    env.allowRemoteModels = allowDownload;
    const pipe = await pipeline('feature-extraction', VENUE_EMBEDDING_MODEL, {
      dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    return async (texts: string[]) => (await pipe(texts, { pooling: 'mean', normalize: true })).tolist() as number[][];
  })().catch(error => { extractor = undefined; throw error; });
  return extractor;
}

export async function buildVenueIndex(allowDownload = false): Promise<VenueEmbeddingSnapshot> {
  const embed = await localEmbedder(allowDownload);
  const entries: VenueEmbeddingSnapshot['entries'] = [];
  for (let offset = 0; offset < venues.length; offset += 12) {
    const batch = venues.slice(offset, offset + 12);
    const vectors = await embed(batch.map(venueEmbeddingText));
    entries.push(...batch.map((place, index) => ({ id: place.id, vector: vectors[index].map(value => Math.round(value * 1e7) / 1e7) })));
  }
  const snapshot: VenueEmbeddingSnapshot = { model: VENUE_EMBEDDING_MODEL, dtype: 'q8', dimensions: 384, catalogHash: venueCatalogHash(), entries };
  if (!validVenueSnapshot(snapshot)) throw new Error('The venue embedding index is incomplete.');
  mkdirSync(path.dirname(snapshotPath), { recursive: true }); writeFileSync(snapshotPath, JSON.stringify(snapshot) + '\n');
  return snapshot;
}

export function rankVenueVectors(query: string, vector: readonly number[], snapshot: VenueEmbeddingSnapshot, catalog: readonly DirectoryEntry[] = venues) {
  const normalized = normalize(query);
  return snapshot.entries.map(entry => {
    const place = catalog.find(place => place.id === entry.id);
    if (!place) return null;
    const semantic = cosineSimilarity(vector, entry.vector);
    const exact = [place.name, ...place.aliases].some(value => normalize(value) === normalized);
    // Semantic fit is primary; exact identities and Cambridge locality break
    // close matches. An alias never creates a business or a booking promise.
    const score = semantic + (place.locality === 'Cambridge' ? 0.04 : 0) + (exact ? 0.3 : 0);
    return { id: entry.id, semantic, score };
  }).filter((entry): entry is { id: string; semantic: number; score: number } => !!entry && entry.semantic >= 0.25)
    .sort((a, b) => b.score - a.score).slice(0, 6);
}

let prepared: Promise<{ embed: Embedder; snapshot: VenueEmbeddingSnapshot }> | undefined;
export async function warmVenueIndex() {
  if (!prepared) prepared = (async () => {
    const embed = await localEmbedder();
    let snapshot: VenueEmbeddingSnapshot | undefined;
    if (existsSync(snapshotPath)) { try { const loaded = JSON.parse(readFileSync(snapshotPath, 'utf8')); if (validVenueSnapshot(loaded)) snapshot = loaded; } catch { /* Rebuild stale or invalid vectors locally. */ } }
    snapshot ??= await buildVenueIndex();
    return { embed, snapshot };
  })().catch(error => { prepared = undefined; throw error; });
  return prepared;
}
const queries = new Map<string, Promise<PlaceSearchResult>>();
export async function searchVenueIndex(query: string): Promise<PlaceSearchResult> {
  const lexical = searchPlaces({ query, kind: 'venue' }); // validates and resolves prefixes without loading a model
  const normalized = normalize(query);
  if (normalized.length < 3 || lexical.results.length > 0) return lexical;
  const cached = queries.get(normalized); if (cached) return structuredClone(await cached);
  const search = (async (): Promise<PlaceSearchResult> => {
    try {
      const { embed, snapshot } = await warmVenueIndex();
      const [vector] = await embed([query]);
      const matches = rankVenueVectors(query, vector, snapshot).map(match => placeById(match.id)).filter((place): place is NonNullable<typeof place> => !!place);
      return { query, kind: 'venue', area: 'Cambridge, MA', mode: 'local_embeddings', results: matches,
        message: matches.length ? 'Nearby venue matches. Availability, room layout, and prices still need confirmation.' : 'No close match in the indexed Cambridge venues. You can keep your own place name.' };
    } catch {
      queries.delete(normalized);
      return { ...lexical, message: 'Local semantic search is warming up. Named-place lookup is still available.' };
    }
  })();
  queries.set(normalized, search);
  if (queries.size > 200) queries.delete(queries.keys().next().value!);
  return structuredClone(await search);
}
