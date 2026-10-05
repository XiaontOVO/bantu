import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

test('plan edits reject duplicate stop ids when one is an executed fact', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T08:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { headers: { cookie, 'content-type': 'application/json' },
        method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json() as { data: any }).data;
    };
    const created = await call('/api/v1/trips', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    const path = `/api/v1/trips/${created.trip.tripId}`;
    const initial = await call(path + '/initial-plans', {});
    await call(path + '/messages', { text: '确认应用方案一', proposalId: initial.proposal.proposalId });
    const stopId = (await call(path)).snapshot.stops[0].stopId;
    await call(path + '/execution-events', { stopId, type: 'complete', occurredAt: '2026-09-20T08:00:00+08:00' });
    const live = await call(path);
    // A malformed edit must not erase or merge an already completed execution fact.
    const rejected = await fetch(base + path + '/plan-edits', { headers: { cookie, 'content-type': 'application/json' },
      method: 'POST', body: JSON.stringify({ expectedRevision: live.trip.revision, allowPast: true,
        stops: [live.snapshot.stops[0], { ...structuredClone(live.snapshot.stops[0]), status: 'planned' }] }) });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'EXECUTION_FACT_PROTECTED');
    const patched = await call(path);
    const sameId = patched.snapshot.stops.filter((stop: { stopId: string }) => stop.stopId === stopId);
    assert.equal(sameId.length, 1, '同一 stopId 只保留一条');
    assert.equal(sameId[0].status, 'completed', '保留的应是进度事实');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('plan snapshots keep only the most recent five versions with monotonic revisions', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T08:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { headers: { cookie, 'content-type': 'application/json' },
        method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json() as { data: any }).data;
    };
    const created = await call('/api/v1/trips', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    const path = `/api/v1/trips/${created.trip.tripId}`;
    const initial = await call(path + '/initial-plans', {});
    await call(path + '/messages', { text: '确认应用方案一', proposalId: initial.proposal.proposalId });
    // v1 之后连续编辑 7 次 → 共 8 个版本，窗口里应只剩最近 5 个（第 4–8 版）。
    for (let index = 0; index < 7; index += 1) {
      const live = await call(path);
      const stops = structuredClone(live.snapshot.stops);
      const lastStop = stops.at(-1)!;
      lastStop.endMinutes += 5; lastStop.departureMinutes += 5; lastStop.plannedDurationMinutes += 5;
      await call(path + '/plan-edits', { expectedRevision: live.trip.revision, stops });
    }
    const history = await call(path + '/versions');
    assert.equal(history.length, 5, '只保留最近 5 个快照');
    assert.deepEqual(history.map((version: { revision: number }) => version.revision), [4, 5, 6, 7, 8], '保留的应是最近的版本且 revision 单调');
    assert.equal((await call(path)).trip.revision, 8, '当前版本不受裁剪影响');
    const final = await call(path);
    assert.ok(Array.isArray(final.snapshot.stops) && final.snapshot.stops.length > 0, '当前计划内容完整');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('full plan snapshots survive edits, are owned, and restore through a new proposal', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T08:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { headers: { cookie, 'content-type': 'application/json' },
        method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json() as { data: any }).data;
    };
    const created = await call('/api/v1/trips', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    const path = `/api/v1/trips/${created.trip.tripId}`;
    const initial = await call(path + '/initial-plans', {});
    assert.equal((await call(path)).latestProposalId, initial.proposal.proposalId);
    await call(path + '/messages', { text: '确认应用方案一', proposalId: initial.proposal.proposalId });
    const saved = await call(path + '/versions/1');
    const next = structuredClone(saved.snapshot.stops);
    next[0].endMinutes += 10; next[0].departureMinutes += 10; next[0].plannedDurationMinutes += 10;
    await call(path + '/plan-edits', { expectedRevision: 1, stops: next });
    assert.equal((await call(path)).previousPlanRevision, 1);
    assert.deepEqual(await call(path + '/versions/1'), saved, 'editing must not mutate historical data');
    const restored = await call(path + '/versions/1/proposals', { expectedRevision: 2 });
    assert.equal((await call(path)).trip.revision, 2, 'preview does not apply history');
    assert.equal((await call(path)).latestProposalId, restored.proposal.proposalId);
    const applied = await call(path + '/messages', { text: '确认应用方案一', proposalId: restored.proposal.proposalId });
    assert.equal(applied.execution.status, 'succeeded');
    assert.equal((await call(path)).trip.revision, 3);
    assert.deepEqual((await call(path + '/versions/3')).snapshot.stops, saved.snapshot.stops);
    await call(path + '/start', { expectedRevision: 3 });
    assert.equal((await call(path)).previousPlanRevision, 2, 'starting travel does not add a plan-change shortcut');
    await call(path + '/execution-events', { stopId: saved.snapshot.stops[0].stopId, type: 'complete', occurredAt: '2026-09-20T08:00:00+08:00' });
    const live = await call(path);
    // 快照只保留最近 5 个：动态取最早保留的版本作为历史锚点，不假设具体版本号。
    const retained = await call(path + '/versions');
    assert.ok(retained.length <= 5, '快照最多保留最近 5 个');
    const oldestRevision = retained[0].revision;
    const protectedRestore = await call(path + `/versions/${oldestRevision}/proposals`, { expectedRevision: live.trip.revision });
    assert.deepEqual(protectedRestore.proposal.candidates[0].snapshot.stops[0], live.snapshot.stops[0], 'history reuse preserves actual progress');
    const confirmedRestore = await call(path + '/messages', { text: '确认应用方案一', proposalId: protectedRestore.proposal.proposalId });
    assert.equal(confirmedRestore.execution.status, 'succeeded');
    const afterRestore = await call(path);
    assert.equal(afterRestore.trip.revision, live.trip.revision + 1);
    assert.deepEqual(afterRestore.snapshot.stops[0], live.snapshot.stops[0], 'confirmed restore preserves the completed stop');
    assert.deepEqual(afterRestore.snapshot.executionEvents, live.snapshot.executionEvents, 'confirmed restore preserves actual execution history');
    // 所有写入结束后再取锚点：恢复确认可能裁掉更早的快照，GET 自身不能改写历史。
    const finalRetained = await call(path + '/versions');
    assert.ok(finalRetained.length <= 5, '快照最多保留最近 5 个');
    const finalOldest = finalRetained[0].revision;
    assert.deepEqual(await call(path + `/versions/${finalOldest}`), await call(path + `/versions/${finalOldest}`), 'progress must not mutate past snapshots');
    const stranger = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const forbidden = await fetch(base + path + `/versions/${finalOldest}`, { headers: { cookie: stranger.headers.get('set-cookie')!.split(';')[0] } });
    assert.equal(forbidden.status, 404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
