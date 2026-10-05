import { tagChips, tagOptions, splitTags } from './place-tags.js';
import { newClientId } from './client-id.js';
import { CITIES } from './cities.js';
import { api } from './api.js';
import { $, state } from './store.js';
import { capturePostFeedAnchor } from './post-feed.js';
import { cityName, escapeHtml, fmt, placeIdHtml } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { navigate, render } from './render.js';
import { loadCommunity, loadPlaces } from './loaders.js';
import { loadPlans } from './plan-library.js';
import { refreshPlaceDetailAfterMutation } from './place-detail.js';
import { findPlace } from './favorites.js';
import { encodePlanCode, decodePlanCode, createImportedStopIdFactory } from './plan-code.js';
import { buildImportedStops, buildImportedSchemeDays } from './plan-import.js';
import { openAccount } from './account.js';
import { replacePostFavorites } from './favorites.js';
import { COMMUNITY_STATUS } from '../views/community.js';
import { uiIcon } from './icons.js';
import { buttonContent } from './button-content.js';
import { captureCommentSubmission, clearSubmittedComment, reportCommentFailure } from './comment-drafts.js';
import { beginPostInteraction, isCurrentPostInteraction, finishPostInteraction } from './post-interaction.js';

const field = (id, label, value = '', type = 'text') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${escapeHtml(String(value ?? ''))}"></div>`;
const coordinateCrsField = (id, selected = 'GCJ02') => `<div class="field"><label for="${id}">坐标系</label><select id="${id}"><option value="GCJ02" ${selected === 'GCJ02' ? 'selected' : ''}>GCJ-02（高德/腾讯，推荐）</option><option value="WGS84" ${selected === 'WGS84' ? 'selected' : ''}>WGS-84（GPS）</option><option value="BD09" ${selected === 'BD09' ? 'selected' : ''}>BD-09（百度）</option></select></div>`;
const heading = (text) => `<div class="sheet-head"><h3>${escapeHtml(text)}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>`;
const nicknameDefault = () => state.principal?.nickname || state.principal?.username || '';
const isLoggedIn = () => state.principal?.kind === 'account';
const hasShareCoordinates = stop => Number.isFinite(stop?.place?.coordinates?.lat) && Number.isFinite(stop?.place?.coordinates?.lng);
const encodePlanStop = stop => {
  const start = stop.startMinutes ?? stop.plannedStartMinutes ?? stop.plannedArrivalMinutes;
  const end = stop.endMinutes ?? stop.plannedDepartureMinutes ?? stop.departureMinutes;
  const durationMinutes = Number.isFinite(start) && Number.isFinite(end)
    ? end - start
    : stop.plannedDurationMinutes ?? stop.minDurationMinutes ?? 60;
  return {
    ...(stop.place?.placeId || stop.placeId ? { placeId: stop.place?.placeId || stop.placeId } : {}),
    name: stop.place?.name || '待确认地点',
    coordinates: stop.place.coordinates,
    ...( /^\d{6}$/.test(String(stop.place?.cityCode || '')) && stop.place.cityCode !== '000000' ? { cityCode: stop.place.cityCode } : {}),
    durationMinutes,
    ...(Number.isInteger(start) ? { startMinutes: start } : {}),
  };
};

async function resolveShareStopCity(stop) {
  const existingCode = /^\d{6}$/.test(String(stop?.place?.cityCode || '')) && stop.place.cityCode !== '000000' ? stop.place.cityCode : '';
  const placeId = stop?.place?.placeId || stop?.placeId;
  if (!placeId) return existingCode;
  try {
    const place = await api(`/api/v1/places/${encodeURIComponent(placeId)}`);
    if (/^\d{6}$/.test(String(place?.cityCode || '')) && place.cityCode !== '000000') {
      stop.place = { ...(stop.place || {}), cityCode: place.cityCode };
      return place.cityCode;
    }
  } catch { /* The server also resolves old place records from their coordinates. */ }
  return existingCode;
}
/** 发布身份只展示账号资料，不在互动表单中收集昵称。 */
const publicationIdentity = () => isLoggedIn()
  ? `<p class="stop-meta">将以「${escapeHtml(nicknameDefault())}」发布（「我的」页可修改社区昵称）</p>`
  : '';
const replacePost = (updated) => {
  for (const list of [state.communityPosts, state.communityMine?.posts]) {
    if (!Array.isArray(list)) continue;
    const index = list.findIndex((post) => post.id === updated.id);
    if (index >= 0) list[index] = updated;
  }
  if (state.postDetailId === updated.id) state.postDetail = updated;
  if (state.favoritePostDetails?.[updated.id]) state.favoritePostDetails[updated.id] = updated;
};
let busy = false;
// 社区写操作只对账号开放；游客点击任何社区按钮时直接亮出登录面板。
function requireLogin() {
  if (state.principal?.kind === 'account') return true;
  openAccount('社区需登录后使用：登录或注册后即可发帖、评价、点赞与分享方案。');
  return false;
}
async function mutate(button, work) {
  if (busy) return;
  if (!requireLogin()) return;
  busy = true; if (button) button.disabled = true;
  try { await work(); } finally { busy = false; if (button) button.disabled = false; }
}
export async function openDiscovery() {
  if (!requireLogin()) return;
  if (!state.officialTags) {
    try { state.officialTags = await api('/api/v1/place-tags'); }
    catch { state.officialTags = []; }
  }
  openSheet(`${heading('推荐地点')}${field('discoveryName','地点名称', state.placeQuery || '')}${publicationIdentity()}
    <div class="field"><label for="discoveryCity">城市</label><select id="discoveryCity">${CITIES.map(city => `<option value="${city.code}" ${city.code === state.placeCity ? 'selected' : ''}>${city.name}</option>`).join('')}</select></div>
    ${field('discoveryAddress','地址或怎么找到这里')}<div class="field"><label for="discoveryText">你的发现与体验</label><textarea id="discoveryText" rows="4" placeholder="值得去的原因、适合谁、需要注意什么"></textarea></div>
    ${tagOptions()}${field('discoveryTags','自定义标签（可选，用逗号分隔）')}${field('discoveryReservation','预约与购票提示（可选）')}${field('discoveryLat','纬度（可选，申请收录时必填）')}${field('discoveryLng','经度（可选，申请收录时必填）')}${coordinateCrsField('discoveryCrs')}
    <p class="stop-meta">保存后补充坐标与核实依据，再申请平台收录；审核通过后进入目录。未提交或审核中的推荐仅自己可见。请勿填写私人住址。</p><button data-action="save-discovery" class="btn-primary">保存推荐，继续申请</button>`);
}
export async function publishDiscovery(button) {
  await mutate(button, async () => {
    const item = await api('/api/v1/community/places', { method: 'POST', body: JSON.stringify({ name: $('discoveryName').value,
      officialTagIds: [...document.querySelectorAll('input[name=officialTag]:checked')].map(input => input.value), customTags: splitTags($('discoveryTags').value), reservationHint: $('discoveryReservation') ? $('discoveryReservation').value : '', cityCode: $('discoveryCity').value, address: $('discoveryAddress').value, description: $('discoveryText').value, lat: $('discoveryLat').value, lng: $('discoveryLng').value, coordinateCrs: $('discoveryCrs').value }) });
    await loadCommunity().catch(() => {});
    closeSheet(); navigate('places'); await showDiscovery(item.id); toast('推荐已保存，可继续申请收录');
  });
}
export async function showDiscovery(id) {
  const item = await api(`/api/v1/community/places/${id}`);
  state.discovery = item;
  const identifier = placeIdHtml(item);
  openSheet(`${heading(item.name)}<span class="chip">${COMMUNITY_STATUS[item.status]}</span>${identifier ? `<span class="chip">地点编号：${identifier}</span>` : ''}<p class="community-place-address">${uiIcon('pin', { size: 15 })} ${escapeHtml(item.address)}</p>${item.coordinateNeedsVerification ? '<p class="stop-meta">这条旧地点的坐标系未知，地图位置可能不准；请重新核对坐标并提交平台复核。</p>' : ''}<p style="white-space:pre-wrap">${escapeHtml(item.description)}</p><p class="stop-meta">${escapeHtml(item.nickname)} 分享 · ${item.rating === null ? '暂无评分' : `★ ${item.rating.toFixed(1)}（${item.reviewCount} 条）`}</p>
    ${tagChips(item)}<button class="btn-soft" data-action="edit-place-tags" data-place="${escapeHtml(item.id)}">添加我的标签</button>
    ${item.decisionNote ? `<p>审核说明：${escapeHtml(item.decisionNote)}</p>` : ''}
    ${item.mine ? '' : item.reported ? '<p class="stop-meta">你已举报这条内容，平台会核查。</p>' : '<button class="btn-ghost" data-action="report-discovery-form">举报这条内容</button>'}
    ${item.mine && (['shared','rejected'].includes(item.status) || (item.status === 'approved' && item.coordinateNeedsVerification)) ? `<button class="btn-primary" data-action="submit-discovery-form">${item.status === 'approved' ? '核对并重新提交坐标' : '申请平台收录'}</button>` : ''}
    ${item.mine ? '<button class="btn-ghost" data-action="withdraw-discovery-form">撤回分享</button>' : ''}

    <h3>旅人评价</h3>${item.reviews.map((review) => `<article class="memory-card"><strong>${escapeHtml(review.nickname)} · ${review.rating} 星</strong><p>${escapeHtml(review.text)}</p></article>`).join('') || '<p class="stop-meta">还没有评价。</p>'}
    ${!item.mine ? isLoggedIn() ? `${publicationIdentity()}<div class="field"><label for="ratingStars">评分</label><select id="ratingStars">${[5,4,3,2,1].map((n)=>`<option value="${n}">${n} 星</option>`).join('')}</select></div><div class="field"><label for="ratingText">到访体验</label><textarea id="ratingText" rows="3"></textarea></div><p class="stop-meta">每个账号保留一份评价，再次提交会更新自己的评价。</p><button class="btn-primary" data-action="review-discovery">提交评价</button>` : '<button class="btn-soft" data-action="account-panel">登录后评价</button>' : '<p class="stop-meta">发布者不能给自己的地点评分。</p>'}`);
}
export function openSubmission() {
  const item = state.discovery;
  const needsReverification = item.coordinateNeedsVerification === true;
  const hasCoordinates = item.lat !== null && item.lat !== undefined && item.lng !== null && item.lng !== undefined
    && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng));
  const coordinateCrs = needsReverification || !hasCoordinates ? 'GCJ02' : 'WGS84';
  openSheet(`${heading('申请平台收录')}${needsReverification ? '<p class="stop-meta">旧记录的坐标系不明，请先核对地点位置，再填写坐标并选择来源坐标系。</p>' : ''}${field('submitLat','准确纬度',needsReverification ? '' : item.lat)}${field('submitLng','准确经度',needsReverification ? '' : item.lng)}${coordinateCrsField('submitCrs', coordinateCrs)}<div class="field"><label for="submitEvidence">核实依据</label><textarea id="submitEvidence" rows="4" placeholder="例如公开介绍、到访日期、开放时间及交通信息">${escapeHtml(item.evidence)}</textarea></div><p class="stop-meta">坐标提交后会统一转换为 WGS-84 保存。提交给伴途平台审核，通过后进入正式地点目录；不会自动报送地图厂商或文旅部门。</p><button data-action="submit-discovery" class="btn-primary">提交审核</button>`);
}
export function confirmWithdrawal() {
  openSheet(`${heading('撤回这条分享？')}<p>撤回后社区内容与评价不再展示，已收录的地点也会退出目录。</p><button class="btn-danger" data-action="withdraw-discovery">确认撤回</button>`);
}
export async function withdrawDiscovery(button) {
  await mutate(button, async () => {
    await api(`/api/v1/community/places/${state.discovery.id}`, { method: 'DELETE' });
    await Promise.allSettled([loadCommunity(), loadPlaces()]); closeSheet(); navigate('places');
  });
}
export async function communityMutation(action, button) {
  await mutate(button, async () => {
    const id = state.discovery.id;
    const body = action === 'reviews' ? { rating: Number($('ratingStars').value), text: $('ratingText').value }
      : action === 'submit' ? { evidence: $('submitEvidence').value, lat: $('submitLat').value, lng: $('submitLng').value, coordinateCrs: $('submitCrs').value }
      : { decision: button.dataset.decision, note: $('reviewNote').value };
    await api(`/api/v1/community/places/${id}/${action}`, { method: 'POST', ...(action === 'decision' ? { headers: { 'content-type':'application/json', 'x-community-admin-token': $('reviewToken').value } } : {}), body: JSON.stringify(body) });
    await Promise.allSettled([loadCommunity(), loadPlaces()]);
    render(); await showDiscovery(id); toast('已保存');
  });
}

// —— 帖子互动（点赞 / 评论） ——

export async function toggleLike(button) {
  const id = button.dataset.post;
  await mutatePost(button, 'like', async () => {
    const result = await api(`/api/v1/community/posts/${encodeURIComponent(id)}/like`, { method: 'POST', body: JSON.stringify({}) });
    for (const post of [state.communityPosts, state.communityMine?.posts].flat().filter(Boolean)) {
      if (post.id === id) { post.liked = result.liked; post.likes = result.likes; }
    }
    if (state.favoritePostDetails?.[id]) {
      state.favoritePostDetails[id].liked = result.liked;
      state.favoritePostDetails[id].likes = result.likes;
    }
    if (state.postDetailId === id && state.postDetail) {
      state.postDetail.liked = result.liked;
      state.postDetail.likes = result.likes;
    }
  });
}

async function mutatePost(button, kind, work) {
  if (!requireLogin()) return;
  const token = beginPostInteraction(button.dataset.post, kind);
  if (!token) return;
  button.disabled = true;
  button.setAttribute?.('aria-busy', 'true');
  const postInteractionViewVisible = () => typeof document !== 'undefined' && ['community', 'post-detail', 'favorites'].includes(state.currentView);
  try { if (postInteractionViewVisible()) render(); await work(); }
  finally {
    const current = isCurrentPostInteraction(token);
    finishPostInteraction(token);
    button.disabled = false;
    button.removeAttribute?.('aria-busy');
    if (current && postInteractionViewVisible()) render();
  }
}

export function openPostDetail(id) {
  const cached = [
    ...(state.communityPosts || []),
    ...(state.communityMine?.posts || []),
    state.favoritePostDetails?.[id],
  ].find(post => post?.id === id || post?.postId === id) || null;
  if (state.currentView !== 'post-detail') {
    state.postReturnView = state.currentView;
    state.postReturnScrollY = window.scrollY;
    state.postReturnAnchor = capturePostFeedAnchor(id);
  }
  state.postDetailId = id;
  state.postDetail = cached;
  navigate('post-detail');
}

export async function submitComment(button) {
  if (!requireLogin()) return;
  const form = button.closest('[data-comment-form]');
  const submission = captureCommentSubmission(form?.querySelector('[data-comment-draft]'));
  let failure = null;
  await mutatePost(button, 'comment', async () => {
    const id = button.dataset.post;
    const parentCommentId = button.dataset.parentComment || '';
    let updated;
    try {
      updated = await api(`/api/v1/community/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({
        text: submission.text,
        ...(parentCommentId ? { parentCommentId } : {}),
      }) });
    } catch (error) { failure = error; return; }
    clearSubmittedComment(submission);
    if (submission.owner !== (state.principal?.principalId || 'guest')) return;
    replacePost(updated);
  });
  if (failure) reportCommentFailure(submission, failure);
}

export async function deleteComment(button) {
  await mutatePost(button, 'delete', async () => {
    const updated = await api(`/api/v1/community/posts/${button.dataset.post}/comments/${button.dataset.comment}`, { method: 'DELETE' });
    replacePost(updated);
  });
}

// —— 列表筛选（排序；城市筛选统一走 actions 的 filter-city） ——

export async function changeCommunitySort(button) {
  state.communitySort = button.dataset.sort || 'newest';
  if (state.currentView !== 'places') await loadCommunity();
  render();
}

// —— 地点评价（星级 + 到访体验；官方目录与社区分享都走同一接口） ——

export function openPlaceReview(button) {
  if (!requireLogin()) return;
  const id = button.dataset.place;
  const place = findPlace(id);
  openSheet(`${heading(`评价 · ${escapeHtml(place?.name || '地点')}`)}
    <div class="field"><label for="placeReviewStars">评分</label><select id="placeReviewStars">${[5, 4, 3, 2, 1].map(n => `<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${n} 星</option>`).join('')}</select></div>
    <div class="field"><label for="placeReviewText">到访体验</label><textarea id="placeReviewText" rows="3" maxlength="1000" placeholder="值得去的原因、适合谁、需要注意什么"></textarea></div>
    <p class="stop-meta">每个账号只能留一条评价，再次提交会替换原评价。</p>
    <button class="btn-primary" data-action="submit-place-review" data-place="${escapeHtml(id)}">提交评价</button>`);
}

export async function submitPlaceReview(button) {
  await mutate(button, async () => {
    const id = button.dataset.place;
    await api(`/api/v1/community/places/${id}/reviews`, { method: 'POST', body: JSON.stringify({ rating: Number($('placeReviewStars')?.value), text: $('placeReviewText')?.value }) });
    closeSheet();
    // 目录接口会合并用户评价；社区分享的评价在详情里，一并刷新。
    await loadPlaces().catch(() => {});
    if ((state.community || []).some(item => item.id === id)) await loadCommunity().catch(() => {});
    await refreshPlaceDetailAfterMutation(id);
    render();
    toast('评价已保存');
  });
}

// —— 举报 ——

export function reportDiscoveryForm() {
  if (!requireLogin()) return;
  openSheet(`${heading('举报这条内容？')}<p class="stop-meta">请说明具体问题（例如位置不实、内容违规）。举报会提交给平台审核员核查；同一身份重复举报会更新理由。</p>
    <div class="field"><label for="reportReason">举报理由</label><textarea id="reportReason" rows="3" maxlength="200"></textarea></div>
    <button class="btn-primary" data-action="submit-report">提交举报</button>`);
}

export async function submitReport(button) {
  await mutate(button, async () => {
    await api(`/api/v1/community/places/${state.discovery.id}/reports`, { method: 'POST', body: JSON.stringify({ reason: $('reportReason').value }) });
    closeSheet();
    await loadCommunity().catch(() => {});
    render();
    await showDiscovery(state.discovery.id);
    toast('已提交举报，平台会核查');
  });
}
// —— 行程方案分享 ——

function planShareDuration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  if (!hours) return `${value} 分钟`;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function planShareDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : '';
}

export function viewPlanShare(id) {
  const share = (state.planShares || []).find(item => item.id === id);
  if (!share) { toast('这份方案分享已不存在或已撤回。', 'error'); return; }
  let decoded;
  try { decoded = decodePlanCode(share.code); }
  catch (error) {
    openSheet(`${heading('方案详情')}<div class="plan-share-detail-error"><h3>方案暂时无法读取</h3><p>${escapeHtml(error.message || '方案内容不完整，请稍后重试。')}</p></div>`);
    return;
  }
  const days = decoded.days || [{ stops: decoded.stops || [] }];
  const stopCount = days.reduce((sum, day) => sum + (day.stops || []).length, 0);
  const totalMinutes = days.reduce((sum, day) => sum + (day.stops || []).reduce((daySum, stop) => daySum + (Number(stop.durationMinutes) || 0), 0), 0);
  const city = share.cityLabel || decoded.cityLabel || cityName(share.cityCode || decoded.cityCode) || '城市未注明';
  const travelDate = planShareDate(decoded.localDate || share.localDate);
  const author = share.nickname || '旅人';
  const publishedAt = planShareDate(String(share.createdAt || '').slice(0, 10));
  const dayCards = days.map((day, dayIndex) => {
    const stops = day.stops || [];
    const stopItems = stops.map((stop, stopIndex) => `<li><span class="plan-share-stop-number">${stopIndex + 1}</span><div class="plan-share-stop-copy"><strong>${escapeHtml(stop.name)}</strong><span>停留 ${planShareDuration(stop.durationMinutes)}</span></div></li>`).join('');
    return `<section class="plan-share-detail-day"><h3>第 ${dayIndex + 1} 天 <span>${stops.length} 个地点</span></h3>${stops.length ? `<ol>${stopItems}</ol>` : '<p class="plan-share-detail-empty">这一天还没有安排地点</p>'}</section>`;
  }).join('');
  openSheet(`${heading('方案详情')}
    <div class="plan-share-detail">
      <section class="plan-share-detail-overview">
        <p>${escapeHtml(city)}${travelDate ? ` · ${escapeHtml(travelDate)}` : ''}</p>
        <h2>${escapeHtml(decoded.name || share.name)}</h2>
        <div class="plan-share-detail-stats"><span>${days.length} 天</span><span>${stopCount} 个地点</span><span>停留 ${planShareDuration(totalMinutes)}</span></div>
      </section>
      <div class="plan-share-detail-author"><span class="plan-share-detail-avatar" aria-hidden="true">${escapeHtml(author.slice(0, 1))}</span><div><strong>${escapeHtml(author)}</strong><small>${publishedAt ? `${escapeHtml(publishedAt)} 分享` : '分享者'}</small></div></div>
      <div class="plan-share-detail-days">${dayCards}</div>
      <div class="stop-actions plan-share-detail-actions"><button class="btn-primary" data-action="import-plan-share" data-share="${escapeHtml(share.id)}">导入到方案候选</button></div>
    </div>`);
}

export async function copyPlanShareCode(button) {
  const code = String(button?.dataset.code || '').trim();
  if (!code) { toast('方案码暂不可用。', 'error'); return; }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
    else {
      const input = document.createElement('textarea');
      input.value = code;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('clipboard unavailable');
    }
    toast('方案码已复制，可以贴到帖子里。');
  } catch {
    toast('复制失败，请长按或选中方案码复制。', 'error');
  }
}

const sharePlanFingerprint = plan => JSON.stringify({ name: plan.name, days: plan.days, cityCode: plan.cityCode, revision: plan.revision || 0 });

export async function sharePlanToCommunity(selectedPlanId = '', button) {
  if (!selectedPlanId) { navigate('plan'); return; }
  await mutate(button, async () => {
    const owner = state.principal?.principalId;
    await loadPlans();
    if (owner !== state.principal?.principalId) throw new Error('账号已切换，请重新选择要分享的方案。');
    const plan = (state.savedPlans || []).find(item => item.id === selectedPlanId && item.kind === 'scheme');
    if (!plan) throw new Error('请从「方案候选」中选择一套完整方案再分享。');
    const fingerprint = sharePlanFingerprint(plan);
    const sourceDays = plan.days || [];
    if (!sourceDays.length) throw new Error('这套方案还没有安排天数。');
    const missingPlaces = sourceDays.flatMap(day => (day.stops || [])
      .filter(stop => stop.status !== 'skipped' && !hasShareCoordinates(stop)));
    if (missingPlaces.length) throw new Error(`${missingPlaces.length} 个地点缺少位置，补充地点位置后再分享。`);
    const activeStops = sourceDays.flatMap(day => (day.stops || []).filter(stop => stop.status !== 'skipped'));
    const resolvedCities = await Promise.all(activeStops.map(resolveShareStopCity));
    const placeCities = [...new Set(resolvedCities.filter(code => /^\d{6}$/.test(code) && code !== '000000'))];
    const cityCode = placeCities[0] || '000000';
    const cityLabel = placeCities.length > 1 ? '多地' : placeCities.length === 1 ? cityName(cityCode) : '城市待核实';
    const days = sourceDays.map(day => ({
      stops: (day.stops || []).filter(stop => stop.status !== 'skipped').map(encodePlanStop),
    }));
    const stopCount = days.reduce((sum, day) => sum + day.stops.length, 0);
    if (!stopCount) throw new Error('方案里还没有可分享的地点。');
    const name = plan.name || '旅行方案';
    const code = encodePlanCode({ name, cityCode, cityLabel, days });
    const latest = (state.savedPlans || []).find(item => item.id === selectedPlanId && item.kind === 'scheme');
    if (owner !== state.principal?.principalId || !latest || fingerprint !== sharePlanFingerprint(latest)) throw new Error('方案或账号已变化，请重新预览要公开的内容。');
    const preview = { token: newClientId(), ownerId: owner, planId: selectedPlanId, fingerprint, body: { code, name, cityLabel, cityCode, stopCount }, saving: false };
    state.planSharePreview = preview;
    const publicDays = decodePlanCode(code).days;
    const dayCards = publicDays.map((day, index) => `<section class="plan-share-detail-day"><h3>第 ${index + 1} 天 <span>${day.stops.length} 个地点</span></h3>${day.stops.length ? `<ol>${day.stops.map((stop, i) => `<li><span class="plan-share-stop-number">${i + 1}</span><div class="plan-share-stop-copy"><strong>${escapeHtml(stop.name)}</strong><span>${Number.isInteger(stop.startMinutes) ? `${escapeHtml(fmt(stop.startMinutes))} · ` : ''}停留 ${planShareDuration(stop.durationMinutes)}</span><details class="plan-share-coordinate"><summary>包含地点地图位置</summary><span>${stop.coordinates.lat.toFixed(5)}, ${stop.coordinates.lng.toFixed(5)}</span></details></div></li>`).join('')}</ol>` : '<p class="plan-share-detail-empty">这一天还没有安排地点</p>'}</section>`).join('');
    openSheet(`<div class="sheet-head"><h3>分享前看一眼</h3><button class="icon-btn" data-action="cancel-plan-share" aria-label="取消分享">${uiIcon('close', { size: 20 })}</button></div>
      <div class="plan-share-detail plan-share-publish-preview"><section class="plan-share-detail-overview"><p>${uiIcon('share', { size: 17 })} 公开给所有旅人</p><h2>${escapeHtml(name)}</h2><div class="plan-share-detail-stats"><span>${escapeHtml(cityLabel)}</span><span>${publicDays.length} 天</span><span>${stopCount} 个地点</span></div></section>
      <p class="plan-share-public-scope">发布后，所有旅人可查看并导入。公开内容包括你的昵称、方案名称、城市、每日地点、地图位置与游览安排。私人笔记、实际进度、费用和出行日期不会公开。</p>
      <div class="plan-share-detail-days">${dayCards}</div><p id="planSharePublishError" class="plan-share-publish-error" role="alert" hidden></p>
      <div class="stop-actions plan-share-publish-actions"><button class="btn-ghost" data-action="cancel-plan-share">先不分享</button><button class="btn-primary" data-action="confirm-plan-share" data-preview="${preview.token}">${buttonContent('share', '公开发布')}</button></div></div>`);
  });
}

export function cancelPlanShare() {
  if (state.planSharePreview?.saving) { toast('正在发布，请稍候。'); return; }
  state.planSharePreview = null;
  closeSheet();
}

export async function confirmPlanShare(button) {
  const preview = state.planSharePreview;
  if (!preview || preview.saving) return;
  if (button?.dataset.preview !== preview.token) throw new Error('分享预览已变化，请重新打开。');
  await mutate(button, async () => {
    preview.saving = true;
    if (button) { button.textContent = '正在发布…'; button.setAttribute?.('aria-busy', 'true'); }
    try {
      if (preview.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新预览。');
      await loadPlans();
      const plan = (state.savedPlans || []).find(item => item.id === preview.planId && item.kind === 'scheme');
      if (state.planSharePreview !== preview || preview.ownerId !== state.principal?.principalId || !plan || sharePlanFingerprint(plan) !== preview.fingerprint) throw new Error('方案已有变化，本次尚未发布。请关闭后重新预览。');
      const published = await api('/api/v1/community/plan-shares', { method: 'POST', body: JSON.stringify(preview.body) });
      if (preview.ownerId !== state.principal?.principalId) return;
      state.planShares = [{ ...published, mine: true }, ...(state.planShares || []).filter(item => item.id !== published.id)];
      if (state.communityMine) state.communityMine.planShares = [{ ...published, mine: true }, ...(state.communityMine.planShares || []).filter(item => item.id !== published.id)];
      if (state.planSharePreview === preview) { state.planSharePreview = null; closeSheet(); }
      render();
      toast('方案已分享，旅人可在社区导入');
    } catch (error) {
      if (state.planSharePreview === preview) {
        const status = document.getElementById('planSharePublishError');
        if (status) { status.hidden = false; status.textContent = error.message; }
      }
      throw error;
    } finally {
      preview.saving = false;
      if (button) { button.innerHTML = buttonContent('share', '公开发布'); button.removeAttribute?.('aria-busy'); }
    }
  });
}

export async function importPlanShare(id, button) {
  const share = (state.planShares || []).find(item => item.id === id);
  if (!share) { toast('这份方案分享已不存在或已撤回。', 'error'); return; }
  await mutate(button, async () => {
    const decoded = decodePlanCode(share.code);
    const createStopIds = createImportedStopIdFactory();
    const cityCode = /^\d{6}$/.test(String(share.cityCode || '')) && share.cityCode !== '000000' ? share.cityCode : decoded.cityCode;
    const days = decoded.days
      ? buildImportedSchemeDays(decoded.days, createStopIds, cityCode)
      : [{ dayIndex: 0, stops: buildImportedStops(decoded.stops, createStopIds, undefined, cityCode), routeLegs: [] }];
  const saved = await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({
      name: decoded.name || '导入方案', kind: 'scheme', source: 'imported', cityCode, days,
    }) });
    await loadPlans().catch(() => {});
    closeSheet();
    navigate('plan');
    toast(`已导入「${saved.name || decoded.name}」到方案候选，共 ${days.length} 天。`);
  });
}

export function askWithdrawPlanShare(button) {
  const share = (state.planShares || []).find(item => item.id === button.dataset.share);
  const name = share?.name ? `「${escapeHtml(share.name)}」` : '这份方案';
  openSheet(`${heading('撤回这份方案分享？')}<p>确定撤回${name}吗？撤回后，其他旅人将无法再查看或导入。</p><div class="stop-actions"><button class="btn-soft" data-action="close-sheet">先不撤回</button><button class="btn-danger" data-action="confirm-withdraw-plan-share" data-share="${escapeHtml(button.dataset.share)}">确认撤回</button></div>`);
}

export async function withdrawPlanShare(button) {
  await mutate(button, async () => {
    await api(`/api/v1/community/plan-shares/${button.dataset.share}`, { method: 'DELETE' });
    await loadCommunity().catch(() => {});
    closeSheet();
    render();
    toast('方案分享已撤回');
  });
}

// —— 帖子收藏（与点赞并列：点赞=表态，收藏=存档） ——

export async function togglePostFavorite(button) {
  const id = button.dataset.post;
  const returnView = state.currentView, navigationRevision = state.navigationRevision;
  await mutatePost(button, 'favorite', async () => {
    const postFavorites = (state.postFavorites || []).filter(item => item?.post?.postId);
    const favored = postFavorites.some(item => item.post.postId === id);
    const result = await api(`/api/v1/community/posts/${encodeURIComponent(id)}/favorite`, { method: favored ? 'DELETE' : 'POST', ...(favored ? {} : { body: JSON.stringify({}) }) });
    replacePostFavorites(result.postFavorites);
    if (state.currentView === returnView && state.navigationRevision === navigationRevision) toast(favored ? '已取消收藏' : '帖子已收藏，可在「我的」查看');
  });
}
