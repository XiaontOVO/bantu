import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { carryPlaceTarget } = await import(pathToFileURL(join(process.cwd(),'public/lib/plan-carry-target.js')).href);
const input = {baseDate:'2099-09-29',start:1860,duration:60,intervals:[{startMinutes:420,endMinutes:1020}]};

test('carried visits append after existing destination visits without changing those visits',()=>{
  const plan={id:'next',kind:'plan',localDate:'2099-09-30',revision:3,stops:[{stopId:'old',startMinutes:420,endMinutes:480}]};
  const before=structuredClone(plan), result=carryPlaceTarget({...input,plans:[plan]});
  assert.equal(result.start,1920);assert.equal(result.date,plan.localDate);
  assert.deepEqual(result.expected,{localDate:plan.localDate,planId:plan.id,expectedRevision:3});
  assert.deepEqual(plan,before);
});
test('a full destination day continues into an explicitly dated later day',()=>{
  const result=carryPlaceTarget({...input,plans:[{kind:'plan',localDate:'2099-09-30',stops:[{endMinutes:1020}]}]});
  assert.equal(result.date,'2099-10-01');assert.equal(result.dayOffset,2);assert.equal(result.start,3300);
  assert.equal(result.expected.planId,null);assert.equal(result.expected.expectedRevision,null);
});
test('skipped visits and schemes do not occupy a carried daily visit',()=>{
  const result=carryPlaceTarget({...input,plans:[{id:'next',kind:'plan',localDate:'2099-09-30',stops:[{status:'skipped',endMinutes:1020}]},
    {id:'scheme',kind:'scheme',localDate:'2099-09-30',stops:[{endMinutes:1020}]}]});
  assert.equal(result.start,1860);assert.equal(result.expected.expectedRevision,0);
});
test('carry planning rejects duplicate days and stays within usable reference opening intervals',()=>{
  assert.throws(()=>carryPlaceTarget({...input,plans:[{kind:'plan',localDate:'2099-09-30'},{kind:'plan',localDate:'2099-09-30'}]}),/多份日计划/);
  assert.throws(()=>carryPlaceTarget({...input,duration:700}),/开放时段排不下/);
  const result=carryPlaceTarget({...input,intervals:[{startMinutes:420,endMinutes:480},{startMinutes:600,endMinutes:720}],
    plans:[{id:'next',kind:'plan',localDate:'2099-09-30',stops:[{endMinutes:540}]}]});
  assert.equal(result.start,2040);
});
