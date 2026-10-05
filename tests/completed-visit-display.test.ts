import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { completedVisitLabel } = await import(pathToFileURL(join(process.cwd(), 'public/lib/itinerary-timing.js')).href);
const { timelineItem } = await import(pathToFileURL(join(process.cwd(), 'public/lib/components.js')).href);
const stop = { stopId: 's', status: 'completed', startMinutes: 720, endMinutes: 780, plannedDurationMinutes: 60 };
const event = (id: string, type: string, time: string, extra = {}) => ({ executionEventId: id, stopId: 's', type, occurredAt: time, recordedAt: time, ...extra });

test('completed card uses actual arrival/completion, not the planned duration', () => {
  const snapshot = { stops: [stop], localDate: '2026-09-23', executionEvents: [event('a', 'arrive', '2026-09-23T12:07:00+08:00'), event('c', 'complete', '2026-09-23T12:19:00+08:00')] };
  assert.equal(completedVisitLabel(stop, snapshot), '12:07 - 12:19 · 12 分钟');
  const html = timelineItem(stop, 0, 'progress', 'dated', 'plan', snapshot.executionEvents, snapshot);
  assert.ok(html.includes('12:07 - 12:19 · 12 分钟'));
  assert.ok(!html.includes('60 分钟'));
});

test('completed visit excludes corrected events and preserves cross-midnight elapsed time', () => {
  const snapshot = { localDate: '2026-09-23', executionEvents: [
    event('a', 'arrive', '2026-09-23T23:50:00+08:00'),
    event('c', 'complete', '2026-09-24T00:05:00+08:00'),
    event('fix', 'complete', '2026-09-24T00:10:00+08:00', { correctsEventId: 'c' }),
  ] };
  const label = completedVisitLabel(stop, snapshot);
  assert.match(label, /23:50/);
  assert.match(label, /00:10/);
  assert.match(label, /20 分钟/);
  assert.doesNotMatch(label, /00:05/);
});

test('missing arrival, corrected status and sub-minute visits never use planned duration', () => {
  assert.match(completedVisitLabel(stop, { executionEvents: [event('c', 'complete', '2026-09-23T12:19:00+08:00')] }), /12:19 完成 · 到达时间未记录/);
  assert.equal(completedVisitLabel(stop, {}), '实际完成时间未记录');
  const events = [event('a', 'arrive', '2026-09-23T12:18:40+08:00'), event('c', 'complete', '2026-09-23T12:19:00+08:00')];
  assert.match(completedVisitLabel(stop, { executionEvents: events }), /不足 1 分钟/);
  events.push(event('fix', 'complete', '2026-09-23T12:20:00+08:00', { correctsEventId: 'c', statusOverride: 'visiting' }));
  assert.equal(completedVisitLabel(stop, { executionEvents: events }), '实际完成时间未记录');
  events.push(event('done', 'complete', '2026-09-23T12:28:40+08:00'));
  assert.match(completedVisitLabel(stop, { executionEvents: events }), /10 分钟/);
});
