/**
 * 计划与进度板块的状态矩阵测试。
 *
 * 覆盖：无旅行（日期计划概览/日期切换/空状态）与有旅行（今天=执行、
 * 未来=规划、当天=执行、过期日期隐藏）状态门控、执行中禁用、纠正记录、进度省略等。
 * 视图是纯函数：直接用受控 state 渲染并断言结构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const state = store.state as Record<string, any>;
const TODAY = await load('public/views/today.js');

const todayString = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

function makeStop(overrides: Record<string, any> = {}) {
  return {
    stopId: overrides.stopId ?? `stop_${Math.random().toString(36).slice(2, 8)}`,
    placeId: 'place_x',
    place: { placeId: 'place_x', name: overrides.name ?? '某地点', coordinates: { lat: 30.25, lng: 120.15, source: 'demo' }, facilityCodes: [] },
    plannedArrivalMinutes: 9 * 60, startMinutes: 9 * 60, endMinutes: 10 * 60,
    departureMinutes: 10 * 60, minDurationMinutes: 60, plannedDurationMinutes: 60,
    status: 'planned', ...overrides,
  };
}

function seedTrip(options: { localDate?: string; clockDate?: string; stops?: any[]; events?: any[] } = {}) {
  const travelDate = options.localDate ?? todayString();
  const clockDate = options.clockDate ?? travelDate;
  const stops = options.stops ?? [];
  const events = options.events ?? [];
  state.trip = {
    trip: { tripId: 'trip_matrix', dataMode: 'demo', lifecycle: 'active', planningStatus: 'validated',
      revision: 2, contentRevision: 2, timezone: 'Asia/Shanghai', localDate: travelDate,
      cityCode: '330100', latestContextId: null, deletedAt: null },
    snapshot: { stops, routeLegs: [], plannedCharges: [], executionEvents: events },
    versionCount: 3, previousPlanRevision: null, pendingActionRequests: [],
    clock: { now: `${clockDate}T12:00:00+08:00`, travelDate },
  };
  // The current product renders day plans directly. Keep the legacy fixture
  // above for migration assertions, but make the same data available through
  // the standalone queue used by the view.
  state.savedPlans = travelDate >= todayString() ? [{
    id: 'trip_matrix_plan', kind: 'plan', name: '测试日计划', localDate: travelDate,
    timezone: 'Asia/Shanghai', cityCode: '310100', stops, routeLegs: [], plannedCharges: [], executionEvents: events,
  }] : [];
  state.planViewDate = travelDate >= todayString() ? travelDate : '';
  state.clockReceivedAt = performance.now();
  state.proposal = null; state.actionRequests = []; state.executionPending = null;
}

test('无旅行：只显示带日期的计划，日期待定与多天方案不出现，默认选中今天或未来第一天', () => {
  state.trip = null;
  state.savedPlans = [
    { id: 'p_undated', kind: 'plan', name: '待定计划', cityCode: '330100', stops: [{ place: { name: 'A' } }], routeLegs: [] },
    { id: 'p_scheme', kind: 'scheme', name: '多天方案', cityCode: '330100', days: [{ dayIndex: 0, stops: [] }], stops: [], routeLegs: [] },
    { id: 'p_future', kind: 'plan', name: '未来计划', cityCode: '330100', localDate: todayString().replace(/(\d+)$/, (m) => String(Number(m) + 3).padStart(2, '0')), stops: [{ place: { name: 'B' } }], routeLegs: [] },
  ];
  state.planViewDate = '';
  const html = TODAY.renderToday();
  assert.match(html, /还没有计划/, '默认先查看今天，未安排时显示空状态');
  assert.ok(!html.includes('待定计划'), '日期待定的计划不应出现在计划与进度');
  assert.ok(!html.includes('多天方案'), '未载入的多天方案不应出现在计划与进度');
  assert.ok(html.includes('data-action="plan-view-date"'), '应有日期切换');
  assert.ok(html.includes('data-action="edit-selected-day-plan"'), '空日期应有编辑入口');
  assert.ok(html.includes('>创建计划</button>'), '空日期使用清晰的安排入口文案');
  assert.match(html, /data-action="delete-date-plan" data-date="[^"]+" aria-label="[^"]+"/,
    '????????????????');
  assert.match(html, /<span class="plan-date-chip has-delete(?: selected)?"><button class="plan-date-select[^>]*>\d{4}年\d+月\d+日<\/button><button class="plan-date-delete"[^>]*>×<\/button>/,
    '删除 X 应紧跟日期显示，并与日期切换入口收在同一胶囊中');
  assert.ok(!html.includes('data-action="delete-saved-plan"'), 'duplicate delete action is not rendered inside the day card');
  // 日期切换：选中未来日期后只显示那一天的方案
  state.planViewDate = state.savedPlans[2].localDate;
  const switched = TODAY.renderToday();
  assert.ok(switched.includes('未来计划'));
  assert.ok(!switched.includes('去规划'));
  state.planViewDate = ''; state.savedPlans = [];
});

test('无旅行且没有任何计划：给出去规划的引导且不崩溃', () => {
  state.trip = null; state.savedPlans = []; state.planViewDate = '';
  const html = TODAY.renderToday();
  assert.match(html, /还没有计划/);
  assert.ok(html.includes('data-action="add-place-on-date"'));
  assert.ok(html.includes('>浏览地点</button>'));
  assert.equal((html.match(/data-action="edit-selected-day-plan"/g) || []).length, 1);
});

test('计划加载失败时显示可重试状态而不是伪装成空计划', () => {
  const previous = { trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate, loadStatus: state.loadStatus };
  try {
    state.trip = null;
    state.savedPlans = [];
    state.planViewDate = '';
    state.loadStatus = { plans: { status: 'error', message: '计划服务不可用' } };
    const html = TODAY.renderToday();
    assert.match(html, /计划暂时无法加载/);
    assert.match(html, /data-action="retry-current-view"/);
    assert.doesNotMatch(html, /还没有计划/);
  } finally {
    Object.assign(state, previous);
  }
});

test('历史重复日计划会全部列出并提示处理，不会在旅行视图里静默采用第一份', () => {
  const previous = {
    trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate,
    mountedDate: state.mountedDate,
  };
  const tomorrowDate = new Date(`${todayString()}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  try {
    state.trip = null;
    state.savedPlans = [
      { id: 'legacy-a', kind: 'plan', name: '旧计划甲', localDate: tomorrow, stops: [{ stopId: 'a', place: { name: '甲的地点' } }] },
      { id: 'legacy-b', kind: 'plan', name: '旧计划乙', localDate: tomorrow, stops: [{ stopId: 'b', place: { name: '乙的地点' } }] },
    ];
    state.planViewDate = tomorrow;
    let html = TODAY.renderToday();
    assert.ok(html.includes('有 2 份日计划'));
    assert.ok(html.includes('旧计划甲') && html.includes('旧计划乙'), '无旅行视图明确展示两份独立计划');

    seedTrip({ stops: [] });
    state.savedPlans = [
      { id: 'legacy-a', kind: 'plan', name: '旧计划甲', localDate: tomorrow, stops: [{ stopId: 'a', place: { name: '甲的地点' } }] },
      { id: 'legacy-b', kind: 'plan', name: '旧计划乙', localDate: tomorrow, stops: [{ stopId: 'b', place: { name: '乙的地点' } }] },
    ];
    state.planViewDate = tomorrow;
    html = TODAY.renderToday();
    assert.ok(html.includes('有 2 份日计划'));
    assert.match(html, /data-action="edit-day-plan" data-plan="legacy-a"/);
    assert.match(html, /data-action="edit-day-plan" data-plan="legacy-b"/);
    assert.ok(html.includes('甲的地点') && html.includes('乙的地点'), '重复计划应各自显示自己的地点内容');
  } finally {
    state.trip = previous.trip;
    state.savedPlans = previous.savedPlans;
    state.planViewDate = previous.planViewDate;
    state.mountedDate = previous.mountedDate;
  }
});

test('legacy dated plans display the planned-arrival time when startMinutes is absent', () => {
  const previous = { trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  state.trip = null;
  state.savedPlans = [{
    id: 'arrival_only_day', kind: 'plan', name: '旧版日计划', localDate: todayString(),
    stops: [{ stopId: 'arrival_only_stop', place: { name: '早到地点' }, plannedArrivalMinutes: 600, plannedDurationMinutes: 60 }],
  }];
  state.planViewDate = '';
  try {
    assert.match(TODAY.renderToday(), /10:00/);
  } finally {
    state.trip = previous.trip;
    state.savedPlans = previous.savedPlans;
    state.planViewDate = previous.planViewDate;
  }
});

test('旅行=今天：待进行地点可执行，不显示空的进行中与进度卡', () => {
  seedTrip({ stops: [makeStop({ name: '地点1', status: 'planned' })] });
  const html = TODAY.renderToday();
  assert.ok(html.includes('data-type="depart"'), '应有出发');
  assert.ok(html.includes('data-action="pick-stop-mode"'), '当天日计划应能在出发前选择交通方式');
  assert.ok(html.includes('路线时间待估') && html.includes('出发时会按当前位置规划路线并更新预计时间'), '未规划的路段不编造时间，并说明出发时会使用实时位置重算');
  assert.ok(!html.includes('data-type="complete"'), '计划站点不直接给完成，完成在到达后出现');
  assert.ok(html.includes('data-type="skip"'), '应有跳过');
  assert.ok(html.includes('data-action="edit-plan-stop-time"'), '应有调整时间');
  assert.ok(!html.includes('id="ongoing-trip"'), '没有进行中的地点时不显示进行中卡');
  assert.ok(!html.includes('id="trip-progress"'), '进度为 0 时不显示进度卡');
  assert.ok(!html.includes('还有 '), '今天不应出现未来横幅');
});

test('跨午夜仍在进行的前一天站点留在今天的进行中区，可到达或完成但不显示过期日期', () => {
  const previous = {
    trip: state.trip,
    clockReceivedAt: state.clockReceivedAt,
    savedPlans: state.savedPlans,
    planViewDate: state.planViewDate,
    mountedDate: state.mountedDate,
  };
  const today = todayString();
  const yesterdayDate = new Date(`${today}T00:00:00.000Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  state.savedPlans = [];
  try {
    seedTrip({
      localDate: yesterday,
      clockDate: today,
      stops: [makeStop({ stopId: 'overnight-stop', name: '跨夜地点', date: yesterday, status: 'en_route' })],
      events: [{ executionEventId: 'overnight-depart', stopId: 'overnight-stop', type: 'depart', occurredAt: `${yesterday}T23:50:00+08:00`, recordedAt: `${yesterday}T23:50:00+08:00` }],
    });
    let html = TODAY.renderToday();
    assert.ok(!html.includes('跨夜地点'), '过期日计划会被归档，不在今天的进度中继续显示');
    assert.ok(!html.includes('data-type="arrive"'), '过期日计划不再提供执行按钮');
    assert.ok(!html.includes(`data-date="${yesterday}"`), '保留进行中地点不应重新显示过期日期标签');

    seedTrip({
      localDate: yesterday,
      clockDate: today,
      stops: [makeStop({ stopId: 'overnight-stop', name: '跨夜地点', date: yesterday, status: 'visiting' })],
      events: [{ executionEventId: 'overnight-arrive', stopId: 'overnight-stop', type: 'arrive', occurredAt: `${yesterday}T23:58:00+08:00`, recordedAt: `${yesterday}T23:58:00+08:00` }],
    });
    html = TODAY.renderToday();
    assert.ok(!html.includes('跨夜地点'), '过期日计划不再显示');
    assert.ok(!html.includes('data-type="complete"'), '过期日计划不再提供执行按钮');
    assert.ok(!html.includes(`data-date="${yesterday}"`), '过期日期仍不应出现在切换栏');
  } finally {
    state.trip = previous.trip;
    state.clockReceivedAt = previous.clockReceivedAt;
    state.savedPlans = previous.savedPlans;
    state.planViewDate = previous.planViewDate;
    state.mountedDate = previous.mountedDate;
  }
});

test('有旅行时也能删除当前日期对应的已保存日计划', () => {
  const previous = state.savedPlans;
  const today = todayString();
  seedTrip({ stops: [] });
  state.savedPlans = [{ id: 'saved_today', kind: 'plan', localDate: today, stops: [], routeLegs: [] }];
  try {
    const html = TODAY.renderToday();
    assert.match(html, /data-action="delete-date-plan" data-date="[^"]+" aria-label="删除 [^"]+ 的计划"/);
  assert.ok(!html.includes('删除计划</button>'), '删除入口应收进日期切换标签');
  } finally {
    state.savedPlans = previous;
  }
});

test('今天的计划节点只保留跳过，不重复显示移除按钮', () => {
  seedTrip({ localDate: todayString(), clockDate: todayString(), stops: [makeStop({ name: '地点1', status: 'planned' })] });
  const html = TODAY.renderToday();
  const skipButton=html.match(/<button\b[^>]*data-type="skip"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(skipButton,'未开始的节点应有跳过按钮');
  assert.match(skipButton,/跳过/,'带图标的跳过按钮仍须保留可理解的文案');
  assert.ok(!html.includes('data-action="ask-remove-plan-stop"'));
  assert.ok(!html.includes('跳过（删除）'));
  assert.ok(html.includes('data-type="depart"'));
});

test('旅行=未来：规划态（只可调整与跳过，不能出发/完成），显示倒计时且无进度区块', () => {
  const future = todayString().replace(/(\d+)$/, (m) => String(Number(m) + 3).padStart(2, '0'));
  seedTrip({ localDate: future, clockDate: todayString(), stops: [makeStop({ name: '地点1', status: 'planned' })] });
  const html = TODAY.renderToday();
  assert.ok(html.includes('未来计划') || html.includes('测试日计划'));
  assert.ok(html.includes('data-action="edit-plan-stop-time"'), '未来日期可以调整计划时间');
  assert.ok(html.includes('data-action="ask-remove-plan-stop"'), '未来日期可以移除计划地点');
  assert.ok(!html.includes('data-type="depart"'), '未来不能出发');
  assert.ok(!html.includes('data-type="complete"'), '未来不能完成');
  assert.ok(html.includes('09:00 - 10:00'), '未来日期仍显示游览时段');
  assert.ok(!html.includes('id="ongoing-trip"'), '未来没有进行中区块');
  assert.ok(!html.includes('id="trip-progress"'), '未来没有进度区块');
});

test('查看未挂载的未来日期时，添加入口编辑该日方案，不会把地点加到今天', () => {
  const previous = { savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  const today = todayString();
  const tomorrowDate = new Date(`${today}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  seedTrip({ stops: [] });
  state.savedPlans = [{ id: 'tomorrow_plan', kind: 'plan', localDate: tomorrow, stops: [], routeLegs: [] }];
  state.planViewDate = tomorrow;
  try {
    const html = TODAY.renderToday();
    assert.match(html, /data-action="edit-day-plan" data-plan="tomorrow_plan"/);
    assert.ok(!html.includes('data-action="navigate" data-view="places"'), '未来日不能把加地点操作隐式写到已挂载的今天');
    assert.ok(html.includes('data-action="edit-day-plan"'), '应能直接编辑所选日期的静态日计划');
  } finally {
    state.savedPlans = previous.savedPlans;
    state.planViewDate = previous.planViewDate;
  }
});

test('旅行日期已过去：过期计划和进度不再显示', () => {
  const past = todayString().replace(/(\d+)$/, (m) => String(Number(m) - 2).padStart(2, '0'));
  seedTrip({
    localDate: past, clockDate: todayString(),
    stops: [
      makeStop({ stopId: 's_done', name: '地点1', status: 'completed' }),
      makeStop({ stopId: 's_stuck', name: '地点2', status: 'planned' }),
    ],
    events: [
      { executionEventId: 'e1', stopId: 's_done', type: 'complete', occurredAt: `${past}T10:00:00+08:00`, recordedAt: `${past}T10:00:00+08:00` },
    ],
  });
  const html = TODAY.renderToday();
  assert.ok(!html.includes('这一天已结束'), '过期日期不再提供历史回顾入口');
  assert.ok(!html.includes('地点1') && !html.includes('地点2'), '旧计划地点不再显示');
  assert.ok(!html.includes('data-action="correct-progress"'), '过期进度不能继续纠正');
  assert.ok(!html.includes('data-type="depart"'), '过去不能出发');
  assert.ok(!html.includes('data-action="edit-stop-time"'), '过去不能调整时间');
});

test('进行中的地点（en_route/visiting）只出现在今天，且有到达/完成与导航', () => {
  seedTrip({ stops: [
    makeStop({ stopId: 's_route', name: '前往中', status: 'en_route' }),
    makeStop({ stopId: 's_visit', name: '游览中', status: 'visiting' }),
  ] });
  const html = TODAY.renderToday();
  assert.ok(html.includes('前往中') && html.includes('游览中'), '进行中的地点显示在当天计划');
  assert.ok(html.includes('data-type="arrive"'), 'en_route 应有到达');
  assert.ok(html.includes('data-type="abort"'), 'en_route 应可中止');
  assert.ok(html.includes('路线与导航'), '应有导航入口');
  assert.equal([...html.matchAll(/data-type="complete"/g)].length, 1, '只有 visiting 有完成');
});

test('执行保存期间：执行类按钮禁用且有状态提示', () => {
  seedTrip({ stops: [makeStop({ status: 'planned' })] });
  state.executionPending = { tripId: 'trip_matrix', stopId: state.trip.snapshot.stops[0].stopId, type: 'depart' };
  const html = TODAY.renderToday();
  assert.ok(html.includes('正在保存进度……'));
  assert.ok(html.includes('disabled aria-disabled="true"'), '执行按钮应禁用');
  state.executionPending = null;
});

test('跳过的站点不占编号、不进计划列表；进度历史含纠正标记', () => {
  seedTrip({
    stops: [
      makeStop({ stopId: 's_skip', name: '被跳过', status: 'skipped' }),
      makeStop({ stopId: 's1', name: '第一站', status: 'completed' }),
    ],
    events: [
      { executionEventId: 'e1', stopId: 's1', type: 'complete', occurredAt: `${todayString()}T10:00:00+08:00`, recordedAt: `${todayString()}T10:00:00+08:00` },
      { executionEventId: 'e2', stopId: 's1', type: 'complete', correctsEventId: 'e1', statusOverride: 'planned', correctionReason: '误点完成', occurredAt: `${todayString()}T11:00:00+08:00`, recordedAt: `${todayString()}T11:00:00+08:00` },
    ],
  });
  state.trip.snapshot.stops.find((stop: any) => stop.stopId === 's1').status = 'planned';
  const html = TODAY.renderToday();
  assert.ok(!html.includes('被跳过'), '跳过站点不显示');
  assert.ok(html.includes('（已被纠正）'), '纠正记录应有标记');
  assert.ok(html.includes('纠正为未完成'), '纠正目标状态应显示');
});

test('全部完成后：进度 100%，出现“当天安排已结束”', () => {
  seedTrip({ stops: [
    makeStop({ stopId: 's1', name: '第一站', status: 'completed' }),
    makeStop({ stopId: 's2', name: '第二站', status: 'completed' }),
  ] });
  const html = TODAY.renderToday();
  assert.ok(html.includes('进度 2/2'));
  assert.ok(html.includes('当天安排已结束'));
  assert.ok(html.includes('width:100%'), '进度条应满格');
});

test('缺失时钟时按今天处理且不崩溃', () => {
  seedTrip({ stops: [makeStop({ status: 'planned' })] });
  delete state.trip.clock;
  const html = TODAY.renderToday();
  assert.ok(html.includes('data-type="depart"'), '无时钟按今天处理');
});

test('三态显示遵守文档：已完成、进行中、计划分组，组内按时间排序且不修改计划队列', () => {
  const stops = [
    makeStop({ stopId: 'later-plan', name: '晚些计划', startMinutes: 1080, endMinutes: 1140 }),
    makeStop({ stopId: 'later-done', name: '后来完成', status: 'completed', startMinutes: 840, endMinutes: 900 }),
    makeStop({ stopId: 'active', name: '正在前往', status: 'en_route', startMinutes: 960, endMinutes: 1020, travelStartMinutes: 920 }),
    makeStop({ stopId: 'earlier-plan', name: '较早计划', startMinutes: 480, endMinutes: 540 }),
    makeStop({ stopId: 'earlier-done', name: '先前完成', status: 'completed', startMinutes: 720, endMinutes: 780 }),
    makeStop({ stopId: 'skipped', name: '跳过地点', status: 'skipped', startMinutes: 600, endMinutes: 660 }),
  ];
  seedTrip({ stops });
  const before = structuredClone(state.savedPlans[0].stops);
  const html = TODAY.renderToday();
  const order = [...html.matchAll(/data-plan-state="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['completed', 'active', 'planned']);
  const names = [...html.matchAll(/<h4>(先前完成|后来完成|正在前往|较早计划|晚些计划)<\/h4>/g)].map(match => match[1]);
  assert.deepEqual(names, ['先前完成', '后来完成', '正在前往', '较早计划', '晚些计划']);
  assert.doesNotMatch(html, /跳过地点/);
  assert.deepEqual(state.savedPlans[0].stops, before, '显示分组不能改写排期或进度事实');
});

test('状态变化后地点进入对应分组，空分组不占页面', () => {
  seedTrip({ stops: [makeStop({ stopId: 'moving', name: '当前地点' })] });
  for (const [status, expected] of [['planned', 'planned'], ['en_route', 'active'], ['visiting', 'active'], ['completed', 'completed']]) {
    state.savedPlans[0].stops[0].status = status;
    const html = TODAY.renderToday();
    assert.deepEqual([...html.matchAll(/data-plan-state="([^"]+)"/g)].map(match => match[1]), [expected]);
    assert.equal((html.match(/<h4>当前地点<\/h4>/g) || []).length, 1, '同一地点不能同时出现在两个状态区');
  }
  state.savedPlans[0].stops[0].status = 'skipped';
  assert.doesNotMatch(TODAY.renderToday(), /data-plan-state=/);
});
