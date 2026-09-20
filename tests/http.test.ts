import {describe,it,expect} from 'vitest';
import {cleanPatch} from '../server/domain';
describe('request boundary',()=>{
 it('rejects invalid money and attendance instead of coercing them',()=>{
  expect(()=>cleanPatch({attendance:0})).toThrow();
  expect(()=>cleanPatch({venueCostCents:1.2})).toThrow();
  expect(()=>cleanPatch({staffCount:-2})).toThrow();
 });
 it('does not accept a model asserting an external booking confirmation',()=>{
  expect(cleanPatch({cateringStatus:'confirmed'})).toEqual({});
 });
});
