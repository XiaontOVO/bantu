import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const {itineraryTiming} = await import(pathToFileURL(join(process.cwd(),'public/lib/itinerary-timing.js')).href);
const {itineraryTimeLabel} = await import(pathToFileURL(join(process.cwd(),'public/lib/itinerary-timing.js')).href);
const {formatTimeRange} = await import(pathToFileURL(join(process.cwd(),'public/lib/format.js')).href);

test('overnight actual arrival retains its original plan day offset and timezone',()=>{
 const stop={stopId:'night',status:'visiting',startMinutes:1445,endMinutes:1505};
 const timing=itineraryTiming(stop,{stops:[stop],localDate:'2026-09-28',timezone:'Asia/Shanghai',executionEvents:[
   {stopId:'night',type:'depart',occurredAt:'2026-09-28T23:50:00+08:00'},
   {stopId:'night',type:'arrive',occurredAt:'2026-09-29T00:05:00+08:00'},
 ]});
 assert.equal(timing.departure,1430);
 assert.equal(timing.arrival,1445);
});

test('time summaries use the supplied snapshot and distinguish unknown departure',()=>{
 const stop={stopId:'b',status:'planned',startMinutes:650,endMinutes:710,departureMinutes:710};
 const snapshot={stops:[stop],routeLegs:[]};
 assert.equal(itineraryTimeLabel(stop,snapshot),'10:50出发 - 11:50离开');
 assert.equal(itineraryTimeLabel({...stop,travelStartMinutes:620},snapshot),'10:50出发 - 11:50离开');
});

test('overnight schedules label the next day in ranges and itinerary summaries',()=>{
 const stop={stopId:'night',status:'planned',startMinutes:23*60+30,endMinutes:24*60+30,departureMinutes:24*60+30};
 assert.equal(formatTimeRange(stop.startMinutes,stop.endMinutes),'23:30 - 次日 00:30');
 assert.equal(itineraryTimeLabel(stop,{stops:[stop],routeLegs:[]}), '23:30出发 - 次日 00:30离开');
});

test('itinerary timeline spans travel and visit, excludes skipped origin, and reveals missing routes',()=>{
 const first={stopId:'a',status:'completed',startMinutes:540,endMinutes:600,departureMinutes:600};
 const skipped={stopId:'b',status:'skipped',startMinutes:610,endMinutes:700};
 const stop={stopId:'c',status:'planned',startMinutes:640,endMinutes:700};
 const snapshot={stops:[first,skipped,stop],routeLegs:[{fromStopId:'a',toStopId:'c',durationSeconds:1200,bufferMinutes:5,transportMode:'walking'}]};
 const timing=itineraryTiming(stop,snapshot);
 assert.equal(timing.departure,600); assert.equal(timing.arrival,625); assert.equal(timing.leave,700);
 assert.equal(timing.waiting,15); assert.equal(timing.overlap,false);
 assert.equal(itineraryTiming(first,{stops:[first],routeLegs:[]}).departure,540);
 assert.equal(itineraryTiming(first,{stops:[first],routeLegs:[]}).arrivalEstimated,true);
 assert.equal(itineraryTiming(stop,{...snapshot,routeLegs:[]}).minutes,null);
 assert.equal(itineraryTiming({...stop,startMinutes:620},snapshot).overlap,true);
});

test('skipping the first stop invalidates its incoming route for the new first stop',()=>{
 const first={stopId:'a',status:'skipped',startMinutes:540,endMinutes:600};
 const next={stopId:'b',status:'planned',startMinutes:660,endMinutes:720};
 const oldLeg={fromStopId:'a',toStopId:'b',durationMinutes:30};
 const snapshot={stops:[first,next],routeLegs:[oldLeg]};
 const timing=itineraryTiming(next,snapshot);
 assert.equal(timing.minutes,null);
 assert.equal(timing.departure,660);
 assert.equal(timing.arrival,660);
 assert.equal(timing.arrivalEstimated,true);
 const external=itineraryTiming(next,{...snapshot,routeLegs:[{...oldLeg,fromStopId:'hotel'}]});
 assert.equal(external.departure,630);
 assert.equal(external.arrival,660);
});

test('invalid route timing never produces a plausible arrival time',()=>{
 const stop={stopId:'a',status:'planned',startMinutes:10,endMinutes:70};
 const base={fromStopId:'hotel',toStopId:'a',durationMinutes:30};
 const timing=itineraryTiming(stop,{stops:[stop],routeLegs:[base]});
 assert.equal(timing.departure,0);
 assert.equal(timing.arrival,30);
 assert.equal(timing.arrivalEstimated,false);
 for(const bufferMinutes of [-1,NaN,Infinity]) {
   const broken=itineraryTiming(stop,{stops:[stop],routeLegs:[{...base,bufferMinutes}]});
   assert.equal(broken.minutes,null);
   assert.equal(broken.arrival,10,'交通无效时到达按游览开始估计');
   assert.equal(broken.arrivalEstimated,true);
 }
 for(const bufferMinutes of [-1,NaN,Infinity]) {
   assert.equal(itineraryTiming(stop,{stops:[stop],routeLegs:[{...base,bufferMinutes}]}).minutes,null);
 }
});

test('an en-route stop uses its recorded actual departure instead of 待定',()=>{
 const stop={stopId:'a',status:'en_route',startMinutes:540,endMinutes:600,departureMinutes:600};
 const snapshot={stops:[stop],routeLegs:[],executionEvents:[
   {stopId:'a',type:'depart',occurredAt:'2026-09-18T01:12:00+08:00'},
 ]};
 const timing=itineraryTiming(stop,snapshot);
 assert.equal(timing.departure,72,'实际出发 01:12 = 72 分钟');
 assert.equal(timing.arrivalEstimated,true);
 assert.equal(itineraryTiming({...stop,status:'planned'},snapshot).departure,540,'未出发的站点仍按计划');
});

test('a fresh departure estimate and its selected mode override a stale planned route leg',()=>{
 const stop={stopId:'a',status:'en_route',startMinutes:540,endMinutes:600,departureMinutes:600,
   estimatedTravelMinutes:8,estimatedTransportMode:'driving'};
 const snapshot={stops:[stop],routeLegs:[{fromStopId:'hotel',toStopId:'a',durationMinutes:34,bufferMinutes:5,transportMode:'walking'}],executionEvents:[
   {stopId:'a',type:'depart',occurredAt:'2026-09-18T01:12:00+08:00'},
 ]};
 const timing=itineraryTiming(stop,snapshot);
 assert.equal(timing.minutes,8,'实际起点估算优先于计划中的旧路段');
 assert.equal(timing.mode,'driving','出发时选择的交通方式随 ETA 展示');
 const unknown=itineraryTiming({...stop,estimatedTravelMinutes:undefined,estimatedTransportMode:'driving'},snapshot);
 assert.equal(unknown.minutes,null,'没有成功路线估算时不能回退到过期的步行路段');
});

test('a visited stop shows the recorded arrival instead of the predicted 出发+时长',()=>{
 // 出发 09:50，路线预测 13 分钟 → 预测到达 10:03；用户 10:30 才点「到达」，
 // 到达时间必须显示 10:30（实际），不能停留在预测的 10:03。
 const stop={stopId:'a',status:'visiting',startMinutes:630,endMinutes:720,departureMinutes:720,plannedArrivalMinutes:630};
 const snapshot={stops:[stop],routeLegs:[{fromStopId:'hotel',toStopId:'a',durationMinutes:12,bufferMinutes:1,transportMode:'walking'}],executionEvents:[
   {stopId:'a',type:'depart',occurredAt:'2026-09-18T09:50:00+08:00'},
   {stopId:'a',type:'arrive',occurredAt:'2026-09-18T10:30:00+08:00'},
 ]};
 const timing=itineraryTiming(stop,snapshot);
 assert.equal(timing.departure,590,'出发用实际记录 09:50');
 assert.equal(timing.arrival,630,'到达用实际记录 10:30，而非预测的 10:03');
 assert.equal(timing.arrivalEstimated,false);
 // 还在途中（en_route）时保持「出发+时长」的预测到达
 const enroute=itineraryTiming({...stop,status:'en_route',startMinutes:603,plannedArrivalMinutes:603},snapshot);
 assert.equal(enroute.arrival,603,'en_route 仍按预测到达');
 assert.equal(itineraryTiming({...stop,executionEvents:[]},snapshot).arrival,630,'没有到达事件时回退到计划对齐值');
});

test('explicit departure remains separate from previous stop leaving and destination arrival',()=>{
 const previous={stopId:'a',status:'planned',startMinutes:540,endMinutes:600};
 const stop={stopId:'b',status:'planned',travelStartMinutes:620,startMinutes:650,endMinutes:710,departureMinutes:710};
 const timing=itineraryTiming(stop,{stops:[previous,stop],routeLegs:[{fromStopId:'a',toStopId:'b',durationMinutes:25,bufferMinutes:5}]});
 assert.equal(timing.departure,620);
 assert.equal(timing.arrival,650);
 assert.equal(timing.leave,710);
 assert.equal(previous.endMinutes,600);
 assert.equal(timing.departureConflict,false);
 assert.equal(itineraryTiming(stop,{stops:[{...previous,endMinutes:630},stop],routeLegs:[]}).departureConflict,true);
 const unknown=itineraryTiming(stop,{stops:[stop],routeLegs:[]});
 assert.equal(unknown.departure,620);
 assert.equal(unknown.arrival,650,'无交通时长时到达按游览开始估计');
 assert.equal(unknown.arrivalEstimated,true);
});
