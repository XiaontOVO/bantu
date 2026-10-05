import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { postPlaceResults } from '../public/lib/post-place-results.js';
import { placeCard } from '../public/lib/components.js';

test('post association finds catalog matches missing from provider pages and preserves canonical snapshots', () => {
  const catalog = [{ placeId: 'wukang', name: '武康大楼', provider: 'catalog' }];
  const external = [{ placeId: 'other-city', name: '武康私营城' }, { placeId: 'wukang', name: '错误供应商名称' }];
  const result = postPlaceResults(catalog, external, '武 康');
  assert.deepEqual(result.places.map(p => p.placeId), ['wukang', 'other-city']);
  assert.equal(result.places[0].name, '武康大楼');
  assert.deepEqual([...result.catalogIds], ['wukang']);
  assert.deepEqual(postPlaceResults(catalog, external, '不存在').places, external);
});

test('supplier cards hide unknown placeholders and planning defaults but retain actual data', () => {
  const card = placeCard({ placeId: 'amap_test', name: '地图咖啡店', provider: 'amap', tags: [], suggestedDurationMinutes: 60 });
  assert.ok(card.includes('地图地点'));
  assert.doesNotMatch(card, /暂无介绍|暂未添加标签|约 60 分钟|暂无资料/);
  const known = placeCard({ placeId: 'catalog_test', name: '已收录地点', suggestedDurationMinutes: 90, description: '真实介绍', costEstimate: { currency: 'CNY', lowerMinor: 0, upperMinor: 0 } });
  assert.ok(known.includes('约 90 分钟') && known.includes('真实介绍') && known.includes('免费'));
});

test('abort retains facts and exposes only this departure’s pending carried visits after reload; daytime preview is explicit', () => {
  const now = () => '2099-09-29T23:20:00+08:00';
  let library = new PlanLibraryService(now);
  const visit = (id: string, start: number) => ({ stopId: id, place: { placeId: id, name: id }, status: 'planned', startMinutes: start, endMinutes: start + 60 });
  const source = library.save('owner', { kind: 'plan', name: '夜间', localDate: '2099-09-29', snapshot: { stops: [visit('a', 720), visit('b', 840), visit('c', 960)], routeLegs: [], plannedCharges: [] } });
  library.save('someone-else', { kind: 'plan', name: '别人的计划', localDate: '2099-09-30', snapshot: { stops: [visit('b', 100)], routeLegs: [], plannedCharges: [] } });
  const departed = library.recordExecution('owner', source.id, { stopId: 'a', type: 'depart', occurredAt: now(), expectedRevision: 0, estimatedTravelMinutes: 313 });
  assert.equal(departed.migratedNextDayStops, 2);
  assert.equal(departed.departureCarry, undefined, 'internal metadata is not exposed');
  const serialized = library.serialize(); library = new PlanLibraryService(now); library.loadSerialized(serialized);
  const aborted = library.recordExecution('owner', source.id, { stopId: 'a', type: 'abort', occurredAt: now(), expectedRevision: departed.revision });
  assert.equal(aborted.interruptedArrangements?.length, 1);
  const affected = aborted.interruptedArrangements![0];
  assert.deepEqual(affected.names, ['b', 'c']);
  assert.equal(affected.canMoveToDaytime, true);
  assert.equal(affected.localDate, '2099-09-30');
  assert.deepEqual(aborted.executionEvents?.map(e => e.type), ['depart', 'abort']);
  const before = library.serialize();
  const continued = new PlanLibraryService(now); continued.loadSerialized(before);
  const repeated = continued.recordExecution('owner', source.id, { stopId: 'a', type: 'depart', occurredAt: now(), expectedRevision: aborted.revision, estimatedTravelMinutes: 313 });
  const repeatedAbort = continued.recordExecution('owner', source.id, { stopId: 'a', type: 'abort', occurredAt: now(), expectedRevision: repeated.revision });
  assert.equal(repeatedAbort.interruptedArrangements?.[0].planId, affected.planId, 'repeat departure retains earlier migration linkage');
  const locked = continued.get('owner', affected.planId);
  (locked.stops as any[]).forEach(stop => { stop.timeLocked = true; });
  const third = continued.recordExecution('owner', source.id, { stopId: 'a', type: 'depart', occurredAt: now(), expectedRevision: repeatedAbort.revision, estimatedTravelMinutes: 313 });
  const lockedAbort = continued.recordExecution('owner', source.id, { stopId: 'a', type: 'abort', occurredAt: now(), expectedRevision: third.revision });
  assert.equal(lockedAbort.interruptedArrangements?.[0].canMoveToDaytime, false, 'later appointments cannot be silently moved');
  const target = library.get('owner', affected.planId);
  const preview = library.previewDaytime('owner', affected.planId, { stopId: affected.stopId, firstDate: affected.localDate, expectedRevision: target.revision });
  assert.equal(library.serialize(), before, 'preview and cancellation cannot rewrite facts or dates');
  assert.ok(preview.destinations.every(day => day.stops.every(stop => stop.startMinutes! >= 540)));
  library.applyDaytime('owner', affected.planId, { stopId: affected.stopId, firstDate: affected.localDate, expectedRevision: target.revision, previewKey: preview.previewKey });
  assert.deepEqual(library.get('owner', source.id).executionEvents?.map(e => e.type), ['depart', 'abort']);
  assert.ok((library.get('owner', affected.planId).stops as any[]).every(stop => stop.startMinutes >= 540));
  const retry = library.recordExecution('owner', source.id, { stopId: 'a', type: 'depart', occurredAt: now(), expectedRevision: aborted.revision, estimatedTravelMinutes: 313 });
  const again = library.recordExecution('owner', source.id, { stopId: 'a', type: 'abort', occurredAt: now(), expectedRevision: retry.revision });
  assert.deepEqual(again.interruptedArrangements, [], 'already adjusted daytime visits should not prompt again');
});
