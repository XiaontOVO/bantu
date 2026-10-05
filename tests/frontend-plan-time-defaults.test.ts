import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href);
const { state } = await load('public/lib/store.js');
const { previewStopTime, editStopTime } = await load('public/lib/snapshots.js');

function environment(run: (nodes: Record<string, any>) => void) {
  const prior = { trip: state.trip, timeEdit: state.timeEdit, clockReceivedAt: state.clockReceivedAt, document: globalThis.document };
  const nodes: Record<string, any> = {
    stopStart: { value: '08:00' }, stopDuration: { value: '15' }, stopDurationBtn: { textContent: '', addEventListener() {} },
    timeEditStatus: { textContent: '' }, timeEditPreview: { innerHTML: '' },
    sheet: { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, removeAttribute() {}, focus() {} },
    sheetBackdrop: { hidden: true },
  };
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null, querySelectorAll: () => [] } as unknown as Document;
  state.trip = { trip: { tripId: 'time-defaults', revision: 1, localDate: '2026-09-29' },
    snapshot: { localDate: '2026-09-29', timezone: 'Asia/Shanghai', stops: [{ stopId: 'a', status: 'planned', place: { name: '第一站' }, startMinutes: 600, endMinutes: 660, plannedDurationMinutes: 60 }],
      routeLegs: [{ fromStopId: 'origin', toStopId: 'a', transportMode: 'walking', durationMinutes: 30, bufferMinutes: 5 }], executionEvents: [] },
    clock: { now: '2026-09-29T04:00:00.000Z', travelDate: '2026-09-29' } };
  state.clockReceivedAt = performance.now();
  state.timeEdit = { tripId: 'time-defaults', revision: 1, stopId: 'a' };
  try { run(nodes); }
  finally { state.trip = prior.trip; state.timeEdit = prior.timeEdit; state.clockReceivedAt = prior.clockReceivedAt; globalThis.document = prior.document; }
}

test('opening an overdue trip time editor pre-fills a current valid departure', () => {
  environment(nodes => {
    editStopTime('a');
    assert.match(nodes.sheet.innerHTML, /id="stopStart"[^>]*value="12:00"/);
    assert.doesNotMatch(nodes.sheet.innerHTML, /value="09:25"/);
    assert.equal(state.trip.snapshot.stops[0].startMinutes, 600);
    assert.deepEqual(state.trip.snapshot.executionEvents, []);
  });
});

test('preview fits old departure and too-short duration and still requires confirmation without writing facts', () => {
  environment(nodes => {
    previewStopTime();
    assert.equal(nodes.stopStart.value, '12:00');
    assert.equal(nodes.stopDuration.value, '50');
    assert.equal(state.timeEdit.stop.travelStartMinutes, 720);
    assert.equal(state.timeEdit.stop.startMinutes, 755);
    assert.equal(state.timeEdit.stop.endMinutes, 770);
    assert.match(nodes.timeEditStatus.textContent, /已留出已有路线时间/);
    assert.match(nodes.timeEditPreview.innerHTML, /确认保存/);
    assert.equal(state.trip.snapshot.stops[0].startMinutes, 600);
    assert.deepEqual(state.trip.snapshot.executionEvents, []);
  });
});
