/** Run after restarting the local server: verify the new accounts, API data and cleared old snapshots. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('data/test-users-manifest.json', 'utf8'));
const browser = JSON.parse(readFileSync('data/test-users-ui-report.json', 'utf8'));
const base = new URL(manifest.base);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
const password = process.env.BANTU_TEST_PASSWORD;
assert.ok(password && password.length >= 8);
const db = new DatabaseSync('data/bantu-state.sqlite', { readOnly: true });
const readState = suffix => JSON.parse(db.prepare('SELECT value FROM app_state WHERE key = ?').get(`bantu-trip-service:${suffix}`).value);
let accounts, community, memories, plans;
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  accounts = readState('accounts'); community = readState('community'); memories = readState('personal-memories'); plans = readState('plan-library');
  assert.deepEqual(accounts.map(account => account.username).sort(), manifest.users.map(user => user.username).sort(), 'only the five new accounts remain');
  assert.deepEqual(accounts.map(account => account.nickname).sort(), manifest.users.map(user => user.nickname).sort());
} finally { db.close(); }
for (const file of ['data/bantu-sandbox.sqlite', 'data/bantu-state-before-post-cleanup-20260921-092515.sqlite']) {
  const backup = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM app_state').get().count, 0, 'old backup contains no user snapshots'); }
  finally { backup.close(); }
}
const names = new Set(manifest.users.map(user => user.nickname));
assert.equal(community.posts.length, 11);
assert.ok(community.posts.every(post => names.has(post.nickname) && post.comments.every(comment => names.has(comment.nickname))));
assert.ok(Object.values(community.placeReviews).flat().every(review => names.has(review.nickname)));
const experienceOwners = new Set(manifest.users.map(user => user.principalId));
const experiencePlans = plans.filter(plan => experienceOwners.has(plan.ownerId || plan.actorId));
assert.equal(experiencePlans.filter(plan => plan.kind === 'scheme').length, 5);
assert.equal(experiencePlans.filter(plan => plan.kind === 'plan').length, 6);
for (const user of manifest.users) assert.ok([user.schemeId, user.planId].every(id => experiencePlans.some(plan => plan.id === id)), 'seeded plans are retained');
const noteCount = Object.values(memories).reduce((n, notes) => n + notes.length, 0);
assert.equal(noteCount, 12);
const checks = [];
for (const user of manifest.users) {
  let cookie = '';
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(new URL(path, base), { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
    const payload = await response.json(); assert.equal(response.status, 200, `${path}: ${payload.error?.message || ''}`); return payload.data;
  };
  const profile = await call('/api/v1/account/login', 'POST', { username: user.username, password });
  assert.equal(profile.nickname, user.nickname);
  const sessionProfile = await call('/api/v1/me');
  assert.equal(sessionProfile.principalId, user.principalId);
  assert.equal(sessionProfile.kind, 'account');
  assert.ok(Date.parse(sessionProfile.expiresAt) > Date.now(), 'running server returns the current valid session deadline');
  assert.ok(!['token', 'tokenHash', 'hash', 'salt'].some(field => field in sessionProfile), 'profile exposes no credentials');
  const notes = await call('/api/v1/memories');
  assert.equal(notes.length, user.username === 'bantu_xiaoai' ? 4 : 2);
  assert.ok(user.noteIds.every(id => notes.some(note => note.memoryId === id)));
  assert.equal((await call('/api/v1/favorites')).length, 2);
  assert.equal((await call('/api/v1/community/post-favorites')).length, 1);
  const ownPlans = await call('/api/v1/plans');
  const history = await call('/api/v1/plans/history');
  const allOwnPlans = [...ownPlans, ...history];
  assert.equal(allOwnPlans.length, user.username === 'bantu_xiaoai' ? 3 : 2, 'original plans remain in active or historical storage');
  assert.equal(new Set(allOwnPlans.map(plan => plan.id)).size, allOwnPlans.length, 'a plan is never duplicated between active and history');
  assert.ok([user.schemeId, user.planId].every(id => allOwnPlans.some(plan => plan.id === id)), 'each original plan remains accessible to its owner');
  if (user.username === 'bantu_xiaoai') {
    const completed = ownPlans.find(plan => plan.id === browser.completedPlanId)
      || await call(`/api/v1/plans/${browser.completedPlanId}/history`);
    assert.equal(completed.stops[0].status, 'completed');
    assert.ok(notes.some(note => note.sourcePlanId === browser.completedPlanId));
    const post = await call(`/api/v1/community/posts/${browser.userPostId}`);
    assert.equal(post.images.length, 1);
    const image = await fetch(new URL(`/api/v1/community/posts/${post.id}/images/${post.images[0].id}`, base), { headers: { cookie } });
    assert.equal(image.status, 200); assert.ok((await image.arrayBuffer()).byteLength > 1000);
  }
  const catalog = await call('/api/v1/places?limit=50');
  assert.ok(catalog.every(place => place.reviews.every(review => names.has(review.nickname))));
  assert.ok(catalog.every(place => place.demoReviews.length === 0));
  await call('/api/v1/session', 'DELETE');
  checks.push(`${user.username}: password login, owned session expiry, notes, favorites, active/history plans and clean reviews persisted after restart`);
}
const report = {
  verified: true, checkedAt: new Date().toISOString(), checks,
  counts: { accounts: accounts.length, posts: community.posts.length, notes: noteCount, comments: community.posts.reduce((n, post) => n + post.comments.length, 0), likes: community.posts.reduce((n, post) => n + post.likedBy.length, 0), placeReviews: Object.values(community.placeReviews).flat().length, schemes: experiencePlans.filter(plan => plan.kind === 'scheme').length, datedPlans: experiencePlans.filter(plan => plan.kind === 'plan').length, planShares: community.planShares.length },
  otherPlansRetained: plans.length - experiencePlans.length,
  planRetention: { active: experiencePlans.filter(plan => !plan.historyArchivedAt).length, history: experiencePlans.filter(plan => plan.historyArchivedAt).length },
  uiFlows: browser.flows.length, apiChecks: manifest.checks.length,
  oldBackupUserSnapshots: 0, screenshots: browser.output,
};
writeFileSync('data/test-users-final-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
