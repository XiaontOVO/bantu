import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

test('home keeps the Chinese footprint flip card without the English heading', async () => {
  const [home, storeModule] = await Promise.all([load('public/views/home.js'), load('public/lib/store.js')]);
  const { state } = storeModule;
  const previous = { homeFootprintOpen: state.homeFootprintOpen, footprintWeekStart: state.footprintWeekStart };
  try {
    state.homeFootprintOpen = false;
    state.footprintWeekStart = '';
    const html = home.renderHome();
    assert.match(html, /class="hero-card home-hero"/);
    assert.match(html, /class="quick-grid home-shortcuts"/);
    assert.match(html, /旅行足迹/);
    assert.match(html, /data-action="toggle-home-footprint"/);
    assert.match(html, /data-action="step-footprint-week"/);
    assert.doesNotMatch(html, /travel journal/i);
  } finally {
    Object.assign(state, previous);
  }
});

test('footprint calendar counts dated memories and keeps the week within today', async () => {
  const [home, storeModule] = await Promise.all([load('public/views/home.js'), load('public/lib/store.js')]);
  const { state } = storeModule;
  const previous = { memories: state.memories, homeFootprintOpen: state.homeFootprintOpen, footprintWeekStart: state.footprintWeekStart };
  try {
    state.homeFootprintOpen = true;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const today = `${values.year}-${values.month}-${values.day}`;
    const monday = new Date(`${today}T00:00:00.000Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const weekStart = monday.toISOString().slice(0, 10);
    const memoryDate = new Date(monday);
    memoryDate.setUTCDate(memoryDate.getUTCDate() + 1);
    const tuesday = memoryDate.toISOString().slice(0, 10);
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const weekEnd = sunday.toISOString().slice(0, 10);
    state.footprintWeekStart = weekStart;
    state.memories = [
      { memoryId: 'note-1', localDate: tuesday, userText: '周二记下的片段', createdAt: `${tuesday}T02:00:00.000Z` },
      { memoryId: 'note-2', journey: { localDate: tuesday, timezone: 'Asia/Shanghai' }, userText: '当天走过的路', createdAt: `${tuesday}T02:00:00.000Z` },
    ];
    const html = home.renderHome();
    const label = `${weekStart.slice(5).replace('-', '.')} — ${weekEnd.slice(5).replace('-', '.')}`;
    assert.ok(html.includes(label));
    assert.match(html, /<strong>1<\/strong> 天有记录/);
    assert.match(html, /共 <strong>2<\/strong> 条/);
    home.stepFootprintWeek('next');
    assert.equal(state.footprintWeekStart, weekStart);
    home.stepFootprintWeek('previous');
    const previousMonday = new Date(monday);
    previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
    assert.equal(state.footprintWeekStart, previousMonday.toISOString().slice(0, 10));
  } finally {
    Object.assign(state, previous);
  }
});

test('footprint state, actions, and responsive calendar styles are wired', async () => {
  const [store, actions, css] = await Promise.all([
    readFile(join(process.cwd(), 'public/lib/store.js'), 'utf8'),
    readFile(join(process.cwd(), 'public/lib/actions.js'), 'utf8'),
    readFile(join(process.cwd(), 'public/styles.css'), 'utf8'),
  ]);

  assert.match(store, /homeFootprintOpen/);
  assert.match(store, /footprintWeekStart/);
  assert.match(actions, /'toggle-home-footprint'/);
  assert.match(actions, /'step-footprint-week'/);
  assert.match(css, /\.home-impression\s*\{/);
  assert.match(css, /\.footprint-calendar\s*\{/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.home-hero\s*\{/);
});
