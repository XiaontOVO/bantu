import { state } from './store.js';
import { escapeHtml, dateKeyInTimeZone } from './format.js';
import { hasOvernightActiveStop } from './plan-execution-window.js';
import { normalizeSchemeDraft } from './scheme-days.js';

// Local to this browser tab and principal. Nothing is submitted by recovery.
const notices = new WeakMap();
const storageKey = owner => `bantu-plan-draft:v1:${owner}`;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const objects = value => Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item));

function planDraftSnapshot(draft) {
  return {
    name: draft.name, ownerId: draft.ownerId, activeDay: draft.activeDay,
    localDate: draft.localDate || '', cityCode: draft.cityCode, timezone: draft.timezone,
    ...(draft.editId ? { editId: draft.editId, expectedRevision: draft.expectedRevision ?? 0 } : {}),
    ...(draft.dailyPlanDate ? { dailyPlanDate: draft.dailyPlanDate } : {}),
    planKind: draft.planKind || (draft.dailyPlanDate ? 'plan' :
      (state.savedPlans || []).find(plan => plan.id === draft.editId)?.kind || 'scheme'),
    days: draft.days.map(day => ({
      dayIndex: day.dayIndex, ...(day.transportMode ? { transportMode: day.transportMode } : {}),
      stops: day.stops, routeLegs: day.routeLegs || [], plannedCharges: day.plannedCharges || [],
    })),
  };
}

function validStoredPlanDraft(draft, owner) {
  if (!draft || typeof draft.timezone !== 'string') return false;
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: draft.timezone }); } catch { return false; }
  return draft.ownerId === owner && typeof draft.name === 'string' &&
    ['plan', 'scheme'].includes(draft.planKind) && (!draft.localDate || isDate(draft.localDate)) &&
    (!draft.dailyPlanDate || (isDate(draft.dailyPlanDate) && draft.dailyPlanDate === draft.localDate && !draft.editId)) &&
    (!draft.editId || (typeof draft.editId === 'string' && Number.isInteger(draft.expectedRevision) && draft.expectedRevision >= 0)) &&
    typeof draft.cityCode === 'string' && typeof draft.timezone === 'string' &&
    Array.isArray(draft.days) && draft.days.length > 0 &&
    Number.isInteger(draft.activeDay) && draft.activeDay >= 0 && draft.activeDay < draft.days.length &&
    draft.days.every((day, index) => day && day.dayIndex === index && objects(day.stops) &&
      day.stops.every(stop => typeof stop.stopId === 'string') && objects(day.routeLegs) && objects(day.plannedCharges));
}

export function planDraftContentKey(draft) {
  const value = planDraftSnapshot(draft);
  delete value.activeDay;
  return JSON.stringify(value);
}

export function retainPlanDraft(draft = state.planDraft) {
  const owner = state.principal?.principalId;
  if (!draft || !owner || draft.ownerId !== owner) return false;
  let persisted = false;
  try {
    const value = planDraftSnapshot(draft);
    if (validStoredPlanDraft(value, owner)) {
      sessionStorage.setItem(storageKey(owner), JSON.stringify({ version: 1, draft: value }));
      persisted = true;
    }
  } catch { /* The page still keeps its current edits when storage is unavailable. */ }
  notices.set(draft, { ...notices.get(draft), persisted });
  const status = typeof document !== 'undefined' && document.querySelector?.('[data-plan-draft-status]');
  if (status) status.textContent = planDraftStatus(draft);
  return persisted;
}

export function restorePlanDraft() {
  const owner = state.principal?.principalId;
  if (!owner || state.planDraft) return false;
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey(owner)) || 'null');
    if (stored?.version !== 1 || !validStoredPlanDraft(stored.draft, owner)) return false;
    // Sanitize transient flags even when the stored object has extra properties.
    const draft = JSON.parse(JSON.stringify(planDraftSnapshot(stored.draft)));
    normalizeSchemeDraft(draft);
    state.planDraft = draft;
    notices.set(draft, { persisted: true, restored: true });
    const date = draft.dailyPlanDate || (draft.planKind === 'plan' && draft.localDate);
    if (date) state.planViewDate = date;
    return true;
  } catch { return false; }
}

/** Only explicit discard or a completed save may remove the owning tab's draft. */
export function clearPlanDraft(draft = state.planDraft) {
  if (!draft?.ownerId || draft.ownerId !== state.principal?.principalId) return;
  try { sessionStorage.removeItem(storageKey(draft.ownerId)); }
  catch {
    try { sessionStorage.setItem(storageKey(draft.ownerId), 'null'); } catch {}
  }
  notices.delete(draft);
}

export function planDraftStatus(draft = state.planDraft) {
  if (!draft) return '';
  const notice = notices.get(draft);
  if (!notice?.persisted) return '最新修改暂时无法在本标签页暂存；请先保存，刷新可能丢失修改。';
  return notice.restored ? '已恢复本标签页的编辑草稿，尚未保存到计划。'
    : '草稿已在本标签页暂存，刷新后可继续；尚未保存到计划。';
}

export function planDraftNeedsNewScheme(draft = state.planDraft) {
  if (!draft || state.loadStatus?.plans?.status === 'error') return false;
  if (draft.editId && !(state.savedPlans || []).some(plan => plan.id === draft.editId)) return true;
  const date = draft.dailyPlanDate || (draft.planKind === 'plan' && draft.localDate);
  const source = (state.savedPlans || []).find(plan => plan.id === draft.editId);
  if (source && hasOvernightActiveStop(source, new Date())) return false;
  return Boolean(date && date < dateKeyInTimeZone(new Date(), draft.timezone || 'Asia/Shanghai'));
}

export function planDraftResumeNotice(editorVisible) {
  const draft = state.planDraft;
  if (!draft || draft.ownerId !== state.principal?.principalId || editorVisible) return '';
  return `<section class="plan-draft-resume notice" aria-label="未保存的计划草稿"><div><strong>${escapeHtml(draft.name || '未命名计划')} · 编辑未完成</strong><p data-plan-draft-status role="status">${escapeHtml(planDraftStatus(draft))}</p></div><div class="plan-draft-resume-actions"><button class="btn-soft" data-action="resume-plan-draft">继续编辑</button><button class="btn-ghost" data-action="discard-plan-draft" data-confirm="true">放弃草稿</button></div></section>`;
}
