import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { loadAchievements, ownedAchievements } = await load('public/lib/achievements.js');
const { renderAchievements } = await load('public/views/achievements.js');

test('late achievement requests cannot replace a new account or a newer response', async () => {
  const backup = { ...state }, oldFetch = globalThis.fetch;
  const waiting: ((value: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => waiting.push(resolve))) as typeof fetch;
  const reply = (count: number) => new Response(JSON.stringify({ data: { cards: [], summary: { visitCount: count } } }));
  try {
    Object.assign(state, { principal: { principalId: 'first' }, accountContextChanged: false, achievements: null });
    const a = loadAchievements(); state.principal = { principalId: 'second' };
    waiting.shift()!(reply(8)); await assert.rejects(a, /账号已切换/); assert.equal(ownedAchievements(), null);
    const b = loadAchievements(), c = loadAchievements();
    waiting.pop()!(reply(3)); await c; waiting.shift()!(reply(1)); await b;
    assert.equal(ownedAchievements().summary.visitCount, 3);
    state.principal = { principalId: 'third' }; assert.equal(ownedAchievements(), null);
    assert.doesNotMatch(renderAchievements(), /次相遇/);
  } finally { Object.assign(state, backup); globalThis.fetch = oldFetch; }
});

test('empty and error collection distinguish progress from loading and provide recovery without fabricated cards', () => {
  const backup = { ...state };
  try {
    Object.assign(state, { principal: { principalId: 'owner' }, achievementsOwner: 'owner', achievements: { summary: { placeCount: 0, visitCount: 0, shiningCount: 0 }, cards: [], milestones: [] }, achievementFilter: 'all' });
    assert.match(renderAchievements(), /你的第一张卡/);
    assert.doesNotMatch(renderAchievements(), /class="achievement-card /);
    state.achievements = null; state.loadStatus = { achievements: { status: 'error' } };
    assert.match(renderAchievements(), /收藏册暂时未加载/);
  } finally { Object.assign(state, backup); }
});
