import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const { state } = await load('public/lib/store.js');
const community = await load('public/lib/community.js');
const { decodePlanCode, encodePlanCode } = await load('public/lib/plan-code.js');
const planSharesView = await load('public/views/plan-shares.js');

function browserHarness() {
  const nodes: Record<string, any> = {
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' }, sidebarTrip: { innerHTML: '' },
    view: { innerHTML: '' }, toast: { textContent: '', className: '' },
    sheetBackdrop: { hidden: true }, sheet: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} },
    planSharePublishError: { hidden: true, textContent: '' },
  };
  const document = {
    activeElement: null,
    body: { style: {} },
    getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
  } as unknown as Document;
  const window = { scrollTo() {} } as unknown as Window & typeof globalThis;
  return { document, window, nodes };
}

test('scheme sharing previews its complete public content and publishes only after confirmation', async () => {
  const previous = {
    fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window,
    currentView: state.currentView, principal: state.principal, savedPlans: state.savedPlans,
    planShares: state.planShares, loadStatus: state.loadStatus, trip: state.trip,
    planSharePreview: state.planSharePreview,
  };
  const sourcePlan = {
    id: 'scheme-own', name: '上海慢慢逛', kind: 'scheme', cityCode: '310100', localDate: '2026-10-10',
    days: [
      { dayIndex: 0, stops: [{ stopId: 's1', status: 'planned', place: { name: '公园', coordinates: { lat: 31.2, lng: 121.4 } }, startMinutes: 540, endMinutes: 600 }] },
      { dayIndex: 1, stops: [] },
      { dayIndex: 2, stops: [{ stopId: 's2', status: 'planned', place: { name: '美术馆', coordinates: { lat: 31.21, lng: 121.41, source: 'amap' } }, startMinutes: 600, endMinutes: 690 }] },
    ],
  };
  const browser = browserHarness();
  let publishedBody: Record<string, any> | undefined;
  state.currentView = 'plan';
  state.principal = { kind: 'account', principalId: 'owner', nickname: '旅人' };
  state.savedPlans = [sourcePlan];
  state.planShares = [];
  state.loadStatus = {};
  state.trip = null;
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  globalThis.fetch = (async (input: string | URL | Request, init = {}) => {
    const url = String(input);
    if (url === '/api/v1/plans' && !init.method) {
      return new Response(JSON.stringify({ data: [sourcePlan] }), { status: 200 });
    }
    if (url === '/api/v1/community/plan-shares' && init.method === 'POST') {
      publishedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: {
        ...publishedBody, id: 'share-own', nickname: '旅人', createdAt: '2026-09-21T00:00:00Z',
      } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    await community.sharePlanToCommunity('scheme-own', { disabled: false });
    assert.equal(Boolean(publishedBody), false, 'opening the preview does not publish');
    assert.match(browser.nodes.sheet.innerHTML, /公开给所有旅人/);
    assert.match(browser.nodes.sheet.innerHTML, /第 2 天/);
    assert.match(browser.nodes.sheet.innerHTML, /公园/);
    assert.doesNotMatch(browser.nodes.sheet.innerHTML, /2026-10-10/);
    const confirm = { dataset: { preview: state.planSharePreview.token }, disabled: false };
    await Promise.all([community.confirmPlanShare(confirm), community.confirmPlanShare(confirm)]);
    const decoded = decodePlanCode(publishedBody?.code);
    assert.equal(publishedBody?.name, sourcePlan.name);
    assert.equal(publishedBody?.localDate, undefined, 'shared candidates stay reusable without a travel date');
    assert.equal(publishedBody?.stopCount, 2);
    assert.deepEqual(decoded.days.map((day: any) => day.stops.length), [1, 0, 1]);
    assert.equal(state.planShares[0].id, 'share-own');
    assert.equal(state.currentView, 'plan', 'publishing returns to the candidate list');
    assert.equal(state.planSharePreview, null);
  } finally {
    if ((globalThis.window as any)?.__toastTimer) clearTimeout((globalThis.window as any).__toastTimer);
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    Object.assign(state, {
      currentView: previous.currentView, principal: previous.principal, savedPlans: previous.savedPlans,
      planShares: previous.planShares, loadStatus: previous.loadStatus, trip: previous.trip,
      planSharePreview: previous.planSharePreview,
    });
  }
});

async function shareEnvironment(run: (plan: any, browser: ReturnType<typeof browserHarness>, bodies: any[]) => Promise<void>) {
  const backup = { ...state }, globals = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
  const browser = browserHarness(); const bodies: any[] = [];
  const plan = { id: 'preview-scheme', name: '<慢慢走>', revision: 1, kind: 'scheme', cityCode: '310100', days: [{ dayIndex: 0, stops: [{ stopId: 'a', status: 'planned', startMinutes: 600, endMinutes: 660, place: { placeId: 'a', name: '<公园>', cityCode: '310100', coordinates: { lat: 31.2, lng: 121.4 } } }] }] };
  Object.assign(state, { currentView: 'plan', principal: { kind: 'account', principalId: 'owner' }, savedPlans: [plan], planShares: [], communityMine: null, loadStatus: {}, trip: null, planSharePreview: null });
  Object.assign(globalThis, { document: browser.document, window: browser.window });
  globalThis.fetch = (async (_input, init = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(String(init.body)); bodies.push(body); return new Response(JSON.stringify({ data: { ...body, id: 'public-share' } })); }
    return new Response(JSON.stringify({ data: [plan] }));
  }) as typeof fetch;
  try { await run(plan, browser, bodies); }
  finally { clearTimeout((globalThis.window as any).__toastTimer); for (const key of Object.keys(state)) if (!(key in backup)) delete state[key]; Object.assign(state, backup); Object.assign(globalThis, globals); }
}

test('canceling a share preview submits nothing and its names are escaped', async () => {
  await shareEnvironment(async (_plan, browser, bodies) => {
    await community.sharePlanToCommunity('preview-scheme');
    assert.match(browser.nodes.sheet.innerHTML, /&lt;慢慢走&gt;/);
    assert.match(browser.nodes.sheet.innerHTML, /&lt;公园&gt;/);
    community.cancelPlanShare();
    assert.equal(state.planSharePreview, null);
    assert.equal(browser.nodes.sheetBackdrop.hidden, true);
    assert.equal(bodies.length, 0);
  });
});

test('a scheme changed after preview is not published and offers a visible error', async () => {
  await shareEnvironment(async (plan, browser, bodies) => {
    await community.sharePlanToCommunity('preview-scheme');
    const preview = state.planSharePreview; plan.revision = 2;
    await assert.rejects(community.confirmPlanShare({ dataset: { preview: preview.token } }), /方案已有变化/);
    assert.equal(bodies.length, 0);
    assert.equal(preview.saving, false);
    assert.equal(browser.nodes.planSharePublishError.hidden, false);
    assert.match(browser.nodes.planSharePublishError.textContent, /尚未发布/);
  });
});

test('switching accounts after preview cannot publish the old account scheme', async () => {
  await shareEnvironment(async (_plan, _browser, bodies) => {
    await community.sharePlanToCommunity('preview-scheme');
    const token = state.planSharePreview.token; state.principal = { kind: 'account', principalId: 'other' };
    await assert.rejects(community.confirmPlanShare({ dataset: { preview: token } }), /账号已切换/);
    assert.equal(bodies.length, 0);
  });
});

test('share cards offer one-step import to candidates without an expanded day preview', () => {
  const previous = { principal: state.principal, planShares: state.planShares };
  state.principal = { kind: 'account', nickname: '旅人' };
  state.planShares = [{
    id: 'share-card', name: '杭州两日', code: encodePlanCode({ name: '杭州两日', cityCode: '330100', cityLabel: '杭州', days: [
      { stops: [{ name: '西湖', coordinates: { lat: 30.25, lng: 120.15 }, durationMinutes: 60 }] },
    ] }),
    stopCount: 1, cityCode: '330100', cityLabel: '杭州', nickname: '同行者', createdAt: '2026-09-21T00:00:00Z',
  }];

  try {
    const html = planSharesView.renderPlanShares();
    assert.match(html, /data-action="import-plan-share" data-share="share-card" aria-label="导入到方案候选"><svg[^>]*>.*<\/svg><span>导入<\/span>/);
    assert.match(html, /data-action="navigate" data-view="plan">去方案候选/);
    assert.doesNotMatch(html, /预览并导入|plan-share-preview|查看 1 天安排/);
  } finally {
    Object.assign(state, previous);
  }
});
