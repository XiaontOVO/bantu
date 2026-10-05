import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { CommunityService } from '../src/services/community-service.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { encodePlanCode } = await import(pathToFileURL(join(process.cwd(), 'public', 'lib', 'plan-code.js')).href) as {
  encodePlanCode: (plan: unknown) => string;
};

function encodeUncheckedPlanPayload(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=+$/, '');
  let sum = 0;
  for (const char of body) sum += char.charCodeAt(0);
  const checksum = (sum % 1296).toString(36).toUpperCase().padStart(2, '0');
  return `BT1-${body}-${checksum}`;
}

test('community discovery, reviews, review permissions, official collection and persistence form one flow', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'review-secret' });
  const start = async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await start();
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  // 社区写操作只对账号开放：注册游客会话后使用换发的会话 cookie。
  const account = async (name: string) => {
    const cookie = await guest();
    const response = await fetch(base + '/api/v1/account/register', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'password123' }) });
    assert.equal(response.status, 200, `注册账号 ${name} 应成功`);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  try {
    const owner = await account('flow_owner'); const visitor = await account('flow_visitor');
    const call = async (path: string, cookie: string, body?: unknown, token?: string) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(token ? { 'x-community-admin-token': token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json() as any) };
    };
    const post = await call('/api/v1/community/places', owner, { name: '桥边小庭院', nickname: '小鹿', cityCode: '330100', address: '沿河步道入口', description: '安静的小庭院，适合短暂休息。', officialTagIds: ['nature', 'photo'], customTags: ['安静', '安静'], lat: 30.25, lng: 120.15, coordinateCrs: 'GCJ02' });
    assert.equal(post.status, 200); const id = post.data.id; const path = '/api/v1/community/places/' + id;
    assert.deepEqual(post.data.tags.map((tag: any) => tag.label), ['自然风光', '拍照打卡', '安静']);
    assert.equal((await call('/api/v1/community/places?tag=photo', visitor)).data.length, 0, '未审核分享不出现在公共推荐列表');
    assert.equal((await call('/api/v1/community/places?tag=food', visitor)).data.length, 0);
    assert.equal((await call(path, visitor)).status, 404, '未审核地点不能通过详情链接公开查看');
    assert.equal((await call(path, owner)).data.status, 'shared', '发布者仍能查看自己的未审核分享');
    const tagPath = `/api/v1/places/${id}/tags`;
    assert.deepEqual((await call(tagPath, owner)).data.customTags, ['安静']);
    assert.equal((await call(tagPath, visitor, { customTags: ['日落很美'] })).status, 404, '未审核地点不能被其他人标注');
    await call(tagPath, owner, { customTags: [] });
    assert.deepEqual((await call(tagPath, owner)).data.customTags, []);
    assert.equal((await call(tagPath, visitor)).status, 404, '未审核地点标签对其他人不可见');
    assert.deepEqual((await call(path, owner)).data.tags.filter((tag: any) => tag.source === 'official').map((tag: any) => tag.id), ['nature', 'photo'], 'user tags cannot modify official classifications');
    assert.equal((await call(tagPath, owner, { customTags: ['很'.repeat(21)] })).status, 400);
    assert.equal((await call(path + '/reviews', owner, { nickname: '自己', rating: 5, text: '自己打分' })).status, 400);
    assert.equal((await call(path + '/reviews', visitor, { nickname: '路人', rating: 4, text: '环境很安静。' })).status, 400, '未审核地点暂不接受公开评价');
    assert.equal((await call('/api/v1/favorites', visitor, { placeId: id })).status, 404, '未审核地点不能收藏');
    assert.equal((await call(path + '/submit', visitor, { evidence: '伪造身份' })).status, 400);
    await call(path + '/submit', owner, { evidence: '现场公开到访，步道入口可抵达。' });
    assert.equal((await call(path + '/decision', owner, { decision: 'approved', note: '自己通过' })).status, 403);
    assert.equal((await call('/api/v1/places?query=桥边小庭院', owner)).data.length, 0);
    await call(path + '/decision', visitor, { decision: 'rejected', note: '请补充入口信息。' }, 'review-secret');
    assert.equal((await call(path, owner)).data.status, 'rejected');
    await call(path + '/submit', owner, { evidence: '已补充：入口在桥东侧公开步道。' });
    await call(path + '/decision', visitor, { decision: 'approved', note: '位置与公开可达性已核对。' }, 'review-secret');
    assert.equal((await call('/api/v1/community/places?tag=photo', visitor)).data.length, 1, '审核通过后地点进入公共推荐目录');
    assert.equal((await call(path, visitor)).data.status, 'approved', '审核通过后详情对所有人开放');
    await call(path + '/reviews', visitor, { nickname: '路人', rating: 4, text: '环境很安静。' });
    await call(path + '/reviews', visitor, { nickname: '路人', rating: 3, text: '补充：周末比较热闹。' });
    const rated = (await call(path, owner)).data;
    assert.equal(rated.reviewCount, 1); assert.equal(rated.rating, 3); assert.equal(rated.authorId, undefined);
    const collected = await call('/api/v1/places?query=桥边小庭院', owner);
    const collectedId = collected.data[0].placeId;
    assert.equal(collected.data[0].provider, 'community_reviewed');
    assert.equal(collected.data[0].description, '安静的小庭院，适合短暂休息。', '旅人介绍进入统一地点目录');
    assert.equal(collected.data[0].suggestedDurationMinutes, null, '未提供的建议时长不伪装为已核实资料');
    assert.ok(Math.abs(collected.data[0].coordinates.lat - 30.252314) < 0.00001, 'GCJ-02 坐标在收录时转换为 WGS-84');
    assert.ok(Math.abs(collected.data[0].coordinates.lng - 120.145280) < 0.00001, 'GCJ-02 经度在收录时转换为 WGS-84');
    assert.equal(collected.data[0].reviews.length, 1, '审核通过后的评价进入统一地点目录');
    assert.equal(collected.data[0].reviews[0].rating, 3);
    const saved = await call('/api/v1/favorites', visitor, { placeId: collectedId });
    assert.equal(saved.status, 200, '审核通过地点可以像官方地点一样收藏');
    assert.equal(saved.data[0].place.description, '安静的小庭院，适合短暂休息。');
    // 收录后地点获得 10 位坐标 ID（不再沿用分享时的 community_ 临时 ID）。
    assert.match(collectedId, /^\d{14}$/, '收录地点应分配 14 位坐标 ID');
    assert.equal((await call(`/api/v1/places/${collectedId}`, owner)).data.reviews[0].rating, 3, '地点详情保留收录前评价');
    await call(path + '/reviews', visitor, { nickname: '路人', rating: 2, text: '收录后补充评价。' });
    assert.equal((await call('/api/v1/places?query=桥边小庭院', owner)).data[0].reviews[0].rating, 2, '从旧分享入口更新的评价同步到目录');
    assert.equal((await call(`/api/v1/places/${collectedId}/tags`, visitor, { customTags: ['晨跑路线'] })).status, 200);
    assert.equal((await call(`/api/v1/places/${collectedId}`, owner)).data.tags.some((tag: any) => tag.label === '晨跑路线'), false, '自定义标签只对添加者可见');
    const taggedSearch = await call('/api/v1/places?query=' + encodeURIComponent('晨跑路线'), owner);
    assert.equal(taggedSearch.data.some((place: any) => place.placeId === collectedId), false, '搜索结果不能暴露其他人的自定义标签');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store }); base = await start();
    const restored = await call(path, owner);
    assert.equal(restored.data.status, 'approved'); assert.equal(restored.data.reviewCount, 1); assert.equal(restored.data.rating, 2);
    assert.ok(!restored.data.tags.some((tag: any) => tag.label === '日落很美'), '审核前被拒绝的标签不能进入公开目录');
    assert.equal((await call(`/api/v1/places/${collectedId}`, owner)).data.tags.some((tag: any) => tag.label === '晨跑路线'), false, '重启后也不能向地点所有者暴露访客的自定义标签');
    assert.deepEqual((await call(`/api/v1/places/${collectedId}/tags`, visitor)).data.customTags, ['晨跑路线']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('legacy approved community locations stay off the map until their owner verifies coordinates', () => {
  const service = new CommunityService();
  service.loadSerialized(JSON.stringify({
    discoveries: [{
      id: 'community_legacy', placeId: '12143603120601', authorId: 'legacy_owner', nickname: '旧用户',
      name: '旧收录地点', cityCode: '310100', address: '待核对地址', description: '历史数据',
      lat: 31.20443, lng: 121.438278, createdAt: '2026-01-01T00:00:00.000Z',
      status: 'approved', evidence: '旧证据', decisionNote: '已通过',
      reviews: [], sample: false, reports: [],
    }],
    posts: [], contributions: {},
  }));

  assert.equal(service.approvedPlaces()[0].coordinates, null, '未知坐标系不应作为地图点输出');
  assert.equal(service.detail('community_legacy', 'legacy_owner').coordinateNeedsVerification, true);
  const pending = service.submit('community_legacy', 'legacy_owner', {
    lat: 31.20443, lng: 121.438278, coordinateCrs: 'GCJ02', evidence: '重新核对坐标',
  });
  assert.equal(pending.status, 'pending', '核验后的坐标重新进入审核');
  assert.equal(service.approvedPlaces().length, 0, '重新审核期间不继续显示旧坐标');
});

test('multi-day schemes with dated and empty days can be shared; server validates code and displayed metadata', () => {
  const service = new CommunityService();
  const name = '杭州三日慢游';
  const cityCode = '330100';
  const cityLabel = '杭州';
  const localDate = '2026-10-03';
  const code = encodePlanCode({
    name, cityCode, cityLabel, localDate,
    days: [
      { stops: [{ name: '湖边休息点', coordinates: { lat: 30.25, lng: 120.15 }, durationMinutes: 60 }] },
      { stops: [] },
      { stops: [{ name: '城市博物馆', coordinates: { lat: 30.26, lng: 120.14 }, durationMinutes: 80 }] },
    ],
  });
  const metadata = { code, name, cityCode, cityLabel, localDate, stopCount: 2, nickname: '慢行者' };

  const share = service.publishPlanShare('author', metadata);
  assert.equal(share.localDate, localDate, '多日方案分享后保留行程起始日期');
  assert.equal(share.stopCount, 2);
  assert.throws(() => service.publishPlanShare('another', { ...metadata, code: 'BT1-invalid' }), /方案码/);
  assert.throws(() => service.publishPlanShare('another', { ...metadata, name: '伪造的方案标题' }), /不一致/);
  assert.throws(() => service.publishPlanShare('another', { ...metadata, stopCount: 99 }), /不一致/);
  assert.throws(() => service.publishPlanShare('another', { ...metadata, localDate: '2026-10-04' }), /不一致/);
  const emptyCode = encodeUncheckedPlanPayload({ v: 2, n: name, c: cityCode, cn: cityLabel, days: [{ s: [] }, { s: [] }] });
  assert.throws(() => service.publishPlanShare('another', { ...metadata, code: emptyCode, localDate: undefined, stopCount: 0 }), /至少需要一个有效地点/);
});
