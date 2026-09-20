import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanner, classifyFailure, planSchema, sanitize, sanitizePlan, UsageLedger } from '../server/planner.js';
import { initialFacts, sources } from '../server/fixtures.js';
import type { FactPatch, Planner } from '../shared/types.js';
import { RunContext, type Agent } from '@openai/agents';

const input:Parameters<Planner>[0]={area:'guests',note:'Attendance is now 300',facts:structuredClone(initialFacts),sources:structuredClone(sources)};
const dirs:string[]=[];const closers:Array<()=>void>=[];
function output(patch:FactPatch={attendance:300}){return {patch:{...Object.fromEntries(Object.keys(planSchema.shape.patch.shape).map(k=>[k,null])),...patch},summary:'Updated the guest count to 300.',questions:[],evidenceIds:['guests'],insights:[]};}
function planner(options:Parameters<typeof createPlanner>[0]={}){const p=createPlanner({apiKey:'unit-test-placeholder',dbPath:':memory:',model:'gpt-6-astra',spendLimitUsd:2,...options});closers.push(p.close);return p;}
async function readSource(agent:Agent<any,any>,sourceId='guests'){const sourceTool=agent.tools.find(t=>t.type==='function'&&t.name==='read_source');if(sourceTool?.type==='function')await sourceTool.invoke(new RunContext({}),JSON.stringify({id:sourceId}));}
afterEach(()=>{for(const close of closers.splice(0))close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true});});

describe('bounded Agents SDK planner',()=>{
 it('uses the explicit deterministic mode only when no key is configured',async()=>{
  let calls=0;const p=planner({apiKey:'',execute:async()=>{calls++;throw new Error('Unexpected model call');}});const result=await p.plan(input);
  expect(result.patch.attendance).toBe(300);expect(p.status().mode).toBe('demo');expect(calls).toBe(0);expect(p.status().estimatedSpendUsd).toBe(0);
 });

 it('uses Astra with bounded read-only tools and records reported token usage',async()=>{
  const p=planner({execute:async(agent,text,options)=>{
    expect(agent.model).toBe('gpt-6-astra');expect(agent.modelSettings.reasoning?.effort).toBe('medium');expect(agent.modelSettings.maxTokens).toBe(3000);
    expect(options.maxTurns).toBe(3);expect(options.signal).toBeInstanceOf(AbortSignal);expect(text.length).toBeLessThanOrEqual(10000);
    expect(agent.tools.map(tool=>tool.type==='function'?tool.name:tool.type)).toEqual(['read_event_context','read_source','calculate_budget']);
    await readSource(agent);
    return {finalOutput:output(),runContext:{usage:{inputTokens:1000,outputTokens:600}}};
  }});
  const result=await p.plan(input);expect(result.patch).toEqual({attendance:300});expect(result.model).toBe('gpt-6-astra');expect(p.status().estimatedSpendUsd).toBe(0.04);
 });

 it('repairs a semantic violation once without silently applying consequential changes',async()=>{
  let calls=0;const p=planner({execute:async(agent,text)=>{
    calls++;if(calls===2)expect(text).toContain('must not silently approve');
    await readSource(agent);
    return {finalOutput:output(calls===1?{attendance:300,staffCount:5}:{attendance:300}),runContext:{usage:{inputTokens:500,outputTokens:100}}};
  }});
  const result=await p.plan(input);expect(calls).toBe(2);expect(result.patch).toEqual({attendance:300});expect(p.status().estimatedSpendUsd).toBe(0.02);
 });

 it('never falls back to a demo interpretation or retries authentication failures',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;throw Object.assign(new Error('Incorrect API key provided: sk-secret-never-show'),{status:401});}});
  const result=await p.plan(input);expect(calls).toBe(1);expect(result.patch).toEqual({});expect(result.error).toContain('authentication');expect(result.error).not.toContain('sk-');expect(p.status().mode).toBe('live');
  expect(p.status().estimatedSpendUsd).toBe(0);
 });

 it('bounds network retries with durable conservative reservations',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;throw Object.assign(new Error('Connection error'),{status:503});}});
  const result=await p.plan(input);expect(calls).toBe(1);expect(result.error).toContain('spending guard');expect(p.status().estimatedSpendUsd).toBe(1.35);
  await p.plan(input);expect(calls).toBe(1);
 });

 it('does not retry capability, missing-model, quota, or timeout errors',()=>{
  for(const error of [Object.assign(new Error('Unsupported parameter'),{status:400}),Object.assign(new Error('Model unavailable'),{status:404}),Object.assign(new Error('Quota'),{code:'insufficient_quota'}),Object.assign(new Error('Timeout'),{name:'TimeoutError'})])expect(classifyFailure(error).retryable).toBe(false);
 });

 it('rejects invented evidence and a premature new-vendor price',()=>{
  expect(()=>sanitizePlan({...output(),evidenceIds:['invented-contract']},input)).toThrow('Evidence references');
  expect(()=>sanitizePlan({...output({caterer:'CAVA',cateringPerPersonCents:2600}),evidenceIds:['catering-cava']},{...input,area:'catering'})).toThrow('before their quote');
 });

 it('redacts secrets from error text before exposing them to the UI or repair context',()=>{
  const result=sanitize('API error sk-proj-abcdef_123 Authorization: Bearer a-secret-value api_key=another-secret');
  expect(result).not.toContain('abcdef');expect(result).not.toContain('a-secret-value');expect(result).not.toContain('another-secret');expect(result).toContain('[redacted');
 });

 it('rejects citations that merely name a source without actually reading it',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;return {finalOutput:output(),runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  const result=await p.plan(input);expect(calls).toBe(2);expect(result.patch).toEqual({});expect(result.error).toContain('validation');
 });

 it('persists usage and unfinished reservations across ledger restarts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-ai-test-'));dirs.push(dir);const path=join(dir,'ai.sqlite');
  let ledger=new UsageLedger(path,2_000_000);const known=ledger.reserve('gpt-6-astra')!;ledger.settle(known,{inputTokens:1000,outputTokens:100});const pending=ledger.reserve('gpt-6-astra');expect(pending).toBeTruthy();ledger.close();
  ledger=new UsageLedger(path,2_000_000);expect(ledger.spentMicroUsd()).toBe(1_365_000);expect(ledger.reserve('gpt-6-astra')).toBeUndefined();ledger.close();
 });
});
