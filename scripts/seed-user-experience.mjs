/** Populate an empty LOCAL application through its normal authenticated APIs and exercise user workflows. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { encodePlanCode } from '../public/lib/plan-code.js';

const base = new URL(process.env.BANTU_TEST_BASE || 'http://127.0.0.1:8787');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'This script only populates a local test application.');
const password = process.env.BANTU_TEST_PASSWORD;
assert.ok(password && password.length >= 8, 'Set BANTU_TEST_PASSWORD explicitly.');
const checks = [];
const checked = (name, value) => { assert.ok(value, name); checks.push(name); };
async function call(actor, path, method = 'GET', body, expected = 200) {
  const response = await fetch(new URL(path, base), {
    method, headers: { 'content-type': 'application/json', ...(actor.cookie ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) actor.cookie = cookie.split(';')[0];
  const payload = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${payload.error?.message || ''}`);
  return payload.data;
}
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = new Date(`${date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
const tomorrowDate = tomorrow.toISOString().slice(0, 10);
const definitions = [
  { username: 'bantu_xiaoai', nickname: '伴途·小艾', interest: '城市散步', places: ['武康大楼', '徐家汇书院'],
    posts: [
      '武康路慢慢走\n今天没有塞满行程，沿街散步，看看建筑细节，再找个地方坐一会儿。拍照时记得给行人留出通道，住宅区域尽量轻声。',
      '把一下午留给书院\n读几页书、记几句话，比打卡更让我放松。下次想把阅读和周边散步放在一起，给每一站留足停留时间。',
    ], notes: ['街角的小发现\n旅行不一定要走很远。今天最喜欢的片段，是慢下来以后注意到的窗框和树影。', '下一次散步清单\n少安排一站，多留一点坐下来休息的时间；出门前再核对开放安排和天气。'] },
  { username: 'bantu_achen', nickname: '伴途·阿辰', interest: '建筑摄影', places: ['武康大楼', '龙美术馆（西岸馆）'],
    posts: [
      '拍建筑时，先看看光\n我更喜欢先绕一圈观察明暗，再决定取景。这里的图片和构图讨论仅作创作参考，实际拍摄位置要服从现场通行和管理要求。',
      '西岸散步的留白\n看完建筑和展览以后，不急着去下一站，沿着步道走一段。展览内容和票务可能变化，出门前会重新确认。',
    ], notes: ['光影观察笔记\n想试试同一个街角在不同时间的色彩变化。拍照之前，先看人流和能否安全停留。', '摄影包里少一点\n带轻便镜头和水，尽量不用器材占用公共通道。比起多拍几张，更想认真看完一个地方。'] },
  { username: 'bantu_xiaohe', nickname: '伴途·小禾', interest: '阅读与文化', places: ['徐家汇书院', '上海公安博物馆'],
    posts: [
      '书院里的安静时刻\n喜欢把参观和阅读分开留时间。书架、展陈和窗边的光都值得慢慢看；可进入的区域和座位情况以现场为准。',
      '看展之后再记两句\n参观结束时写下最想继续了解的主题，下次回来就不会只是重复打卡。开放时间、预约和展览详情还是要提前核对。',
    ], notes: ['想继续读的主题\n城市历史、老建筑保护，以及普通人如何使用公共空间。下一次参观后补上具体书名。', '看展记录方法\n先记录自己的感受，再核对展签中的事实。没有确认的内容，不当作攻略推荐给别人。'] },
  { username: 'bantu_xiaomu', nickname: '伴途·小沐', interest: '轻松看展', places: ['西岸美术馆', '龙美术馆（西岸馆）'],
    posts: [
      '看展也可以很轻松\n这次想给一个展览留足时间，不赶着把所有馆都看完。喜欢的作品多看一会儿，累了就按现场指引找休息区域。',
      '下雨天的备用安排\n如果天气变化，就减少户外停留，把室内参观和休息安排得宽松一些。是否开放、能否预约以及室内设施都需要再确认。',
    ], notes: ['今天的颜色\n最想记住的不是作品数量，而是某个颜色让人放松下来的感觉。下次带一本小笔记本。', '轻装出门提醒\n带水、充电宝和雨具；预约信息单独留好，不把临时变化当作行程失败。'] },
  { username: 'bantu_yifan', nickname: '伴途·一帆', interest: '路线与计划', places: ['徐家汇书院', '武康大楼'],
    posts: [
      '不赶路的一日安排\n先选真正想去的两三个地方，再决定交通方式。站间时间以实际道路查询为准，没有查到的路段就先留作待估。',
      '计划留一点弹性\n出发、到达和完成分别记录，计划中的时间不能当成已经发生的事实。遇到雨天或临时闭馆，先核对影响再调整后续。',
    ], notes: ['安排原则\n每段路线分别确认，午后留一点缓冲；固定预约优先核对，不用直线距离证明一定赶得上。', '下一趟想试试\n少赶一个地方，多留一段沿途闲逛。完成后再整理真正去过的地点和感受。'] },
];
const places = await call({}, '/api/v1/places?limit=50');
const findPlace = name => { const place = places.find(item => item.name === name); assert.ok(place, `Missing directory place: ${name}`); return place; };
for (const definition of definitions) definition.places.forEach(findPlace);
const actors = [];
for (const definition of definitions) {
  const actor = { ...definition, cookie: '' };
  await call(actor, '/api/v1/session/guest', 'POST');
  if (!actors.length) {
    checked('reset: community is empty', (await call(actor, '/api/v1/community/posts')).length === 0);
    checked('reset: plans are empty', (await call(actor, '/api/v1/plans')).length === 0);
    checked('reset: notes are empty', (await call(actor, '/api/v1/memories')).length === 0);
  }
  const registered = await call(actor, '/api/v1/account/register', 'POST', { username: actor.username, password });
  actor.principalId = registered.principalId;
  await call(actor, '/api/v1/me', 'PATCH', { nickname: actor.nickname });
  const me = await call(actor, '/api/v1/me');
  checked(`${actor.username}: account and nickname`, me.username === actor.username && me.nickname === actor.nickname);
  actors.push(actor);
}
for (const actor of actors) {
  actor.selectedPlaces = actor.places.map(findPlace);
  actor.postIds = []; actor.noteIds = [];
  for (const [index, text] of actor.posts.entries()) {
    const place = actor.selectedPlaces[index];
    const post = await call(actor, '/api/v1/community/posts', 'POST', { text, placeRefs: [{ placeId: place.placeId, name: place.name }] });
    checked(`${actor.username}: publish post ${index + 1}`, post.nickname === actor.nickname && post.placeRefs[0].placeId === place.placeId);
    actor.postIds.push(post.id);
  }
  for (const text of actor.notes) {
    const note = await call(actor, '/api/v1/memories', 'POST', { userText: text, localDate: date });
    actor.noteIds.push(note.memoryId);
    checked(`${actor.username}: write note ${actor.noteIds.length}`, note.userText === text && note.localDate === date);
  }
  for (const place of actor.selectedPlaces) await call(actor, '/api/v1/favorites', 'POST', { placeId: place.placeId });
  const firstPlace = actor.selectedPlaces[0];
  await call(actor, `/api/v1/places/${firstPlace.placeId}/note`, 'POST', { note: `${actor.interest}：出发前核对开放安排，参观时留足休息时间。` });
  await call(actor, `/api/v1/places/${firstPlace.placeId}/tags`, 'POST', { customTags: [actor.interest, '下次再来'] });
  await call(actor, `/api/v1/community/places/${firstPlace.placeId}/reviews`, 'POST', { rating: actor.username === 'bantu_achen' ? 4 : 5, text: `适合${actor.interest}，我更喜欢慢慢逛。具体开放、预约和设施请以当前现场信息为准。` });
  const stops = actor.selectedPlaces.map((place, index) => ({
    stopId: `${actor.username}-stop-${index + 1}`, placeId: place.placeId, place,
    status: 'planned', startMinutes: 600 + index * 120, endMinutes: 660 + index * 120,
    plannedDurationMinutes: 60, minDurationMinutes: 30,
  }));
  const scheme = await call(actor, '/api/v1/plans', 'POST', {
    name: `${actor.interest} · 上海半日`, kind: 'scheme', cityCode: '310100', timezone: 'Asia/Shanghai',
    days: [{ dayIndex: 0, stops, routeLegs: [], plannedCharges: [] }],
  });
  actor.schemeId = scheme.id;
  const plan = await call(actor, '/api/v1/plans', 'POST', {
    name: `${actor.interest} · 明日安排`, kind: 'plan', cityCode: '310100', timezone: 'Asia/Shanghai', localDate: tomorrowDate,
    snapshot: { stops, routeLegs: [], plannedCharges: [] },
  });
  actor.planId = plan.id;
  const code = encodePlanCode({ name: scheme.name, cityCode: '310100', cityLabel: '上海', days: [{ stops: actor.selectedPlaces.map(place => ({ name: place.name, coordinates: place.coordinates, durationMinutes: 60, cityCode: '310100' })) }] });
  const share = await call(actor, '/api/v1/community/plan-shares', 'POST', { name: scheme.name, cityCode: '310100', code, stopCount: stops.length });
  actor.shareId = share.id;
  checked(`${actor.username}: plan, reusable scheme and share`, plan.stops.length === 2 && scheme.days[0].stops.length === 2 && share.nickname === actor.nickname);
}
for (const [index, actor] of actors.entries()) {
  const next = actors[(index + 1) % actors.length];
  const other = actors[(index + 2) % actors.length];
  for (const owner of [next, other]) {
    const liked = await call(actor, `/api/v1/community/posts/${owner.postIds[0]}/like`, 'POST');
    checked(`${actor.username}: like ${owner.username}`, liked.liked);
  }
  await call(actor, `/api/v1/community/posts/${next.postIds[0]}/favorite`, 'POST');
  const commented = await call(actor, `/api/v1/community/posts/${next.postIds[0]}/comments`, 'POST', { text: `喜欢你这个节奏！我偏爱${actor.interest}，下次也想给这一站多留一点时间。` });
  const comment = commented.comments.at(-1);
  const replied = await call(next, `/api/v1/community/posts/${next.postIds[0]}/comments`, 'POST', { text: '可以呀，出发前一起确认开放安排和路线，给临时变化留些余地。', parentCommentId: comment.id });
  checked(`${actor.username}: comment and reply`, comment.nickname === actor.nickname && replied.comments.at(-1).parentCommentId === comment.id);
}
const [a, b] = actors;
await call(b, `/api/v1/memories/${a.noteIds[0]}`, 'GET', undefined, 404);
await call(b, `/api/v1/memories/${a.noteIds[0]}`, 'PATCH', { userText: '不能写入他人的笔记' }, 404);
await call(b, `/api/v1/memories/${a.noteIds[0]}`, 'DELETE', undefined, 404);
await call(b, `/api/v1/community/posts/${a.postIds[0]}`, 'DELETE', undefined, 400);
checked('private notes and posts reject cross-account mutation', (await call(a, `/api/v1/memories/${a.noteIds[0]}`)).userText === a.notes[0]);
await call(a, '/api/v1/community/posts', 'POST', { text: ' ' }, 400);
await call(a, '/api/v1/memories', 'POST', { userText: ' ' }, 400);
checked('empty posts and notes are rejected', true);
const temporary = await call(a, '/api/v1/memories', 'POST', { userText: '临时生命周期验证\n创建后修改，再删除。' });
const edited = await call(a, `/api/v1/memories/${temporary.memoryId}`, 'PATCH', { userText: '修改验证\n这是一条随后删除的临时笔记。' });
checked('note edit saved', edited.entryVersion === temporary.entryVersion + 1);
await call(a, `/api/v1/memories/${temporary.memoryId}`, 'DELETE');
await call(a, `/api/v1/memories/${temporary.memoryId}`, 'GET', undefined, 404);
checked('note deletion removes access', true);
const tempPost = await call(a, '/api/v1/community/posts', 'POST', { text: '临时发帖与撤回验证；验证后不保留在社区。' });
await call(b, `/api/v1/community/posts/${tempPost.id}/favorite`, 'POST');
await call(a, `/api/v1/community/posts/${tempPost.id}`, 'DELETE');
await call(a, `/api/v1/community/posts/${tempPost.id}`, 'GET', undefined, 404);
const snapshots = await call(b, '/api/v1/community/post-favorites');
checked('withdrawal retains an explicit withdrawn favorite snapshot', snapshots.some(item => item.post.postId === tempPost.id && item.post.source === 'withdrawn'));
await call(b, `/api/v1/community/posts/${tempPost.id}/favorite`, 'DELETE');
for (const actor of actors) {
  const revokedCookie = actor.cookie;
  await call(actor, '/api/v1/session', 'DELETE');
  await call({ cookie: revokedCookie }, '/api/v1/me', 'GET', undefined, 401);
  await call(actor, '/api/v1/account/login', 'POST', { username: actor.username, password });
  checked(`${actor.username}: re-login preserves private notes`, (await call(actor, '/api/v1/memories')).length === 2);
  checked(`${actor.username}: re-login preserves favorites`, (await call(actor, '/api/v1/favorites')).length === 2);
}
const publicPosts = await call(a, '/api/v1/community/posts?limit=50');
checked('all public display names use the Bantu naming convention', publicPosts.every(post => /^伴途·/.test(post.nickname) && post.comments.every(comment => /^伴途·/.test(comment.nickname))));
const manifest = {
  date, base: base.origin, checks,
  users: actors.map(({ cookie, posts, notes, selectedPlaces, ...actor }) => actor),
  counts: { users: actors.length, posts: publicPosts.length, comments: publicPosts.reduce((n, post) => n + post.commentCount, 0), likes: publicPosts.reduce((n, post) => n + post.likes, 0), privateNotes: 10, schemes: 5, datedPlans: 5, planShares: 5 },
};
writeFileSync('data/test-users-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ checks: checks.length, counts: manifest.counts, accounts: actors.map(actor => ({ username: actor.username, nickname: actor.nickname })) }, null, 2));
