import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { PlanLibraryService, SavedPlanRevisionConflictError } from '../src/services/plan-library.js';
const stop = { stopId: 'a', placeId: 'a', place: { placeId: 'a', name: '原地点' }, startMinutes: 600, endMinutes: 660 };

test('carried additions reject stale destination expectations before changing either day',()=>{
  for (const destinationExists of [true,false]) {
    const library=new PlanLibraryService(()=> '2026-09-28T00:00:00Z');
    const source=library.save('owner',{kind:'plan',name:'当天',localDate:'2026-09-28',snapshot:{stops:[stop],routeLegs:[]}});
    const next=library.save('owner',{kind:'plan',name:'次日',localDate:'2026-09-29',snapshot:{stops:[{...stop,stopId:'next'}],routeLegs:[]}});
    const expected={localDate:next.localDate,planId:destinationExists?next.id:null,expectedRevision:destinationExists?0:null};
    if(destinationExists)library.update('owner',next.id,{name:'另一页的新名称',expectedRevision:0,snapshot:{stops:next.stops,routeLegs:[]}});
    const before=structuredClone(library.list('owner'));
    assert.throws(()=>library.update('owner',source.id,{name:source.name,expectedRevision:0,expectedCarryTargets:[expected],
      snapshot:{stops:[stop,{...stop,stopId:'added',startMinutes:2100,endMinutes:2160}],routeLegs:[]}}),SavedPlanRevisionConflictError);
    assert.deepEqual(library.list('owner'),before);
  }
});
test('valid carry expectations preserve the destination name and visits and commit the previewed time',()=>{
  const library=new PlanLibraryService(()=> '2026-09-28T00:00:00Z');
  const source=library.save('owner',{kind:'plan',name:'当天',localDate:'2026-09-28',snapshot:{stops:[stop],routeLegs:[]}});
  const next=library.save('owner',{kind:'plan',name:'次日的预约',localDate:'2026-09-29',snapshot:{stops:[{...stop,stopId:'next'}],routeLegs:[]}});
  delete next.revision; // Legacy persisted plans use revision zero when absent.
  library.update('owner',source.id,{name:source.name,expectedRevision:0,
    expectedCarryTargets:[{localDate:next.localDate,planId:next.id,expectedRevision:0}],
    snapshot:{stops:[stop,{...stop,stopId:'added',startMinutes:2100,endMinutes:2160}],routeLegs:[]}});
  const after=library.get('owner',next.id);
  assert.equal(after.name,'次日的预约');assert.equal(after.stops.length,2);
  assert.equal((after.stops[1] as any).startMinutes,660);assert.equal((after.stops[0] as any).startMinutes,600);
  assert.equal(library.get('owner',source.id).stops.length,1);assert.equal(after.executionEvents?.length||0,0);
});
test('new source creation rejects changed carry targets and validates expectation fields before writing',()=>{
  const library=new PlanLibraryService(()=> '2026-09-28T00:00:00Z');
  const next=library.save('owner',{kind:'plan',name:'次日',localDate:'2026-09-29',snapshot:{stops:[stop],routeLegs:[]}});
  const body={kind:'plan',name:'当天',localDate:'2026-09-28',snapshot:{stops:[{...stop,startMinutes:2100,endMinutes:2160}],routeLegs:[]}};
  assert.throws(()=>library.save('owner',{...body,expectedCarryTargets:[{localDate:next.localDate,planId:null,expectedRevision:null}]}),SavedPlanRevisionConflictError);
  for(const expected of [{localDate:next.localDate,planId:next.id,expectedRevision:-1},{localDate:'invalid',planId:null,expectedRevision:null}]) {
    assert.throws(()=>library.save('owner',{...body,expectedCarryTargets:[expected]}),/确认资料无效/);
  }
  assert.equal(library.list('owner').length,1);
});

test('saved plan updates enforce a supplied content revision for schemes and dated plans', () => {
  const library = new PlanLibraryService(() => '2026-09-28T00:00:00Z');
  for (const kind of ['scheme', 'plan'] as const) {
    const saved = library.save('owner', { kind, name: kind, localDate: '2026-09-29', ...(kind === 'scheme' ? { days: [{ dayIndex: 0, stops: [stop], routeLegs: [] }] } : { snapshot: { stops: [stop], routeLegs: [] } }) });
    const body = kind === 'scheme' ? { days: saved.days } : { snapshot: { stops: saved.stops, routeLegs: [] } };
    const updated = library.update('owner', saved.id, { name: `${kind}-新`, expectedRevision: 0, ...body });
    assert.equal(updated.revision, 1);
    const before = library.serialize();
    assert.throws(() => library.update('owner', saved.id, { name: `${kind}-旧`, expectedRevision: 0, ...body }), SavedPlanRevisionConflictError);
    assert.deepEqual(library.serialize(), before, 'conflicting update has no mutations');
    for (const expectedRevision of [-1, 0.5, '1', null]) assert.throws(() => library.update('owner', saved.id, { name: kind, expectedRevision, ...body }), /非负整数/);
  }
});

test('HTTP rejects a stale day-plan update with 409 and preserves newer content and execution events', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-28T12:00:00+08:00' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: any) => {
      const result = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: result.status, ...await result.json() as any };
    };
    const created = await call('/api/v1/plans', 'POST', { name: '原计划', kind: 'plan', localDate: '2026-09-28', snapshot: { stops: [stop], routeLegs: [] } });
    const path = `/api/v1/plans/${created.data.id}`;
    const event = await call(path + '/execution-events', 'POST', { stopId: 'a', type: 'complete', occurredAt: '2026-09-28T11:00:00+08:00', expectedRevision: 0 });
    assert.equal(event.status, 200);
    const stale = await call(path, 'PUT', { name: '不该覆盖', expectedRevision: 0, snapshot: { stops: [] } });
    assert.equal(stale.status, 409); assert.equal(stale.error.code, 'REVISION_CONFLICT');
    const listed = await call('/api/v1/plans');
    const current = listed.data.find((plan: any) => plan.id === created.data.id);
    assert.equal(current.name, '原计划'); assert.equal(current.executionEvents.length, 1);
    const good = await call(path, 'PUT', { name: '核对后的名称', expectedRevision: current.revision, snapshot: { stops: current.stops, routeLegs: [] } });
    assert.equal(good.status, 200); assert.equal(good.data.executionEvents.length, 1);
    const invalid = await call(path, 'PUT', { name: '无效版本', expectedRevision: '2' });
    assert.equal(invalid.status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
