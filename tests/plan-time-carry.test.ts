import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PlanLibraryService, SavedPlanRevisionConflictError } from '../src/services/plan-library.js';
const { fitDatedPlanStopTime } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-time-carry.js')).href);
const visit = (id: string, start: number, duration = 60) => ({ stopId:id, status:'planned', place:{ placeId:'same-place', name:'同一个地点' },
  startMinutes:start, endMinutes:start + duration, plannedDurationMinutes:duration });
const day = () => ({ id:'source', kind:'plan', localDate:'2099-09-29', stops:[visit('a',540),visit('b',660)], routeLegs:[], plannedCharges:[] });
const destination = () => ({ id:'target', kind:'plan', localDate:'2099-09-30', revision:4, name:'次日原安排',
  stops:[{ ...visit('c',600,120),timeLocked:true },visit('d',840)], routeLegs:[] });

test('cross-day time fits after all destination visits and captures their revision without mutations', () => {
  const source=day(),target=destination(),before=structuredClone({source,target});
  const result=fitDatedPlanStopTime(source,'b',2070,60,[source,target]);
  assert.equal(result.start,2340);assert.equal(result.duration,60);
  assert.deepEqual(result.expectedCarryTargets,[{localDate:'2099-09-30',planId:'target',expectedRevision:4}]);
  assert.equal(result.destinations[0].stops[0].startMinutes,900);
  assert.deepEqual(result.destinations[0].existingStops,target.stops);
  assert.deepEqual({source,target},before);
});

test('new destination and repeated-place visits keep independent identities and one expected date', () => {
  const source={...day(),stops:[visit('a',540),visit('b',660),visit('again',750)]};
  const result=fitDatedPlanStopTime(source,'b',2070,90,[source]);
  assert.deepEqual(result.expectedCarryTargets,[{localDate:'2099-09-30',planId:null,expectedRevision:null}]);
  assert.deepEqual(result.destinations[0].stops.map((s: any)=>[s.stopId,s.startMinutes]),[['b',630],['again',720]]);
  assert.equal(result.adjusted.length,1);
});

test('full destination advances every affected visit and exposes all actual dates', () => {
  const source={...day(),stops:[visit('a',540),visit('b',660),visit('again',750)]};
  const target={...destination(),stops:[visit('full',0,1440)]};
  const later={...destination(),id:'later',localDate:'2099-10-01',stops:[visit('later-existing',420,120)]};
  const result=fitDatedPlanStopTime(source,'b',2070,90,[source,target,later]);
  assert.equal(result.start,3420);assert.equal(result.destinations[0].date,'2099-10-01');
  assert.deepEqual(result.destinations[0].stops.map((s: any)=>[s.stopId,s.startMinutes]),[['b',540],['again',630]]);
  assert.deepEqual(result.expectedCarryTargets,[{localDate:'2099-10-01',planId:'later',expectedRevision:4}]);
});

test('a fixed source successor prevents carrying over its window and actual source facts stay intact', () => {
  const facts={...visit('a',540),status:'completed',actualArrivalMinutes:540,actualCompletionMinutes:600};
  const source={...day(),stops:[facts,visit('b',660),{...visit('fixed',780),timeLocked:true}]};
  const result=fitDatedPlanStopTime(source,'b',2070,60,[source,destination()]);
  assert.equal(result.start,720);assert.equal(result.destinations.length,0);
  assert.deepEqual(result.stops[0],facts);assert.deepEqual(result.stops[2],source.stops[2]);
});

test('cross-day route references become unknown while same-day routes and unpaid costs stay valid', () => {
  const source={...day(),stops:[visit('a',540),visit('b',660),visit('again',750)],routeLegs:[
    {legId:'cross',fromStopId:'a',toStopId:'b',transportMode:'walking',durationMinutes:30},
    {legId:'same',fromStopId:'b',toStopId:'again',transportMode:'walking',durationMinutes:20}],
    plannedCharges:[{chargeId:'estimate',routeLegRef:'cross',paymentStatus:'unpaid'}]};
  const result=fitDatedPlanStopTime(source,'b',2070,60,[source,destination()]);
  assert.deepEqual(result.routeLegs.map((r: any)=>r.legId),['same']);
  assert.deepEqual(result.plannedCharges,[]);
  assert.equal(result.destinations[0].stops[1].startMinutes,980);
  assert.equal(source.plannedCharges.length,1);
});

test('previous-day origin routes do not follow moved visits, paid or unchecked route charges require review', () => {
  for(const paymentStatus of ['paid',undefined]){
    const source={...day(),routeLegs:[{legId:'origin',fromStopId:'origin',toStopId:'b'}],
      plannedCharges:[{chargeId:'protected',routeLegRef:'origin',paymentStatus}]};
    assert.throws(()=>fitDatedPlanStopTime(source,'b',2070,60,[source,destination()]),/交通费用/);
  }
  const source={...day(),routeLegs:[{legId:'origin',fromStopId:'origin',toStopId:'b'}]};
  assert.deepEqual(fitDatedPlanStopTime(source,'b',2070,60,[source,destination()]).routeLegs,[]);
});

test('time preview commits exactly its independent destinations through the actual plan service', () => {
  const library=new PlanLibraryService(()=> '2099-09-29T00:00:00Z');
  const source=library.save('owner',{...day(),name:'原日',snapshot:day()});
  const target=library.save('owner',{...destination(),snapshot:destination()});
  const originalTarget=structuredClone(target);
  const result=fitDatedPlanStopTime(source,'b',2070,60,library.list('owner'));
  library.update('owner',source.id,{name:source.name,localDate:source.localDate,expectedRevision:source.revision||0,
    expectedCarryTargets:result.expectedCarryTargets,snapshot:{stops:result.stops,routeLegs:result.routeLegs,plannedCharges:result.plannedCharges}});
  const after=library.get('owner',target.id);
  assert.equal((after.stops.find((s:any)=>s.stopId==='b') as any).startMinutes,900);
  assert.deepEqual(after.stops.filter((s:any)=>s.stopId!=='b'),originalTarget.stops);
  assert.equal(after.executionEvents?.length||0,0);assert.equal(library.get('owner',source.id).stops.length,1);
});

test('time preview destination revision rejection keeps both dates and the original facts byte-for-byte', () => {
  const library=new PlanLibraryService(()=> '2099-09-29T00:00:00Z');
  const source=library.save('owner',{...day(),name:'原日',snapshot:day()});
  const target=library.save('owner',{...destination(),snapshot:destination()});
  const result=fitDatedPlanStopTime(source,'b',2070,60,library.list('owner'));
  library.update('owner',target.id,{name:'另一页',expectedRevision:target.revision||0,
    snapshot:{stops:target.stops,routeLegs:target.routeLegs,plannedCharges:target.plannedCharges}});
  const before=library.serialize();
  assert.throws(()=>library.update('owner',source.id,{name:source.name,expectedRevision:source.revision||0,
    expectedCarryTargets:result.expectedCarryTargets,snapshot:{stops:result.stops,routeLegs:result.routeLegs,plannedCharges:result.plannedCharges}}),SavedPlanRevisionConflictError);
  assert.deepEqual(library.serialize(),before);
});
