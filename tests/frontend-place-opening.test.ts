import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href) as Promise<Record<string, any>>;
const { placeOpeningInfo, refreshPlaceOpeningLabel } = await load('public/lib/place-opening.js');
const at = (time: string) => new Date(`2026-09-29T${time}:00+08:00`);

test('reference opening hours use inclusive start and exclusive end without claiming a live status', () => {
  const hours = [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }];
  assert.equal(placeOpeningInfo(hours, at('08:59')).within, false);
  assert.equal(placeOpeningInfo(hours, at('09:00')).label, '参考时段内');
  assert.equal(placeOpeningInfo(hours, at('16:59')).within, true);
  assert.equal(placeOpeningInfo(hours, at('17:00')).label, '参考时段外');
  assert.equal(placeOpeningInfo(hours, new Date('2026-09-29T01:00:00Z')).within, true, 'comparison uses Shanghai time, not device-local hours');
});

test('overnight reference hours support both wrapped and extended minute representations', () => {
  for (const endMinutes of [120, 1560]) {
    const hours = [{ startMinutes: 22 * 60, endMinutes }];
    assert.equal(placeOpeningInfo(hours, at('22:00')).within, true);
    assert.equal(placeOpeningInfo(hours, at('01:59')).within, true);
    assert.equal(placeOpeningInfo(hours, at('02:00')).within, false);
    assert.equal(placeOpeningInfo(hours, at('21:59')).within, false);
    assert.equal(placeOpeningInfo(hours, at('23:00')).hours, '22:00 - 次日 02:00');
  }
});

test('daily multiple intervals preserve breaks and a full-day reference remains explicitly a reference', () => {
  const hours = [{ startMinutes: 540, endMinutes: 720 }, { startMinutes: 780, endMinutes: 1020 }];
  assert.equal(placeOpeningInfo(hours, at('12:30')).within, false);
  assert.equal(placeOpeningInfo(hours, at('13:00')).within, true);
  for (const time of ['00:00', '23:59']) {
    assert.deepEqual(placeOpeningInfo([{ startMinutes: 0, endMinutes: 1440 }], at(time)), {
      label: '全天时段 · 参考', within: true, hours: '全天',
    });
  }
});

test('missing or malformed opening records remain unknown rather than closed or open', () => {
  for (const hours of [undefined, [], '09:00-17:00', [null], [{ startMinutes: 0, endMinutes: 0 }],
    [{ startMinutes: -1, endMinutes: 60 }], [{ startMinutes: 1440, endMinutes: 1500 }],
    [{ startMinutes: 60, endMinutes: 2880 }], [{ startMinutes: '540', endMinutes: 1020 }]]) {
    assert.deepEqual(placeOpeningInfo(hours, at('10:00')), {
      label: '开放时间待核实', within: null, hours: '暂无可靠时段资料',
    });
  }
});

test('clock refresh crosses reference boundaries by updating only the status label', () => {
  const previous = globalThis.document;
  const classes = new Set<string>();
  const label = { textContent: '', dataset: { openingIntervals: '[{"startMinutes":540,"endMinutes":1020}]' },
    classList: { toggle(name: string, on: boolean) { on ? classes.add(name) : classes.delete(name); } } };
  globalThis.document = { getElementById: (id: string) => id === 'placeOpeningStatus' ? label : null } as unknown as Document;
  try {
    refreshPlaceOpeningLabel(at('16:59'));
    assert.equal(label.textContent, '参考时段内'); assert.equal(classes.has('green'), true);
    refreshPlaceOpeningLabel(at('17:00'));
    assert.equal(label.textContent, '参考时段外'); assert.equal(classes.has('green'), false);
    label.dataset.openingIntervals = 'invalid';
    refreshPlaceOpeningLabel(at('17:01'));
    assert.equal(label.textContent, '开放时间待核实'); assert.equal(classes.has('gray'), true);
  } finally { globalThis.document = previous; }
});

test('place details expose unknown opening information and a visible reference explanation', async () => {
  const { state } = await load('public/lib/store.js');
  const { renderPlace } = await load('public/views/place.js');
  const previous = { ...state };
  try {
    Object.assign(state, { placeDetailId: 'reference-place', places: [{ placeId: 'reference-place', name: '资料待补地点',
      category: 'landmark', openingIntervals: [], facilityCodes: [], reviews: [] }], favorites: [],
      savedPlans: [], community: [], communityMine: { places: [] }, myPlaceNotes: { 'reference-place': '' } });
    const html = renderPlace();
    assert.match(html, /开放时间待核实/);
    assert.match(html, /时段仅供参考，休馆日与临时调整请行前核实/);
    assert.match(html, /参考开放时段/);
    assert.doesNotMatch(html, /已闭馆|营业中/);
  } finally { Object.assign(state, previous); }
});
