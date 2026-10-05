import { api } from './api.js';
import { $, state } from './store.js';
import { escapeHtml } from './format.js';
import { navigate, render } from './render.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { progressTimestamp, progressLocalInput } from './progress-backfill.js';
import { loadAllMemories } from './loaders.js';

let sequence = 0, draft = null, busy = false;
export async function loadPlanHistory(more = false) {
  const owner = state.principal?.principalId, id = state.planHistoryId || '', request = ++sequence;
  state.planHistoryLoading = true;
  try {
    const suffix = new URLSearchParams({ limit: '12', ...(more && state.planHistoryCursor ? { cursor: state.planHistoryCursor } : {}) });
    const result = await api(id ? `/api/v1/plans/${encodeURIComponent(id)}/history` : `/api/v1/plans/history?${suffix}`, {}, !id);
    if (request !== sequence || owner !== state.principal?.principalId || id !== (state.planHistoryId || '')) return;
    if (id) state.planHistoryDetail = result;
    else {
      const items = [...(more ? state.planHistory || [] : []), ...(result.data || [])];
      state.planHistory = [...new Map(items.map(item => [item.id, item])).values()];
      state.planHistoryCursor = result.meta?.nextCursor || '';
    }
    state.planHistoryError = '';
  } catch (error) {
    if (request !== sequence || owner !== state.principal?.principalId || id !== (state.planHistoryId || '')) return;
    state.planHistoryError = error.message;
    throw error;
  } finally { if (request === sequence && owner === state.principal?.principalId) state.planHistoryLoading = false; }
}

export function openPlanHistory(id = '') {
  state.planHistoryId = id;
  state.planHistoryDetail = null;
  state.planHistoryError = '';
  navigate('plan-history');
}

export function latestHistoryEvent(plan, stopId) {
  const replaced = new Set((plan.executionEvents || []).map(event => event.correctsEventId).filter(Boolean));
  return (plan.executionEvents || []).filter(event => event.stopId === stopId && !replaced.has(event.executionEventId))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt)).at(-1);
}

export function openHistoryRecord(stopId, correction = false) {
  if (busy) return;
  const plan = state.planHistoryDetail, stop = plan?.stops?.find(item => item.stopId === stopId);
  if (!stop || !plan.canEditHistory) throw new Error('该记录不可修改，请刷新后核对补记期限。');
  const event = correction ? latestHistoryEvent(plan, stopId) : null;
  if (correction && !event) throw new Error('没有可纠正的实际记录。');
  if (!correction && (stop.status || 'planned') !== 'planned') throw new Error('该地点已有进度，请使用纠正入口。');
  draft = { planId: plan.id, stopId, revision: plan.revision || 0, owner: state.principal?.principalId, correction, eventId: event?.executionEventId,
    timezone: plan.timezone || 'Asia/Shanghai' };
  const max = progressLocalInput(new Date(), draft.timezone);
  // 计划结束时间不是实际完成时间；补记由用户填写，纠正才沿用原事实。
  const defaultTime = event ? progressLocalInput(new Date(event.occurredAt), draft.timezone) : '';
  openSheet(`<div class="sheet-head"><h3>${correction ? '纠正往日记录' : '补记这次到访'}</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div>
    <div id="historyRecordForm" class="history-record-form"><p class="history-record-place">${escapeHtml(stop.place?.name || '地点')}</p>
    ${correction ? `<label for="historyRecordStatus">真实进度</label><select id="historyRecordStatus">${Object.entries({ planned: '未完成', completed: '已完成', skipped: '已跳过' }).map(([value, label]) => `<option value="${value}" ${stop.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`
      : `<label for="historyArrivalTime">实际到达时间 <span>选填</span></label><input id="historyArrivalTime" type="datetime-local" max="${max}"><p class="stop-meta">记不清到达时刻可留空，实际停留时长会保持未知。</p>`}
    <label for="historyCompletionTime">${correction ? '实际发生时间' : '实际完成时间'}</label><input id="historyCompletionTime" type="datetime-local" value="${defaultTime}" max="${max}" required>
    ${correction ? '<label for="historyRecordReason">纠正说明（选填）</label><textarea id="historyRecordReason" rows="3" maxlength="500"></textarea>' : ''}
    <p class="stop-meta">按原计划当地时区记录。仅修改这份往日记录，原事件保留；不会启动实时导航或调整今天的安排。</p>
    <p id="historyRecordError" role="status"></p><button type="button" class="btn-primary" data-action="save-history-record">${correction ? '确认纠正' : '保存到访记录'}</button></div>`);
}

export async function saveHistoryRecord(button) {
  if (busy || !draft || !$('historyRecordForm')) return;
  const pending = draft, plan = state.planHistoryDetail;
  if (pending.owner !== state.principal?.principalId || pending.planId !== plan?.id || pending.revision !== (plan.revision || 0)) throw new Error('账号或记录已有变化，请重新打开。');
  let occurredAt, arrivedAt;
  try {
    occurredAt = progressTimestamp($('historyCompletionTime').value, pending.timezone);
    arrivedAt = $('historyArrivalTime')?.value ? progressTimestamp($('historyArrivalTime').value, pending.timezone) : undefined;
  } catch (error) { $('historyRecordError').textContent = error.message; return; }
  const body = pending.correction ? { eventId: pending.eventId, status: $('historyRecordStatus').value, reason: $('historyRecordReason').value, occurredAt, expectedRevision: pending.revision }
    : { stopId: pending.stopId, type: 'complete', occurredAt, ...(arrivedAt ? { arrivedAt } : {}), expectedRevision: pending.revision };
  busy = true; button.disabled = true;
  const controls = [...document.querySelectorAll('#historyRecordForm input, #historyRecordForm select, #historyRecordForm textarea, #historyRecordForm button')];
  controls.forEach(control => { control.disabled = true; });
  const errorNode = $('historyRecordError');
  try {
    const updated = await api(`/api/v1/plans/${encodeURIComponent(pending.planId)}/history/${pending.correction ? 'corrections' : 'backfill'}`, { method: 'POST', body: JSON.stringify(body) });
    if (pending.owner !== state.principal?.principalId || pending.planId !== state.planHistoryId) return;
    state.planHistoryDetail = updated;
    draft = null; closeSheet(); render();
    await loadAllMemories().catch(() => {});
    toast(pending.correction ? '往日记录已纠正' : '这次到访已补记');
  } catch (error) { if (errorNode?.isConnected) errorNode.textContent = `${error.message} 输入已保留，尚未保存。`; else throw error; }
  finally { busy = false; button.disabled = false; controls.forEach(control => { control.disabled = false; }); }
}

export function askDeleteHistory() {
  const plan = state.planHistoryDetail;
  if (!plan || busy) return;
  draft = { planId: plan.id, revision: plan.revision || 0, owner: state.principal?.principalId, deleting: true };
  openSheet(`<div class="sheet-head"><h3>删除这份往日记录？</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div>
    <p>「${escapeHtml(plan.name)}」的 ${plan.stops.length} 个地点、${(plan.executionEvents || []).length} 条进度记录和历史快照将一并删除，无法恢复。</p>
    <p class="stop-meta">已保存的私人笔记、旅行记忆和可复用方案会保留。</p><p id="historyDeleteError" role="status"></p><div class="stop-actions"><button class="btn-soft" data-action="close-sheet">取消</button><button class="btn-danger" data-action="delete-plan-history">确认删除</button></div>`);
}

export async function deleteHistory(button) {
  if (busy || !draft?.deleting || !$('historyDeleteError')) return;
  const pending = draft;
  if (pending.owner !== state.principal?.principalId || pending.planId !== state.planHistoryDetail?.id) throw new Error('账号或记录已变化。');
  busy = true; button.disabled = true;
  const errorNode = $('historyDeleteError');
  try {
    await api(`/api/v1/plans/${encodeURIComponent(pending.planId)}/history`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: pending.revision }) });
    if (pending.owner !== state.principal?.principalId) return;
    draft = null; closeSheet(); openPlanHistory(); toast('往日记录已删除');
  } catch (error) { if (errorNode?.isConnected) errorNode.textContent = error.message; else throw error; }
  finally { busy = false; button.disabled = false; }
}
