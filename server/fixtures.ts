import type {Facts,Source} from '../shared/types.js';

export const initialFacts:Facts = {
  attendance:240,date:'2026-12-11',time:'18:00',timezone:'America/New_York',format:'Seated dinner',
  venue:'Garden Hall',venueAddress:'125 Garden Avenue, Boston, MA (demo)',venueCapacity:260,venueCostCents:720000,venueIncludesAV:false,venueDetailsPending:false,
  caterer:'Shah Halal',cateringPerPersonCents:2400,cateringDeliveryCents:0,cateringStatus:'confirmed',
  dietary:'Vegetarian and halal options required',staffCount:4,staffCostEachCents:30000,equipmentCostCents:180000,
  budgetLimitCents:1800000,sunkCostCents:0,notes:'Christmas dinner for the Northstar team. Dinner, team awards, and a short presentation.',
};

export const sources:Source[] = [
 {id:'brief',title:'Event brief',area:'brief',path:'/Christmas dinner/01 Brief/event-brief.md',content:'# Christmas dinner\nDecember 11, 2026, 6 PM America/New_York. 240 guests. Seated corporate dinner, team awards, short presentation. Budget ceiling $18,000. Vegetarian and halal options must be confirmed.'},
 {id:'venue-garden',title:'Garden Hall agreement',area:'venue',path:'/Christmas dinner/02 Venue/garden-hall.md',content:'# Garden Hall · fictional demo agreement\nCapacity 260 seated. Venue fee $7,200. AV is not included. Address: 125 Garden Avenue, Boston, MA (demo). Contact: events@gardenhall.example. Availability and fees are sample data, not a real booking.'},
 {id:'venue-marriott',title:'Marriott proposal',area:'venue',path:'/Christmas dinner/02 Venue/marriott-proposal.md',content:'# Marriott Downtown · fictional demo proposal\nExact demo room: Grand Ballroom. Proposed December 11, 2026, 6 PM. Capacity 360 seated. Room fee $8,000. House projector, sound and microphones included. Address: 500 Harbor Street, Boston, MA (demo). Contact: events@marriott-demo.example. A proposal is not a confirmed booking; all details are fictional.'},
 {id:'catering-current',title:'Current catering agreement',area:'catering',path:'/Christmas dinner/03 Catering/current-agreement.md',content:'# Shah Halal · fictional demo agreement\n240 guests at $24 per person, $5,760 total. A $600 non-refundable deposit is already included in the total. Confirmed cancellation releases the remaining $5,160. Contact: catering@shahhalal.example. Cancellation must be confirmed before releasing the outstanding commitment.'},
 {id:'catering-cava',title:'CAVA contact and quote fixture',area:'catering',path:'/Christmas dinner/03 Catering/cava-contact.md',content:'# CAVA · fictional demo contact\nContact catering@cava.example to request availability, menu, dietary suitability and a quote. The demo reply quotes $26 per guest plus $240 delivery: $6,480 for 240. Quote validity depends on date and headcount. A quote does not confirm a booking, and dietary suitability must be confirmed.'},
 {id:'staffing-policy',title:'Staffing plan',area:'staff',path:'/Christmas dinner/04 Staff/staffing-plan.md',content:'# Staffing · fictional event policy\nOne staff member per 60 guests, rounded up. $300 per staff member. Currently four staff. Contact staff@northstar.example. This is a demo event policy, not a universal staffing requirement.'},
 {id:'equipment-contract',title:'AV rental agreement',area:'equipment',path:'/Christmas dinner/05 Equipment/av-rental.md',content:'# AV rental · fictional demo agreement\nProjector, microphones and sound: $1,800. Contact logistics@brightav.example. For this fixture the rental can be canceled without penalty. Confirm equivalent equipment at the new venue before removal.'},
 {id:'budget',title:'Event budget',area:'budget',path:'/Christmas dinner/06 Budget/budget.md',content:'# Initial event budget\nVenue $7,200 + catering $5,760 + staff $1,200 + AV $1,800 = $15,960. Ceiling $18,000. Deposit is included in catering and must never be double counted.'},
 {id:'guests',title:'Invitation and guest details',area:'guests',path:'/Christmas dinner/07 Guests/invitation.md',content:'# Guest details\n240 invited guests. Invitation group: christmas-guests@northstar.example. December 11, 2026, 6 PM. Garden Hall. Use confirmed event details only in final invitations. These addresses use the reserved .example domain and cannot receive real messages.'},
];

export const contactForVendor=(name:string)=>/cava/i.test(name)?'catering@cava.example':/shah/i.test(name)?'catering@shahhalal.example':`events@${name.toLowerCase().replace(/[^a-z0-9]/g,'')||'vendor'}.example`;
