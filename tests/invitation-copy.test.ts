import { afterEach, describe, expect, it } from 'vitest';
import { dietaryNeedsKey, guestDietaryCopy, writeGuestInvitation } from '../shared/invitation-copy.js';
import { createService, fallbackPlan } from '../server/domain.js';
import { initialFacts } from '../server/fixtures.js';

const services:ReturnType<typeof createService>[]=[];
afterEach(()=>services.splice(0).forEach(service=>service.close()));
const setup=()=>{const service=createService({dbPath:':memory:',planner:async input=>fallbackPlan(input),aiStatus:()=>({mode:'demo',model:'fixture',fallbackModel:'fixture',estimatedSpendUsd:0,spendLimitUsd:8})});services.push(service);return {service,id:service.getState().project.id};};

describe('Guest invitation copy and notification discipline',()=>{
 it('promises only availability recorded explicitly, never an unresolved dietary requirement',()=>{
   expect(guestDietaryCopy('kosher options needed')).toBe('');
   expect(guestDietaryCopy('Kosher options are available')).toBe('Kosher options are available.');
   expect(guestDietaryCopy('Kosher options are not available')).toBe('');
   expect(guestDietaryCopy('Kosher options may be available')).toBe('');
   expect(dietaryNeedsKey('kosher options needed')).toBe(dietaryNeedsKey('Kosher options are available'));
 });
 it('puts the complete event and confirmed meal in the original invitation',()=>{
   const body=writeGuestInvitation({...initialFacts,name:'Christmas dinner',caterer:'CAVA',dietary:'Kosher options are available'});
   expect(body).toContain('Friday, December 11 at 6 PM');
   expect(body).toContain('Dinner will be provided by CAVA. Kosher options are available.');
   expect(body).not.toContain('Requirements:');
   expect(body).not.toContain('Please adjust');
 });
 it('consolidates venue and time changes into one current invitation',async()=>{
   const {service,id}=setup();service.edit(id,{area:'venue',patch:{venue:'New room',venueAddress:'Cambridge'}});await service.tick();
   service.edit(id,{area:'brief',patch:{time:'19:00'}});await service.tick();
   const invitations=service.getState().proposals.filter(p=>p.kind==='invitation'&&p.status==='pending');
   expect(invitations).toHaveLength(1);expect(invitations[0].body).toContain('New room');expect(invitations[0].body).toContain('7 PM');
 });
 it('updates a delivered invitation description without another guest message for dietary availability',async()=>{
   const {service,id}=setup();service.edit(id,{area:'catering',patch:{dietary:'kosher options needed'}});await service.tick();
   service.edit(id,{area:'venue',patch:{venue:'New room'}});await service.tick();
   const first=service.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;
   service.decide(id,first.id,'approve');await service.tick();
   const priorCount=service.getState().messages.length;
   service.edit(id,{area:'catering',patch:{dietary:'Kosher options are available'}});await service.tick();
   const update=service.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;
   expect(update.invitationNotifyGuests).toBe(false);expect(update.body).toContain('Kosher options are available.');
   service.decide(id,update.id,'approve');await service.tick();
   expect(service.getState().messages).toHaveLength(priorCount);
   expect(service.getState().receipts.find(r=>r.proposalId===update.id)?.detail).toContain('No guest notification');
 });
 it.each([
   {area:'venue' as const,patch:{venue:'Room B'}},
   {area:'brief' as const,patch:{date:'2026-12-12',time:'19:00'}},
 ])('preserves an unsent $area change when dietary availability updates the invitation',async request=>{
   const {service,id}=setup();
   service.edit(id,{area:'catering',patch:{dietary:'kosher options needed'}});await service.tick();
   service.edit(id,{area:'venue',patch:{venue:'Room A'}});await service.tick();
   const first=service.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;
   service.decide(id,first.id,'approve');await service.tick();
   service.edit(id,request);await service.tick();
   service.edit(id,{area:'catering',patch:{dietary:'Kosher options are available'}});await service.tick();
   const invitations=service.getState().proposals.filter(p=>p.kind==='invitation'&&p.status==='pending');
   expect(invitations).toHaveLength(1);
   const update=invitations[0];
   expect(update.invitationNotifyGuests).toBe(true);
   expect(update.invitationSnapshot).toMatchObject(request.patch);
   expect(update.body).toContain('Kosher options are available.');
   const priorCount=service.getState().messages.length;
   service.decide(id,update.id,'approve');await service.tick();
   expect(service.getState().messages).toHaveLength(priorCount+1);
 });
});
