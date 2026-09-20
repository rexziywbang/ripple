import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, MapPin, X } from "lucide-react";
import "./place-matches.css";

export type PlaceMatch = { id: string; name: string; address: string; sourceUrl: string; website?: string;reason?:string;caveat?:string };
type PlaceResponse = { query: string; kind: "venue" | "catering"; area: string; results: PlaceMatch[]; message?: string;mode?:string };
export function placeSelectionPatch(kind: "venue" | "catering", place: PlaceMatch) {
  return kind === "venue" ? { venue: place.name, venueAddress: place.address, venueResearchId: place.id } : { caterer: place.name };
}
const publicLink = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

export default function PlaceMatches({ query, kind, projectId, onSelect, onDismiss }: {
  query: string; kind: "venue" | "catering"; projectId?:string;onSelect: (place: PlaceMatch) => void; onDismiss: () => void;
}) {
  const [result, setResult] = useState<PlaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(""); setLoading(query.trim().length >= 3);
    if (query.trim().length < 3) return () => controller.abort();
    const timer = window.setTimeout(async () => {
      try {
        const search = new URLSearchParams({ query: query.trim(), kind });
        if(projectId)search.set('projectId',projectId);
        const response = await fetch(`/api/places?${search}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Nearby matches are unavailable.");
        if (controller.signal.aborted) return;
        if (!Array.isArray(body.results)) throw new Error("Nearby matches are unavailable.");
        setResult(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nearby matches are unavailable.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 900);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, kind,projectId]);
  if (query.trim().length < 3) return null;
  const currentResult = result?.query === query.trim() && result.kind === kind ? result : null;
  const searching = loading || (!currentResult && !error);
  return <aside className="place-matches" aria-label="Nearby place suggestions">
    <header><span><MapPin size={13} />Near {currentResult?.area || "Cambridge, MA"}</span><button type="button" onClick={onDismiss} aria-label="Dismiss place suggestions"><X size={13} /></button></header>
    {searching ? <p className="pm-loading" role="status"><LoaderCircle size={13} />Finding places…</p> : currentResult?.results.length ? <><ul>{currentResult.results.slice(0, 3).map(place => {
      const source = publicLink(place.sourceUrl);
      return <li key={place.id}><button type="button" className="pm-select" onClick={() => onSelect(place)}><strong>{place.name}</strong><span>{place.address}</span>{place.reason&&<span className="pm-reason">{place.reason}</span>}</button>{place.caveat&&<p className="pm-caveat">{place.caveat}</p>}{source && <a href={source} target="_blank" rel="noreferrer" aria-label={`Public source for ${place.name}`}>Source<ExternalLink size={11} /></a>}</li>;
    })}</ul></> : <p className="pm-empty">{error || currentResult?.message || "No matching place found. You can keep your entry."}</p>}
  </aside>;
}
