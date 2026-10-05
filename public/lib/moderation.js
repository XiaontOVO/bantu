import { api } from './api.js';
import { $, state } from './store.js';
import { cityName, escapeHtml } from './format.js';
import { navigate, render } from './render.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { buttonContent } from './button-content.js';
import { writingDraft, retainWritingDraft } from './writing-drafts.js';

// Credentials are never put into URLs, shared state or browser storage.
let credential = '';
let busy = false;
let editor;
let confirmation;
let loadSequence = 0;
const feedback = error => error instanceof TypeError ? '连接失败，请检查网络后重试。' : error.message;
const repaint = () => { if (state.currentView === 'moderation') render(); };
const heading = title => `<div class="sheet-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>`;
export function openModeration() { navigate('moderation'); }

export async function authorizeModeration(button) {
  if (busy) return;
  const input = $('moderationToken'), status = $('moderationAuthStatus');
  if (!input || !status) return;
  const supplied = input.value.trim(), owner = state.principal?.principalId;
  if (!supplied) { status.textContent = '请输入运营方提供的审核凭证。'; input.focus(); return; }
  busy = true; button.disabled = true; status.textContent = '正在验证凭证…';
  try {
    const queue = await api('/api/v1/community/moderation', { headers: { 'x-community-admin-token': supplied } });
    if (owner !== state.principal?.principalId || state.currentView !== 'moderation' || $('moderationToken') !== input) return;
    credential = supplied; input.value = '';
    state.moderation = { authorized: true, queue, loading: false, error: '' }; repaint();
  } catch (error) {
    if (status.isConnected) status.textContent = error.message === '需要平台审核员凭证。' ? '凭证无效或服务尚未配置审核，请联系平台运营方。' : feedback(error);
  } finally { busy = false; button.disabled = false; }
}

export async function loadModeration() {
  if (!credential || busy) return;
  const sequence = ++loadSequence;
  const owner = state.principal?.principalId, supplied = credential;
  const context = state.moderation;
  context.loading = true; context.error = ''; repaint();
  try {
    const queue = await api('/api/v1/community/moderation', { headers: { 'x-community-admin-token': supplied } });
    if (sequence !== loadSequence || owner !== state.principal?.principalId || credential !== supplied || state.moderation !== context) return;
    context.queue = queue;
  } catch (error) {
    if (sequence !== loadSequence || owner !== state.principal?.principalId || state.moderation !== context) return;
    if (error.message === '需要平台审核员凭证。') {
      credential = ''; context.authorized = false; context.queue = null;
      context.error = '审核凭证已失效，请重新验证。';
    } else context.error = feedback(error);
  } finally { if (sequence === loadSequence) { context.loading = false; repaint(); } }
}

export function exitModeration() {
  loadSequence += 1;
  credential = ''; editor = null; confirmation = null;
  state.moderation = { authorized: false, queue: null, loading: false, error: '' };
  closeSheet(); repaint();
}

export function openModerationReview(id) {
  if (!credential || state.moderation?.loading || state.moderation?.error) return;
  const item = state.moderation?.queue?.pending?.find(entry => entry.id === id);
  if (!item) { toast('申请状态可能已变化，请刷新队列。', 'error'); return; }
  const copy = structuredClone(item), draft = writingDraft('moderation-note', `${id}:${copy.submissionVersion}`);
  const previous = draft.read();
  openSheet(`${heading('核对地点申请')}<div class="moderation-review"><h4>${escapeHtml(copy.name)}</h4><p class="stop-meta">${escapeHtml(cityName(copy.cityCode))} · ${escapeHtml(copy.nickname)}</p><dl><dt>地址</dt><dd>${escapeHtml(copy.address)}</dd><dt>位置坐标</dt><dd>${Number.isFinite(copy.lat) && Number.isFinite(copy.lng) ? `${copy.lng.toFixed(6)}, ${copy.lat.toFixed(6)}` : '坐标缺失'} · ${escapeHtml(copy.coordinateCrs)}</dd><dt>申请介绍</dt><dd>${escapeHtml(copy.description)}</dd><dt>核实依据</dt><dd>${escapeHtml(copy.evidence)}</dd></dl><p class="stop-meta">请人工核对公开资料、地点位置与可到访性。申请人的描述不是核实结果。</p><div class="field"><label for="moderationNote">给申请人的审核说明</label><textarea id="moderationNote" rows="4" maxlength="1000" placeholder="说明核对结论，或具体需要补充的信息">${escapeHtml(previous?.text || '')}</textarea></div><p id="moderationDraftStatus" class="stop-meta" role="status">${previous ? '已恢复本次申请的说明草稿。' : ''}</p><p id="moderationReviewStatus" class="moderation-status" role="alert"></p><div class="stop-actions moderation-review-actions"><button class="btn-soft" data-action="prepare-moderation-decision" data-decision="rejected">${buttonContent('repair', '退回补充')}</button><button class="btn-primary" data-action="prepare-moderation-decision" data-decision="approved">${buttonContent('check', '收录地点')}</button></div></div>`);
  const input = $('moderationNote');
  const capture = retainWritingDraft(draft, { text: input }, $('moderationDraftStatus'));
  input.addEventListener('input', () => { $('moderationReviewStatus').textContent = ''; });
  editor = { item: copy, owner: state.principal?.principalId, draft, input, capture }; confirmation = null;
}

export function prepareModerationDecision(decision) {
  const context = editor;
  if (busy || !context || $('moderationNote') !== context.input || context.owner !== state.principal?.principalId || !['approved', 'rejected'].includes(decision)) return;
  const captured = context.capture(), note = captured.text.trim();
  context.draft.save(captured);
  if (!note || note.length > 1000) { $('moderationReviewStatus').textContent = '请填写 1–1000 个字的审核说明。'; context.input.focus(); return; }
  confirmation = { context, decision, note, captured };
  openSheet(`${heading(decision === 'approved' ? '确认收录这个地点？' : '确认退回这份申请？')}<div data-moderation-confirm><h4>${escapeHtml(context.item.name)}</h4><p>${decision === 'approved' ? '确认后，地点将进入所有旅人可查看的公共目录。' : '确认后，申请仍仅发布者可见，可按说明补充后重新提交。'}</p><p class="moderation-confirm-note">${escapeHtml(note)}</p><p id="moderationDecisionStatus" class="moderation-status" role="alert"></p><div class="stop-actions moderation-review-actions"><button class="btn-soft" data-action="close-sheet">返回核对</button><button class="${decision === 'approved' ? 'btn-primary' : 'btn-danger'}" data-action="confirm-moderation-decision">${decision === 'approved' ? '确认收录' : '确认退回'}</button></div></div>`, { nested: true });
}

export async function confirmModerationDecision(button) {
  const pending = confirmation, marker = document.querySelector('[data-moderation-confirm]');
  if (busy || !pending || !marker || !credential || pending.context.owner !== state.principal?.principalId) return;
  busy = true; button.disabled = true;
  try {
    await api(`/api/v1/community/places/${encodeURIComponent(pending.context.item.id)}/decision`, { method: 'POST', headers: { 'x-community-admin-token': credential }, body: JSON.stringify({ decision: pending.decision, note: pending.note, expectedSubmissionVersion: pending.context.item.submissionVersion }) });
    pending.context.draft.clearIf(pending.captured);
    if (confirmation !== pending || pending.context.owner !== state.principal?.principalId) return;
    confirmation = null; editor = null;
    if (marker.isConnected) closeSheet();
    toast(pending.decision === 'approved' ? '地点已收录，公共目录已更新。' : '申请已退回，说明已发给申请人。');
  } catch (error) {
    if (marker.isConnected) $('moderationDecisionStatus').textContent = `${feedback(error)} 审核说明已保留；如资料或状态变化，请返回队列刷新核对。`;
  } finally { busy = false; button.disabled = false; }
  if (!confirmation) await loadModeration();
}
