import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { companionTarget, canViewPlanDate } = await load('public/lib/day-plan-selection.js');
const { state } = await load('public/lib/store.js');
const { renderCompanion } = await load('public/views/companion.js');
const { renderHome } = await load('public/views/home.js');
const { canonicalView, sectionNavigation, navigationGroup } = await load('public/lib/navigation.js');
const { companionRequestForText } = await load('public/lib/companion-advice.js');
const now = new Date('2026-09-28T03:00:00.000Z');
const plan = (id: string, date: string, statuses: string[]) => ({ id, kind: 'plan', name: id, localDate: date, timezone: 'Asia/Shanghai', revision: 2, stops: statuses.map((status, index) => ({ stopId: `${id}-${index}`, status, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, place: { placeId: `${id}-place-${index}`, name: index === 0 ? '徐家汇书院' : '上海公安博物馆' } })) });

test('随行追问可以自然回答，普通聊天和旧问题不能携带调整上下文', () => {
  const before = state.messages;
  try {
    state.messages = [{ role: 'assistant', messageId: 'rest-question', companionAdjustment: { status: 'needs_input', change: 'rest' } }];
    assert.deepEqual(companionRequestForText('我想休息半小时'), { action: 'preview', sourceMessageId: 'rest-question', minutes: 30 });
    assert.equal(companionRequestForText('查看今天的行程'), undefined);
    state.messages.push({ role: 'assistant', messageId: 'normal-reply', text: '今天的行程如下。' });
    assert.equal(companionRequestForText('休息 30 分钟'), undefined, 'a later ordinary conversation must not answer an old adjustment question');
    state.messages = [{ role: 'assistant', messageId: 'deadline-question', companionAdjustment: { status: 'needs_input', change: 'time' } }];
    assert.deepEqual(companionRequestForText('18:30 前结束'), { action: 'preview', sourceMessageId: 'deadline-question', deadlineMinutes: 1110 });
    state.messages = [{ role: 'assistant', messageId: 'preview', companionAdjustment: { status: 'preview', candidates: [{ title: '休息后继续', previewId: 'candidate-1' }] } }];
    assert.deepEqual(companionRequestForText('确认采用这份调整'), { action: 'apply', sourceMessageId: 'preview', previewId: 'candidate-1' });
    assert.deepEqual(companionRequestForText('保留原安排'), { action: 'cancel', sourceMessageId: 'preview' });
  } finally { state.messages = before; }
});

test('模型托管追问接受自然中文，取消和后续普通聊天保留正确上下文', () => {
  const before = state.messages;
  try {
    state.messages = [{ role: 'assistant', messageId: 'llm-question', companionDelegation: { status: 'needs_input', change: 'time' } }];
    assert.deepEqual(companionRequestForText('下午四点之前，帮我自动处理'), { action: 'delegate', sourceMessageId: 'llm-question' });
    assert.deepEqual(companionRequestForText('先不调整'), { action: 'cancel_delegate', sourceMessageId: 'llm-question' });
    state.messages.push({ role: 'assistant', messageId: 'completed', companionDelegation: { status: 'applied' } });
    assert.equal(companionRequestForText('查看我的笔记'), undefined);
  } finally { state.messages = before; }
});

test('随行优先全局旧进行中，不能被另一日选择覆盖', () => {
  const past = plan('old', '2026-09-25', ['completed', 'visiting']);
  const future = plan('future', '2026-09-30', ['planned']);
  const selected = companionTarget([future, past], future.id, now);
  assert.equal(selected.plan.id, past.id);
  assert.equal(selected.next.stopId, 'old-1');
  assert.equal(selected.phase, 'visit');
  assert.equal(selected.canExecute, true);
  assert.equal(canViewPlanDate(past.localDate, [past, future], now), true);
  assert.equal(canViewPlanDate('2026-09-24', [past, future], now), false);
});

test('随行保留原队列，不再次选择已完成和已跳过站点', () => {
  const today = plan('today', '2026-09-28', ['completed', 'skipped', 'planned', 'planned']);
  const before = JSON.stringify(today);
  const selected = companionTarget([today], '', now);
  assert.equal(selected.next.stopId, 'today-2');
  assert.equal(selected.phase, 'ready');
  assert.equal(JSON.stringify(today), before);
});

test('重复计划和多个活动阻断执行，未来安排只允许预览', () => {
  assert.equal(companionTarget([plan('a', '2026-09-28', ['planned']), plan('b', '2026-09-28', ['planned'])], '', now).phase, 'conflict');
  assert.equal(companionTarget([plan('a', '2026-09-27', ['en_route']), plan('b', '2026-09-28', ['visiting'])], '', now).phase, 'conflict');
  assert.equal(companionTarget([plan('future', '2026-09-30', ['planned'])], '', now).canExecute, false);
  assert.equal(canViewPlanDate('2026-02-30', [], now), false);
  assert.equal(canViewPlanDate('2027-02-29', [], now), false);
});

test('随行访馆展示场地及建筑入口，静态图不标示我的位置', () => {
  const backup = { ...state };
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const current = plan('visit', today, ['visiting', 'planned']);
    Object.assign(state, { savedPlans: [current], companionPlanId: current.id, places: [], companionFinishedPlan: null, companionContext: null, executionPending: null, companionError: '' });
    const html = renderCompanion();
    assert.match(html, /景点全貌/);
    assert.match(html, /data-action="open-building-plan"/);
    assert.match(html, /data-action="open-place-scene"/);
    assert.match(html, /进入场景/);
    assert.match(html, /结束游览/);
    assert.doesNotMatch(html, /我的位置/);
  } finally { Object.assign(state, backup); }
});

test('最后一站真实完成后显示结束与记忆，名称需转义', () => {
  const backup = { ...state };
  try {
    const finished = plan('<img onerror=x>', '2026-09-27', ['completed']);
    Object.assign(state, { savedPlans: [], companionFinishedPlan: finished, companionPlanId: finished.id });
    const html = renderCompanion();
    assert.match(html, /查看这次旅行记录/);
    assert.match(html,/data-action="open-journey-review"/);
    assert.match(html, /&lt;img onerror=x&gt;/);
    assert.doesNotMatch(html, /data-action="companion-exec"/);
  } finally { Object.assign(state, backup); }
});

test('首页保留主卡、翻面足迹和快捷入口，旅程一览直接按三态执行随行', () => {
  const backup = { ...state };
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    for (const [status, action] of [['planned', 'depart'], ['en_route', 'arrive'], ['visiting', 'complete']]) {
      const current = plan('home', today, [status, 'planned']);
      Object.assign(current, { name: '城市散步 · 上海半日 · 第 1 天', sourceDayIndex: 0 });
      Object.assign(state, { currentView: 'home', savedPlans: [current], companionPlanId: current.id, companionFinishedPlan: null, companionContext: null, executionPending: null, places: [], companionNotice: '', companionError: '' });
      const before = JSON.stringify(current);
      const html = renderHome();
      assert.match(html, new RegExp(`data-action="companion-exec"[^>]*data-type="${action}"`));
      assert.doesNotMatch(html, /data-action="open-companion"/);
      assert.match(html, /data-action="focus-home-companion"/);
      assert.match(html, /data-action="toggle-home-footprint"/);
      assert.match(html, /class="quick-grid home-shortcuts"/);
      assert.match(html, /<strong>城市散步 · 上海半日<\/strong>/);
      assert.match(html, /<time datetime="[^"]+">[^<]+<\/time><span class="companion-journey-day">第 1 天<\/span>/);
      assert.ok(html.indexOf('class="companion-journey"') < html.indexOf('card companion-now'), 'journey overview is outside the current-stop action card');
      assert.ok(html.indexOf('class="companion-journey"') < html.indexOf('class="companion-impression"'));
      assert.ok(html.indexOf('class="home-impression') < html.indexOf('home-shortcuts'));
      assert.ok(html.indexOf('home-shortcuts') < html.indexOf('id="homeCompanion"'));
      assert.ok(html.indexOf('id="homeCompanion"') < html.indexOf('home-inspiration'));
      assert.equal(JSON.stringify(current), before, 'rendering the landing page must not record or rearrange progress');
    }
    state.savedPlans = []; state.companionPlanId = '';
    const empty = renderHome();
    assert.match(empty, /从一份小计划开始/);
    assert.doesNotMatch(empty, /data-action="companion-exec"/);
  } finally { Object.assign(state, backup); }
});

test('旧随行地址归一到首页，行程只保留管理页，首页导航正确', () => {
  assert.equal(canonicalView('companion'), 'home');
  assert.equal(canonicalView('today'), 'today');
  assert.equal(navigationGroup('companion').entry, 'home');
  assert.equal(sectionNavigation('home'), '');
  assert.doesNotMatch(sectionNavigation('today'), /data-nav="companion"/);
  assert.match(sectionNavigation('today'), /计划与进度/);
  assert.match(sectionNavigation('today'), /地图与路线/);
});

test('首页保留实际出发时间，采用纠正后的事件，缺记录不用计划时间补造', () => {
  const backup = { ...state };
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const current = plan('clock', today, ['en_route']);
    Object.assign(current, { executionEvents: [
      { executionEventId: 'depart-original', stopId: 'clock-0', type: 'depart', occurredAt: `${today}T01:10:00.000Z` },
      { executionEventId: 'depart-corrected', stopId: 'clock-0', type: 'correction', statusOverride: 'en_route', correctsEventId: 'depart-original', occurredAt: `${today}T01:25:00.000Z` },
    ] });
    Object.assign(state, { savedPlans: [current], companionPlanId: current.id, companionFinishedPlan: null, companionContext: null, places: [], companionNotice: '', companionError: '' });
    const clock = () => renderHome().match(/class="companion-stage-time"[\s\S]*?<\/strong>/)?.[0] || '';
    assert.match(clock(), /出发时间/);
    assert.match(clock(), /09:25/);
    assert.doesNotMatch(clock(), /09:10|12:00/);
    Object.assign(current, { executionEvents: [] });
    assert.match(clock(), /时间未记录/);
    assert.doesNotMatch(clock(), /12:00/);
  } finally { Object.assign(state, backup); }
});
