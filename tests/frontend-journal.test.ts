import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const journalPromise = import(pathToFileURL(join(process.cwd(), 'public/lib/travel-journal.js')).href) as Promise<Record<string, any>>;
const memoriesViewPromise = import(pathToFileURL(join(process.cwd(), 'public/views/memories.js')).href) as Promise<Record<string, any>>;
const storePromise = import(pathToFileURL(join(process.cwd(), 'public/lib/store.js')).href) as Promise<Record<string, any>>;

test('day journal drafts keep the legacy key on the trip start date and split later dates', async () => {
  const journal = await journalPromise;

  assert.equal(journal.dayJournalDraftId('trip-1', '2026-09-20', '2026-09-20'), 'trip-1');
  assert.equal(journal.dayJournalDraftId('trip-1', '2026-09-21', '2026-09-20'), 'trip-1:2026-09-21');
});

test('date-pending trips use the service timezone date for journal title and legacy draft key', async () => {
  const journal = await journalPromise;
  const trip = {
    trip: { tripId: 'trip-pending' },
    snapshot: {
      stops: [
        { stopId: 'completed-today', status: 'completed', place: { name: '今日已完成' } },
        { stopId: 'planned-later', date: '2026-09-21', status: 'planned', place: { name: '未来计划' } },
      ],
    },
    clock: { date: '2026-09-20', timezone: 'Asia/Shanghai' },
  };

  const { tripStartDate, journalDate } = journal.dayJournalDates(trip, '');
  assert.equal(tripStartDate, '2026-09-20');
  assert.equal(journalDate, '2026-09-20');
  assert.equal(journal.dayJournalDraftId('trip-pending', journalDate, tripStartDate), 'trip-pending');
  const text = journal.initialDayJournalText(trip, journalDate);
  assert.match(text, /^2026-09-20 旅行感想/);
  assert.match(text, /今日已完成/);
  assert.doesNotMatch(text, /未来计划/);
});

test('day journal starter text includes only completed stops for the viewed date', async () => {
  const journal = await journalPromise;
  const trip = {
    trip: { localDate: '2026-09-20' },
    snapshot: {
      travelDate: '2026-09-20',
      stops: [
        { stopId: 'legacy-completed', status: 'completed', place: { name: '起始日旧站点' } },
        { stopId: 'other-day-completed', date: '2026-09-21', status: 'completed', place: { name: '次日已完成站点' } },
        { stopId: 'future-planned', date: '2026-09-21', status: 'planned', place: { name: '次日计划站点' } },
      ],
    },
  };

  const nextDayText = journal.initialDayJournalText(trip, '2026-09-21');
  assert.match(nextDayText, /2026-09-21 旅行感想/);
  assert.match(nextDayText, /次日已完成站点/);
  assert.doesNotMatch(nextDayText, /起始日旧站点|次日计划站点/);

  const startDayText = journal.initialDayJournalText(trip, '2026-09-20');
  assert.match(startDayText, /起始日旧站点/);
  assert.doesNotMatch(startDayText, /次日已完成站点|次日计划站点/);
});

test('freeform memory save time is shown in the source trip timezone', async () => {
  const [view, storeModule] = await Promise.all([memoriesViewPromise, storePromise]);
  const state = storeModule.state;
  const previous = { trips: state.trips, memories: state.memories, trip: state.trip, loadStatus: state.loadStatus };
  const createdAt = '2026-09-20T18:30:00.000Z';
  const expected = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(createdAt));
  try {
    state.trips = [{ tripId: 'trip-paris', cityCode: '75000', timezone: 'Europe/Paris', localDate: '2026-09-20' }];
    state.memories = [{
      tripId: 'trip-paris', memoryId: 'note-paris', type: 'note', userText: '巴黎的一天\n走了很久。',
      createdAt, updatedAt: createdAt, staleAt: null,
    }];
    state.trip = null;
    state.loadStatus = {};
    assert.ok(view.renderMemories().includes(expected));
  } finally {
    Object.assign(state, previous);
  }
});
