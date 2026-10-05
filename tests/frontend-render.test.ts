/**
 * 视图渲染验证（无需浏览器）。
 *
 * 之前的断言都是"文件里有没有某个字符串"，那只能证明代码存在，不能证明它**能跑**。
 * 视图是纯函数（只依赖 `state`，不碰 DOM），因此可以直接在 Node 里 import 并调用，
 * 用一份样例状态渲染出真实 HTML 再检查。
 *
 * 这能抓到字符串匹配抓不到的三类问题：
 *   1. 渲染时抛异常（未定义字段、拼错属性名）；
 *   2. 输出结构缺失（时间轴没有节点、候选没有采用按钮）；
 *   3. **未转义的用户数据**（地点名／记录里塞 `<script>` 会被原样输出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const todayString = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const state = store.state as Record<string, any>;

const HOME = await load('public/views/home.js');
const TODAY = await load('public/views/today.js');
const PLAN = await load('public/views/plan.js');
const AGENT = await load('public/views/agent.js');
const PLACES = await load('public/views/places.js');
const MEMORIES = await load('public/views/memories.js');
const MINE = await load('public/views/mine.js');
const FAVORITES = await load('public/views/favorites.js');
const LOAD_STATE = await load('public/lib/load-state.js');
const COMMUNITY = await load('public/views/community.js');
const PLAN_SHARES = await load('public/views/plan-shares.js');

const VIEWS: Array<[string, () => string]> = [
  ['home', HOME.renderHome],
  ['today', TODAY.renderToday],
  ['plan', PLAN.renderPlan],
  ['agent', AGENT.renderAgent],
  ['places', PLACES.renderPlaces],
  ['memories', MEMORIES.renderMemories],
  ['mine', MINE.renderMine],
];

function seedTrip(overrides: { placeName?: string; memoryText?: string } = {}) {
  state.trip = {
    trip: {
      tripId: 'trip_fixture_0001',
      dataMode: 'demo',
      lifecycle: 'active',
      planningStatus: 'validated',
      revision: 3,
      contentRevision: 2,
      timezone: 'Asia/Shanghai',
      localDate: '2026-09-20',
      cityCode: '330100',
      latestContextId: 'ctx_1',
      deletedAt: null,
    },
    snapshot: {
      stops: [
        {
          stopId: 'stop_1',
          placeId: 'place_1',
          place: {
            placeId: 'place_1',
            name: overrides.placeName ?? '西湖白堤',
            coordinates: { lat: 30.259, lng: 120.149, source: 'demo' },
            facilityCodes: ['outdoor', 'walking'],
            evidenceIds: ['ev_1'],
          },
          startMinutes: 9 * 60,
          endMinutes: 11 * 60,
          plannedDurationMinutes: 90,
          status: 'completed',
        },
        {
          stopId: 'stop_2',
          placeId: 'place_2',
          place: {
            placeId: 'place_2',
            name: '湖边休息点',
            coordinates: { lat: 30.258, lng: 120.151, source: 'demo' },
            facilityCodes: ['rest_area', 'seat'],
            evidenceIds: ['ev_2'],
          },
          startMinutes: 11 * 60 + 30,
          endMinutes: 12 * 60,
          plannedDurationMinutes: 30,
          status: 'planned',
        },
      ],
      routeLegs: [
        {
          legId: 'leg_1',
          fromStopId: 'stop_1',
          toStopId: 'stop_2',
          transportMode: 'walking',
          durationMinutes: 10,
          walkingMeters: 600,
          distanceMeters: 600,
          bufferMinutes: 5,
        },
      ],
      plannedCharges: [],
      tripSettings: { partySize: 2 },
      budget: { currency: 'CNY', limitMinor: 20000, strength: 'hard', scope: 'trip' },
    },
    versionCount: 3,
    pendingActionRequests: [],
  };
  state.places = [
    {
      placeId: 'place_1',
      name: overrides.placeName ?? '西湖白堤',
      category: 'landmark',
      coordinates: { lat: 30.259, lng: 120.149, source: 'demo' },
      facilityCodes: ['outdoor', 'walking'],
      evidenceIds: ['ev_1'],
    },
  ];
  state.memories = [
    {
      memoryId: 'memory_1',
      type: 'note',
      userText: overrides.memoryText ?? '今天和妈妈逛得很开心',
      entryVersion: 1,
      createdAt: '2026-09-20T12:00:00+08:00',
      staleAt: null,
    },
  ];
  state.messages = [
    { role: 'user', text: '我想休息一下' },
    { role: 'assistant', text: '已经生成调整方案，请查看具体变化后确认。' },
  ];
  state.proposal = null;
  state.actionRequests = [];
  state.ready = null;
  state.lastMutation = null;
  state.places.length = 1;
}

function seedEmpty() {
  state.trip = null;
  state.trips = [];
  state.savedPlans = [];
  state.planViewDate = '';
  state.places = [];
  state.memories = [];
  state.messages = [];
  state.proposal = null;
  state.actionRequests = [];
  state.ready = null;
  state.lastMutation = null;
}


test('place filters show Chinese labels and match any official tag on a place', () => {
  seedTrip();
  state.officialTags = [{ id: 'culture', label: '文化展览' }, { id: 'indoor', label: '室内' }];
  state.places = [{ placeId: 'tagged', name: '展馆', category: 'culture', facilityCodes: [],
    tags: [{ id: 'culture', label: '文化展览', source: 'official' }, { id: 'indoor', label: '室内', source: 'official' },
      { id: 'custom', label: '<script>自定义</script>', source: 'user' }] }];
  state.placeQuery = ''; state.placeCategory = 'indoor';
  const html = PLACES.renderPlaces();
  assert.ok(html.includes('展馆'));
  assert.ok(html.includes('>室内</button>'));
  assert.ok(html.includes('&lt;script&gt;自定义&lt;/script&gt;'));
  assert.ok(!html.includes('用户 · '));
  assert.ok(!html.includes('>culture<') && !html.includes('>landmark<'));
  state.placeCategory = 'food'; assert.ok(!PLACES.renderPlaces().includes('<h4>展馆</h4>'));
  state.placeCategory = '全部'; state.officialTags = undefined;
});

test('approved traveler places use the shared directory card and support the shared rating filter', () => {
  const previous = {
    places: state.places, community: state.community, communityMine: state.communityMine,
    communityPosts: state.communityPosts, officialTags: state.officialTags, placeQuery: state.placeQuery,
    placeCategory: state.placeCategory, placeCity: state.placeCity, communityCity: state.communityCity,
    communitySort: state.communitySort, placeAdvanced: state.placeAdvanced,
  };
  state.places = [{ placeId: '12345678901234', name: '审核通过的小院', provider: 'community_reviewed', createdAt: '2026-09-01T00:00:00.000Z',
    description: '旅人留下的真实介绍', cityCode: '330100', address: '小院入口', category: 'unknown', facilityCodes: [],
    openingIntervals: [], suggestedDurationMinutes: null, tags: [], reviews: [{ nickname: '旅人', rating: 5, text: '很舒服' }] }];
  state.community = [];
  state.communityMine = { posts: [], places: [{ id: 'private_pending', name: '只对作者可见的地点', status: 'pending', reviewCount: 0 }] };
  state.communityPosts = []; state.officialTags = []; state.placeQuery = ''; state.placeCategory = '全部'; state.placeCity = '';
  state.communityCity = ''; state.communitySort = 'newest'; state.placeAdvanced = { facilities: [], cost: '', duration: '', rating: '' };
  try {
    const html = PLACES.renderPlaces();
    assert.match(html, /审核通过的小院/);
    assert.match(html, /旅人推荐 · 已审核/);
    assert.match(html, /data-action="open-place" data-place="12345678901234"/);
    assert.match(html, /data-action="shortlist" data-place="12345678901234"/);
    assert.match(html, /只对作者可见的地点/, '发布者仍能在“我分享的地点”中查看自己的待审记录');
    assert.match(html, /data-action="community-detail" data-id="private_pending"/);
    state.placeAdvanced = { ...state.placeAdvanced, rating: '4' };
    assert.match(PLACES.renderPlaces(), /审核通过的小院/, '旅人评分筛选也作用于统一地点目录');
    state.placeAdvanced = { ...state.placeAdvanced, rating: '6' };
    assert.doesNotMatch(PLACES.renderPlaces(), /审核通过的小院/);
  } finally {
    Object.assign(state, previous);
  }
});

test('today keeps completed stops in progress and pending stops editable', () => {
  const before = { trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  const today = todayString();
  state.trip = null;
  state.planViewDate = today;
  state.savedPlans = [{ id: 'daily-plan', kind: 'plan', localDate: today, name: '今日安排', timezone: 'Asia/Shanghai',
    stops: [
      { stopId: 'completed-stop', status: 'completed', place: { name: 'completed-place' }, startMinutes: 540, endMinutes: 600 },
      { stopId: 'pending-stop', status: 'planned', place: { name: 'pending-place' }, startMinutes: 630, endMinutes: 690 },
    ], routeLegs: [], executionEvents: [{ stopId: 'completed-stop', type: 'complete', occurredAt: `${today}T02:00:00.000Z` }] }];
  try {
    const html = TODAY.renderToday();
    const completedCard = html.slice(html.indexOf('completed-place'), html.indexOf('pending-place'));
    assert.ok(completedCard.includes('completed-place'));
    assert.doesNotMatch(completedCard, /data-action="edit-plan-stop-time"/);
    assert.ok(html.includes('pending-place'));
    assert.match(html, /data-action="edit-plan-stop-time" data-plan="daily-plan" data-stop="pending-stop"/);
    assert.ok(html.includes('进度 1/2'));
  } finally {
    state.trip = before.trip;
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
  }
});

test('every view renders without a browser', () => {
  for (const seed of [seedTrip, seedEmpty]) {
    seed();
    for (const [name, render] of VIEWS) {
      let html: string;
      try {
        html = render();
      } catch (error) {
        assert.fail(`${name} 渲染时抛异常: ${(error as Error).message}`);
      }
      assert.equal(typeof html, 'string', `${name} 应返回 HTML 字符串`);
      assert.ok(html.length > 40, `${name} 输出过短（${html.length} 字符），疑似渲染失败`);
      assert.equal(
        /undefined|\[object Object\]|NaN/.test(html),
        false,
        `${name} 的输出里出现了 undefined／[object Object]／NaN`,
      );
    }
  }
});

test('progress buttons are disabled during a pending save and recover afterwards', () => {
  const before = { trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate, executionPending: state.executionPending };
  const today = todayString();
  state.trip = null;
  state.planViewDate = today;
  state.savedPlans = [{ id: 'pending-plan', kind: 'plan', localDate: today, name: '今日安排', timezone: 'Asia/Shanghai',
    stops: [{ stopId: 'pending-stop', status: 'planned', place: { name: 'pending-place' }, startMinutes: 600, endMinutes: 660 }], routeLegs: [], executionEvents: [] }];
  state.executionPending = { planId: 'pending-plan', stopId: 'pending-stop', type: 'depart' };
  try {
    const html = TODAY.renderToday();
    assert.ok(html.includes('正在保存进度'));
    assert.ok(html.includes('data-action="exec" disabled'));
    assert.ok(!/data-action="exec"(?! disabled)/.test(html));
    state.executionPending = null;
    assert.ok(!TODAY.renderToday().includes('data-action="exec" disabled'));
  } finally {
    state.trip = before.trip;
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
    state.executionPending = before.executionPending;
  }
});

test('home plan numbers exclude completed, skipped and ongoing stops', () => {
  const before = { trip: state.trip, savedPlans: state.savedPlans, places: state.places };
  const today = todayString();
  state.trip = null;
  state.places = [];
  state.savedPlans = [{ id: 'home-plan', kind: 'plan', localDate: today, name: '今日安排', timezone: 'Asia/Shanghai',
    stops: ['completed', 'skipped', 'en_route', 'planned', 'planned'].map((status, index) => ({
      stopId: `home-stop-${index}`, status, place: { name: `place-${index}` }, startMinutes: 600 + index * 60, endMinutes: 630 + index * 60,
    })), routeLegs: [], executionEvents: [] }];
  try {
    const html = HOME.renderHome();
    const list = html.match(/<section class="card companion-remaining"[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(list.includes('place-3') && list.includes('place-4'));
    assert.ok(!list.includes('place-0') && !list.includes('place-1') && !list.includes('place-2'));
    assert.deepEqual([...list.matchAll(/<li><span>(\d+)<\/span>/g)].map(match => match[1]), ['03', '04']);
    assert.ok(html.includes('还有 2 站等着你'));
    assert.match(html, /<progress value="1" max="4"/);
    assert.match(html, /data-action="companion-exec"[^>]*data-type="arrive"/);
  } finally {
    state.trip = before.trip;
    state.savedPlans = before.savedPlans;
    state.places = before.places;
  }
});

test('home hero follows today when the trip started on an earlier date', () => {
  seedTrip();
  const originalDate = state.trip.trip.localDate;
  try {
    state.trip.trip.localDate = '2000-01-01';
    const html = HOME.renderHome();
    const [year, month, day] = todayString().split('-');
    assert.ok(html.includes(`${year}年${Number(month)}月${Number(day)}日`));
    assert.ok(!html.includes('2000年1月1日'));
  } finally {
    state.trip.trip.localDate = originalDate;
  }
});

test('community filters personal posts through the same feed cards', async () => {
  const renderer = await load('public/lib/render.js');
  const previous = {
    currentView: state.currentView, principal: state.principal, communityPosts: state.communityPosts,
    communityMine: state.communityMine, communityPostFilter: state.communityPostFilter, loadStatus: state.loadStatus,
    postDetailId: state.postDetailId, postDetail: state.postDetail,
    document: globalThis.document, window: globalThis.window,
  };
  const nodes: Record<string, any> = {
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' }, sidebarTrip: { innerHTML: '' },
    view: { innerHTML: '' },
  };
  state.currentView = 'community';
  state.principal = { kind: 'account', nickname: '旅人' };
  state.communityPosts = [{ id: 'feed-post', text: '朋友的旅行', nickname: '朋友', createdAt: '2026-09-20T00:00:00.000Z',
    comments: [], commentCount: 0, likes: 0, liked: false }];
  state.communityMine = { posts: [{ id: 'mine-post', text: '今天的旅途', nickname: '旅人', createdAt: '2026-09-20T00:00:00.000Z',
    comments: [{ id: 'comment-1', nickname: '朋友', text: '下次一起去', mine: false }], commentCount: 1, likes: 0 }], places: [] };
  state.communityPostFilter = 'all';
  state.postDetailId = '';
  state.postDetail = null;
  state.loadStatus = {};
  globalThis.document = {
    getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [], activeElement: null,
  } as unknown as Document;
  globalThis.window = { scrollTo: () => {} } as unknown as Window & typeof globalThis;

  try {
    renderer.render();
    assert.ok(nodes.view.innerHTML.includes('data-action="open-post-detail" data-post="feed-post"'));
    assert.ok(!nodes.view.innerHTML.includes('data-post="mine-post"'), 'the all-posts filter stays on the public feed page');
    assert.ok(!nodes.view.innerHTML.includes('下次一起去'), 'feed previews do not embed comments');
    assert.doesNotMatch(nodes.view.innerHTML, /data-action="toggle-comments"/);
    assert.match(nodes.view.innerHTML, /data-action="like-post" data-post="feed-post" aria-label="点赞，0 个赞" aria-pressed="false"/);
    state.communityPostFilter = 'mine';
    renderer.render();
    assert.ok(nodes.view.innerHTML.includes('data-action="open-post-detail" data-post="mine-post"'));
    assert.ok(!nodes.view.innerHTML.includes('data-post="feed-post"'), 'the personal filter only shows the current account posts');
    assert.match(nodes.view.innerHTML, /data-action="favorite-post" data-post="mine-post"/);
    assert.match(nodes.view.innerHTML, /data-action="like-post" data-post="mine-post" aria-label="点赞，0 个赞" aria-pressed="false"/);
    state.postDetailId = 'mine-post';
    state.postDetail = { id: 'mine-post', title: '今天的旅途', text: '今天的旅途', nickname: '旅人',
      comments: [{ id: 'comment-1', nickname: '朋友', text: '下次一起去', mine: false }], commentCount: 1, likes: 0 };
    assert.ok(COMMUNITY.renderPostDetail().includes('下次一起去'), 'post detail shows existing comments');
  } finally {
    Object.assign(state, previous);
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});

test('favorites link to post details and withdrawn snapshots remain read-only', () => {
  const previous = {
    principal: state.principal, postFavorites: state.postFavorites, favoritePostDetails: state.favoritePostDetails,
    postDetailId: state.postDetailId, postDetail: state.postDetail,
  };
  state.principal = { kind: 'account', nickname: '旅人' };
  state.postFavorites = [
    { post: { postId: 'active-post', title: '还在的帖子', nickname: '作者', body: '正文', createdAt: '2026-09-20', source: 'active' } },
    { post: { postId: 'withdrawn-post', title: '已撤回的帖子', nickname: '作者', body: '快照正文', createdAt: '2026-09-19', source: 'withdrawn' } },
  ];
  state.favoritePostDetails = { 'active-post': { id: 'active-post', commentCount: 1, comments: [{ id: 'comment-1', nickname: '朋友', text: '一起去', mine: false }] } };
  state.postDetailId = '';
  state.postDetail = null;
  try {
    const html = FAVORITES.renderFavorites();
    assert.match(html, /href="#\/post\/active-post" data-action="open-post-detail" data-post="active-post"/);
    assert.doesNotMatch(html, /data-action="toggle-favorite-post-comments"/);
    assert.ok(!html.includes('一起去'), 'comments are not embedded in the favorites card');
    assert.ok(html.includes('原帖已撤回，快照保留'));
    state.postDetailId = 'active-post';
    state.postDetail = { id: 'active-post', text: '标题\n正文', nickname: '作者', likes: 1,
      commentCount: 1, comments: [{ id: 'comment-1', nickname: '朋友', text: '一起去', mine: false }] };
    assert.ok(COMMUNITY.renderPostDetail().includes('一起去'), 'active post details expose comments');
  } finally {
    Object.assign(state, previous);
  }
});

test('empty dated plans can be created and edited without a Trip or demo data', () => {
  const before = { trip: state.trip, savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  const today = todayString();
  state.trip = null;
  state.savedPlans = [];
  state.planViewDate = today;
  try {
    const empty = TODAY.renderToday();
    assert.ok(empty.includes('data-action="add-place-on-date"'));
    assert.ok(empty.includes('data-action="edit-selected-day-plan"'));
    assert.ok(!empty.includes('data-action="create-demo"'));
    state.savedPlans = [{ id: 'empty-day', kind: 'plan', localDate: today, name: '空白日程', stops: [], routeLegs: [] }];
    const html = TODAY.renderToday();
    assert.ok(html.includes('添加地点'));
    assert.ok(!html.includes('data-action="generate-initial"'));
  } finally {
    state.trip = before.trip;
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
  }
});

test('candidate page offers comparison and one group rejection; chat stays message focused', () => {
  seedTrip();
  const candidate = {candidateId:'first', title:'第一候选', summary:'候选安排', applicability:'applicable', snapshot:state.trip.snapshot, changes:[], checks:[]};
  state.proposal = {proposalId:'proposal-test', baseRevision:state.trip.trip.revision, kind:'initial', candidates:[candidate, {...candidate, candidateId:'second', title:'第二候选'}]};
  const html = PLAN.renderPlan();
  assert.ok(html.includes('方案候选'));
  assert.ok(html.includes('candidate-comparison'));
  assert.equal((html.match(/data-action="reject"/g) || []).length, 1);
  assert.equal((html.match(/data-action="analyze-candidates"/g) || []).length, 1);
  assert.ok(html.includes('采用为计划'));
  assert.ok(!AGENT.renderAgent().includes('data-action="analyze-candidates"'));
});

test('views render the data they are given', () => {
  seedTrip();
  const todayDate = todayString();
  state.savedPlans = [{ id: 'today-plan', kind: 'plan', localDate: todayDate, name: '今日安排', timezone: 'Asia/Shanghai',
    stops: state.trip.snapshot.stops, routeLegs: [], executionEvents: [] }];

  const home = HOME.renderHome();
  assert.ok(home.includes('当前定位'), '未定位时首页位置标签回退为「当前定位」');
  const [y, m, d] = todayDate.split('-');
  assert.ok(home.includes(`${y}年${Number(m)}月${Number(d)}日`), '首页应显示带年份的日期');
  assert.ok(home.includes('西湖白堤'), '首页的推荐地点应出现样例地点名');
  assert.ok(!home.includes('data-action="quick-event"'), '调整需求统一通过伴途对话提出');

  const today = TODAY.renderToday();
  assert.ok(today.includes('西湖白堤') && today.includes('湖边休息点'), '今日页应列出全部节点');
  assert.ok(today.includes('11:30'), '待进行节点应显示计划时间');
  assert.ok(today.includes('实际完成时间未记录'), '已完成但没有执行记录时，不把计划时间冒充实际时间');
  assert.ok(today.includes('data-action="exec"'), '今日页应有执行记录按钮');

  const agent = AGENT.renderAgent();
  assert.ok(agent.includes('我想休息一下'), '对话页应显示用户消息');
  assert.ok(agent.includes('请查看具体变化后确认'), '对话页应显示助手回复');

  const places = PLACES.renderPlaces();
  assert.ok(places.includes('西湖白堤'), '地点页应显示地点');
  assert.ok(places.includes('data-action="filter-places"'), '地点页应有分类筛选');
  assert.ok(places.includes('data-action="shortlist"'), '地点页应有收藏入口');

  const memories = MEMORIES.renderMemories();
  assert.ok(memories.includes('今天和妈妈逛得很开心'), '记录页应显示记录原文');

  const mine = MINE.renderMine();
  assert.ok(mine.includes('高级信息'), '「我的」页应有高级信息折叠区');
  assert.ok(!mine.includes('trip_fixture_0001'), '无旅行实例概念后不显示旧 Trip ID');
  assert.ok(mine.includes('<h2>我的</h2>'), '「我的」页使用统一简洁的页眉');
  assert.ok(!mine.includes('我的内容'), '收藏等内容不在设置页重复堆叠');
  assert.ok(mine.includes('大字模式'), '「我的」页保留通用偏好设置');
});

test('failed data loads are shown as unavailable instead of empty collections', () => {
  const before = {
    trip: state.trip, trips: state.trips, favorites: state.favorites, postFavorites: state.postFavorites,
    savedPlans: state.savedPlans, memories: state.memories, communityMine: state.communityMine,
    loadStatus: state.loadStatus, principal: state.principal, communityPosts: state.communityPosts,
    planShares: state.planShares,
  };
  try {
    state.trip = null;
    state.trips = [];
    state.favorites = [];
    state.postFavorites = [];
    state.savedPlans = [];
    state.memories = [];
    state.communityMine = null;
    state.principal = { kind: 'account' };
    state.communityPosts = [];
    state.planShares = [];
    state.loadStatus = {
      favorites: { status: 'error', message: '收藏服务暂不可用' },
      plans: { status: 'error', message: '方案服务暂不可用' },
      memories: { status: 'error', message: '记忆服务暂不可用' },
      community: { status: 'error', message: '社区服务暂不可用' },
    };

    const favorites = FAVORITES.renderFavorites();
    assert.ok(!favorites.includes('还没有收藏的地点'));
    assert.ok(favorites.includes('暂未加载'));
    const plan = PLAN.renderPlan();
    assert.ok(plan.includes('方案没加载出来。'));
    assert.ok(!plan.includes('还没有方案。'));
    const memories = MEMORIES.renderMemories();
    assert.ok(!memories.includes('<h3>还没有旅行记忆</h3>'));
    assert.ok(memories.includes('暂未加载'));
    const mine = MINE.renderMine();
    assert.ok(!mine.includes('暂未加载'), 'Mine no longer duplicates content collections');
    assert.ok(!mine.includes('还没有收藏，去'));
    assert.ok(!COMMUNITY.renderCommunity().includes('还没有旅行帖子，写下你的第一篇感想吧。'));
    assert.ok(!PLAN_SHARES.renderPlanShares().includes('还没有公开方案'));
    const banner = LOAD_STATE.loadErrorBanner(['favorites', 'plans', 'memories', 'community']);
    assert.ok(banner.includes('role="alert"'));
    assert.ok(banner.includes('data-action="retry-current-view"'));
  } finally {
    Object.assign(state, before);
  }
});

test('dated plans do not expose Trip switching or deletion management', () => {
  const before = { trip: state.trip, trips: state.trips, savedPlans: state.savedPlans, planViewDate: state.planViewDate };
  state.trip = null;
  state.trips = [{ tripId: 'legacy-trip' }];
  state.savedPlans = [];
  state.planViewDate = todayString();
  try {
    const mine = MINE.renderMine();
    const today = TODAY.renderToday();
    assert.doesNotMatch(mine, /data-action="switch-trip"|当前旅行/);
    assert.doesNotMatch(today, /data-action="manage-trips"|删除旅行/);
    assert.match(today, /data-action="add-place-on-date"/);
  } finally {
    state.trip = before.trip;
    state.trips = before.trips;
    state.savedPlans = before.savedPlans;
    state.planViewDate = before.planViewDate;
  }
});

test('place detail resolves from every entry and dead links fall back gracefully', async () => {
  const PLACE = await load('public/views/place.js');
  seedTrip();
  // 行程站点里的地点（即使不在官方目录也能打开，避免「地点不存在」死胡同）
  state.places = [];
  state.placeDetailId = 'place_1';
  const stopHtml = PLACE.renderPlace();
  assert.ok(stopHtml.includes('西湖白堤'), '行程站点地点可解析');
  assert.ok(stopHtml.includes('data-action="write-place-review"'), '地点详情用星级评价入口');
  assert.ok(!stopHtml.includes('data-action="write-post"'), '详情页不再误接社区发帖器');

  // 方案库（含多天方案结构）里的地点
  state.trip = null;
  state.savedPlans = [{ id: 'p1', days: [{ stops: [{ place: { placeId: 'plan_place', name: '方案里的地点' } }] }] }];
  state.placeDetailId = 'plan_place';
  assert.ok(PLACE.renderPlace().includes('方案里的地点'), '方案库地点可解析');

  // 社区分享的地点（补齐目录字段与评价）
  state.savedPlans = [];
  state.community = [{ id: 'community_x', placeId: '12345678901234', status: 'approved', coordinateCrs: 'WGS84', lat: 30.25, lng: 120.15,
    name: '社区小院', address: '某路 1 号', description: '安静的院子', cityCode: '330100', tags: [],
    reviews: [
      { nickname: '旅人', rating: 4, text: '不错', createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString() },
      { nickname: '旧评价', rating: 5, text: '值得再来', daysAgo: 25 },
      { nickname: '无日期', rating: 4, text: '没有时间字段' },
    ] }];
  state.communityMine = { posts: [], places: [] };
  state.placeDetailId = '12345678901234';
  const sharedHtml = PLACE.renderPlace();
  assert.ok(sharedHtml.includes('社区小院'), '社区分享地点可解析');
  assert.ok(sharedHtml.includes('不错'), '社区评价可见');
  assert.ok(sharedHtml.includes('2 天前'), '真实评价按 createdAt 显示时间');
  assert.ok(sharedHtml.includes('25 天前'), '演示评价继续按 daysAgo 显示时间');
  assert.ok(sharedHtml.includes('时间未记录'), '缺少时间的旧评价也保留统一的时间位置');
  assert.equal((sharedHtml.match(/class="stop-meta review-time"/g) || []).length, 3, '每条评价都渲染相同的时间标签');
  assert.ok(sharedHtml.includes('旅人推荐 · 已审核收录'), '审核通过的旅人地点使用完整地点详情');
  assert.ok(sharedHtml.includes('data-action="add-to-plan" data-place="12345678901234"'), '可以和官方地点一样加入计划');
  assert.ok(sharedHtml.includes('data-action="write-place-review" data-place="12345678901234"'), '可以和官方地点一样写评价');
  state.community = [{ id: 'community_pending', name: '审核前不可公开', status: 'pending' }];
  state.placeDetailId = 'community_pending';
  assert.ok(!PLACE.renderPlace().includes('审核前不可公开'), '未审核地点不通过公开地点详情入口出现');
  assert.ok(PLACE.renderPlace().includes('正在打开地点'), '未经详情核对不猜测地点不存在');

  // 彻底不存在的 ID：只说明原因，返回交给顶部/底部导航
  state.community = []; state.communityMine = { posts: [], places: [] };
  state.placeDetailId = 'missing_place';
  assert.ok(PLACE.renderPlace().includes('正在打开地点'), '列表缺失先显示读取状态');
  state.placeDetailResource = { placeId:'missing_place', owner:state.principal?.principalId || '', status:'missing', message:'地点已不在公开目录中，或链接编号有误。' };
  assert.ok(PLACE.renderPlace().includes('地点暂不可查看'), '详情确认不存在后有说明');
  assert.ok(PLACE.renderPlace().includes('data-action="retry-place-detail"'), '死链接仍可重新核对');
  assert.ok(!PLACE.renderPlace().includes('data-action="navigate"'), '不再放多余的返回按钮');

  // 无 ID 深链接（重载后停留在 #/place）：引导回目录而不是报错
  state.placeDetailId = null;
  assert.ok(PLACE.renderPlace().includes('选择一个地点'), '无 ID 时提供选择入口');
  assert.ok(PLACE.renderPlace().includes('data-action="navigate" data-view="places"'), '入口明确回地点目录，不用迟到定时器抢走新地点');
  state.placeDetailResource = null;
});

test('empty views provide guidance and agent stays focused on chat', () => {
  seedEmpty();
  const home = HOME.renderHome();
  assert.ok(!home.includes('data-action="create-demo"'), '无计划时首页不创建预置样例');
  for (const [name, render] of VIEWS) {
    const html = render();
    if (name === 'agent') {
      assert.ok(html.includes('想去哪儿、怎么走，直接告诉我'), '无计划时伴途也能直接对话');
      assert.ok(html.includes('计划与进度'), '无计划时应明确计划入口');
      assert.ok(html.includes('data-action="use-agent-suggestion"'), '无历史对话时应提供可直接填入的 Agent 指令');
      assert.ok(!html.includes('data-action="navigate"'), 'Agent 快捷指令不应把用户带离对话');
      continue;
    }
    assert.ok(html.includes('data-action'), `${name} 在无计划时也应给出可点击的下一步`);
  }
});

test('views escape untrusted text instead of injecting it', () => {
  // 地点名与记录原文都来自外部（供应商／用户输入），必须转义后再进 HTML。
  const injected = '<script>alert(1)</script>';
  seedTrip({ placeName: injected, memoryText: injected });

  for (const [name, render] of VIEWS) {
    const html = render();
    assert.equal(
      html.includes('<script>alert(1)</script>'),
      false,
      `${name} 把未转义的内容直接写进了 HTML（XSS）`,
    );
    if (html.includes('alert(1)')) {
      assert.ok(
        html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
        `${name} 出现了未转义文本但没有对应的转义形式`,
      );
    }
  }
});
