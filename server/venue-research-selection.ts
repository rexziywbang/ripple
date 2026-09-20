import type {EditRequest, Facts, VenueResearchEvidence} from '../shared/types.js';

export type VenueSelection = {
 id:string;name:string;address:string;sourceUrl:string;sourceCheckedAt:string;
 capacity?:VenueResearchEvidence['capacity'];av?:VenueResearchEvidence['av'];roomLimit?:VenueResearchEvidence['roomLimit'];
};
export type ResolvedVenueEdit = EditRequest & {venueEvidence?:VenueResearchEvidence};
type Lookup = (id:string,facts?:Facts)=>VenueSelection|undefined;
const identity=(value:string)=>value.trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');

/** Selection metadata resolves only through server-owned research; it is not a fact or provenance supplied by the client. */
export function resolveVenueEdit(request:EditRequest,facts:Facts,lookup:Lookup):ResolvedVenueEdit {
 const selectionId=request.patch?.venueResearchId;
 if(selectionId===undefined)return request;
 if(request.area!=='venue'||!selectionId.trim())throw new Error('Choose a researched venue from the location results.');
 const nextFormat=request.patch?.format??facts.format;
 const place=lookup(selectionId,{...facts,format:nextFormat});
 if(!place)throw new Error('This venue research is no longer available. Search for the venue again.');
 if(typeof request.patch?.venue!=='string'||typeof request.patch?.venueAddress!=='string'||identity(request.patch.venue)!==identity(place.name)||identity(request.patch.venueAddress)!==identity(place.address))throw new Error('The selected venue no longer matches these details. Choose the location again.');
 const patch={...request.patch,venue:place.name,venueAddress:place.address};
 // A selected public listing has no authority to quote a rental price. Ignore
 // client capacity/AV values and use only evidence from this same server result.
 delete patch.venueResearchId;delete patch.venueCapacity;delete patch.venueIncludesAV;delete patch.venueCostCents;
 if(place.capacity&&Number.isSafeInteger(place.capacity.guests)&&place.capacity.guests>0)patch.venueCapacity=place.capacity.guests;
 if(place.av&&typeof place.av.included==='boolean')patch.venueIncludesAV=place.av.included;
 const venueEvidence:VenueResearchEvidence={researchId:place.id,name:place.name,address:place.address,eventFormat:nextFormat,checkedAt:place.sourceCheckedAt,sourceUrl:place.sourceUrl,capacity:place.capacity??null,av:place.av??null,roomLimit:place.roomLimit??null};
 // Structured selected facts remain authoritative; a stale free-form enrichment
 // note must not attach a different venue's fixture terms to this selection.
 return {area:request.area,patch,venueEvidence};
}
