import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const history = await load('public/lib/plan-history.js');
const { renderPlanHistory } = await load('public/views/plan-history.js');
const { renderMemories } = await load('public/views/memories.js');

test('changed historical facts leave personal feelings editable and link to the updated record', () => {
  const backup = { ...state };
  try {
    Object.assign(state, { principal: { kind: 'account', username: 'history-reader' }, trip: null,
      memoriesScope: 'all+personal:history-reader', loadStatus: {}, memories: [{ memoryId: 'original-note', sourcePlanId: 'old-plan',
        type: 'note', userText: '原感受\n那天很开心。', staleAt: '2026-09-20T10:00:00Z', createdAt: '2026-09-19T10:00:00Z',
        journey: { cityCode: '310100', localDate: '2026-09-19', timezone: 'Asia/Shanghai', places: [{ name: '原地点' }], elapsedMinutes: null } }] });
    const html = renderMemories();
    assert.match(html, /原日计划的进度已更新/);
    assert.match(html, /data-action="view-plan-history" data-plan="old-plan"/);
    assert.doesNotMatch(html, /<button[^>]*data-action="edit-memory"[^>]*disabled/);
    assert.match(html, /<button[^>]*data-action="share-memory"[^>]*disabled/);
    assert.match(html, /那天很开心/);
  } finally { Object.assign(state, backup); }
});

test('history detail shows original and corrected timestamps while readonly records offer no live or edit action', () => {
  const backup = { ...state };
  try {
    Object.assign(state, { planHistoryId: 'old', planHistoryError: '', planHistoryDetail: { id: 'old', name: '<原记录>', localDate: '2026-09-19', timezone: 'Asia/Shanghai', cityCode: '310100', canEditHistory: false,
      stops: [{ stopId: 'a', place: { name: '<展馆>' }, status: 'completed', startMinutes: 600, endMinutes: 660 }], executionEvents: [
        { executionEventId: 'e', stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', recordedAt: '2026-09-19T11:01:00+08:00' },
        { executionEventId: 'fix', correctsEventId: 'e', stopId: 'a', type: 'complete', statusOverride: 'completed', correctionReason: '<真实时间>', occurredAt: '2026-09-19T11:10:00+08:00', recordedAt: '2026-09-20T10:00:00+08:00' },
      ], versions: [] } });
    const html = renderPlanHistory();
    assert.match(html, /已被纠正/); assert.match(html, /记录于/); assert.match(html, /发生于/);
    assert.match(html, /未记录实际到达时间/); assert.match(html, /已超过补记期限/);
    assert.match(html, /&lt;原记录&gt;/); assert.match(html, /&lt;真实时间&gt;/);
    assert.doesNotMatch(html, /data-action="(?:backfill-plan-history|correct-plan-history|record-execution|companion-exec)"/);
    state.planHistoryDetail.canEditHistory = true; state.planHistoryDetail.historyEditUntilDate = '2026-10-19';
    assert.match(renderPlanHistory(), /data-action="correct-plan-history"/);
  } finally { Object.assign(state, backup); }
});

test('late history loading cannot replace another account or another selected date', async () => {
  const backup = { ...state }, fetchBackup = globalThis.fetch;
  try {
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    Object.assign(state, { principal: { principalId: 'first' }, planHistoryId: '', planHistory: [] });
    const pending = history.loadPlanHistory();
    state.principal = { principalId: 'second' }; state.planHistory = [{ id: 'second-only' }];
    finish(new Response(JSON.stringify({ data: [{ id: 'private-first' }], meta: {} }))); await pending;
    assert.deepEqual(state.planHistory, [{ id: 'second-only' }]);
    state.planHistoryId = 'old-a'; const detail = history.loadPlanHistory();
    state.planHistoryId = 'old-b'; state.planHistoryDetail = { id: 'old-b' };
    finish(new Response(JSON.stringify({ data: { id: 'old-a' } }))); await detail;
    assert.equal(state.planHistoryDetail.id, 'old-b');
  } finally { Object.assign(state, backup); globalThis.fetch = fetchBackup; }
});
