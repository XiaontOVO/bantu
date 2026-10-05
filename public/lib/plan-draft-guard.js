import { state } from './store.js';
import { escapeHtml } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { navigate } from './render.js';
import { clearPlanDraft, planDraftNeedsNewScheme } from './plan-draft-storage.js';

const baselines = new WeakMap();
let pending = null;
let sequence = 0;

function draftContent(draft) {
  return JSON.stringify({ name: draft.name, localDate: draft.localDate, days: (draft.days || []).map(day => ({
    dayIndex: day.dayIndex, transportMode: day.transportMode,
    stops: day.stops, routeLegs: day.routeLegs, plannedCharges: day.plannedCharges,
  })) });
}

export function rememberPlanDraft(draft) {
  baselines.set(draft, draftContent(draft));
}

export function planDraftChanged(draft = state.planDraft) {
  return Boolean(draft && (!baselines.has(draft) || baselines.get(draft) !== draftContent(draft)));
}

function askDraftChange(onConfirm, replacing, canProceed = () => true) {
  const draft = state.planDraft;
  const token = String(++sequence);
  pending = { token, draft, ownerId: state.principal?.principalId, content: draftContent(draft), onConfirm, canProceed };
  const count = (draft.days || []).reduce((sum, day) => sum + (day.stops || []).length, 0);
  openSheet(`<div class="row-between sheet-head"><h3>${replacing ? '先处理未保存的修改' : '放弃未保存的修改？'}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">×</button></div>
    <p>「${escapeHtml(draft.name || '未命名计划')}」${count ? `中的 ${count} 个地点及` : '的'}编辑内容尚未保存。</p>
    <p class="stop-meta">${replacing ? '继续编辑可以先保存当前内容；放弃后再打开另一份计划。' : '放弃只清除这份草稿，已保存的安排与真实进度不受影响。'}</p>
    <div class="stop-actions plan-draft-confirm-actions"><button class="btn-soft" data-action="cancel-plan-draft-change" data-token="${token}">继续编辑</button><button class="btn-primary" data-action="confirm-plan-draft-change" data-token="${token}">${replacing ? '放弃并打开' : '放弃修改'}</button></div>`);
}

/** Reopening the same editor resumes its draft. Switching only clears it after explicit confirmation. */
export function protectPlanDraft(base, onConfirm, canProceed) {
  const draft = state.planDraft;
  if (!draft) return false;
  const same = base.editId ? draft.editId === base.editId
    : base.dailyPlanDate ? draft.dailyPlanDate === base.dailyPlanDate
      : !draft.editId && !draft.dailyPlanDate;
  if (same) return 'resume';
  if (!planDraftChanged(draft)) return false;
  askDraftChange(onConfirm, true, canProceed);
  return 'blocked';
}

export function resumePlanDraft() {
  const draft = state.planDraft;
  if (!draft) return;
  const saved = (state.savedPlans || []).find(plan => plan.id === draft.editId);
  const date = !planDraftNeedsNewScheme(draft) && (draft.dailyPlanDate || (saved?.kind !== 'scheme' && saved?.localDate));
  if (date) state.planViewDate = date;
  navigate(date ? 'today' : 'plan');
}

export function askDiscardPlanDraft(onDiscard, { alwaysConfirm = false } = {}) {
  if (!state.planDraft) return;
  if (alwaysConfirm || planDraftChanged()) askDraftChange(onDiscard, false);
  else onDiscard();
}

export function confirmPlanDraftChange(button) {
  const request = pending;
  if (!request || button?.dataset.token !== request.token) return;
  if (state.planDraft !== request.draft || state.principal?.principalId !== request.ownerId || draftContent(request.draft) !== request.content) {
    pending = null;
    closeSheet();
    toast('草稿或账号已变化，已保留当前内容，请重新查看。', 'error');
    return;
  }
  if (!request.canProceed()) {
    pending = null;
    closeSheet();
    toast('目标计划已变化，已保留当前草稿，请重新选择。', 'error');
    return;
  }
  pending = null;
  closeSheet();
  clearPlanDraft(request.draft);
  state.planDraft = null;
  request.onConfirm();
}

export function cancelPlanDraftChange(button) {
  if (!pending || button?.dataset.token !== pending.token) return;
  const resume = state.planDraft === pending.draft && state.principal?.principalId === pending.ownerId;
  pending = null;
  closeSheet();
  if (resume) resumePlanDraft();
}
