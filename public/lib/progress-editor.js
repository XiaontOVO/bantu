import { api } from './api.js';
import { $, state, tripId, tripRevision, usesSavedDayPlans } from './store.js';
import { STATUS_LABEL, escapeHtml, clockText } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { loadTrip } from './loaders.js';
import { render } from './render.js';

let draft, busy = false;
export async function correctProgress(stopId, planId = '') {
  if (busy || state.executionPending) return;
  if (usesSavedDayPlans() && planId) {
    const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind === 'plan');
    if (!plan) throw new Error('找不到这一天的计划，请刷新。');
    const stop = (plan.stops || []).find(item => item.stopId === stopId);
    const events = plan.executionEvents || [];
    const replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
    const event = events.filter(item => item.stopId === stopId && !replaced.has(item.executionEventId))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt)).at(-1);
    if (!stop || !event) throw new Error('没有可纠正的进度记录，请刷新。');
    draft = { planId, revision: plan.revision || 0, eventId: event.executionEventId, type: event.type, previous: stop.status };
    openSheet(`<div class="sheet-head"><h3>纠正进度 · ${escapeHtml(stop.place?.name || stopId)}</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div><p>当前：${escapeHtml(STATUS_LABEL[stop.status])} · ${escapeHtml(clockText(event.occurredAt, plan.timezone || 'Asia/Shanghai'))}</p><label for="progressStatus">真实进度</label><select id="progressStatus">${Object.entries({planned:'未完成，回到计划',en_route:'正在前往',visiting:'已经到达，正在游览',completed:'已完成',skipped:'已跳过'}).map(([value,label])=>`<option value="${value}" ${value===stop.status?'selected':''}>${label}</option>`).join('')}</select><label for="progressReason">纠正说明（选填）</label><textarea id="progressReason" rows="3" maxlength="500" placeholder="例如：误点完成，实际上还没去"></textarea><p>只纠正这个地点的实际进度，保留原记录。改回未完成后可继续调整计划。</p><p id="progressStatusMessage" role="status"></p><button class="btn-primary" data-action="preview-progress-correction">预览纠正</button><div id="progressCorrectionPreview"></div>`);
    return;
  }
  const target = tripId(); await loadTrip(target);
  if (tripId() !== target) return;
  const stop = state.trip.snapshot.stops.find(item => item.stopId === stopId);
  const events = state.trip.snapshot.executionEvents || [];
  const replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  const event = events.filter(event => event.stopId === stopId && !replaced.has(event.executionEventId))
    .sort((a,b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt)).at(-1);
  if (!stop || !event) throw new Error('没有可纠正的进度记录，请刷新。');
  draft = {tripId:target, revision:tripRevision(), eventId:event.executionEventId, type:event.type, previous:stop.status};
  openSheet(`<div class="sheet-head"><h3>纠正进度 · ${escapeHtml(stop.place?.name || stopId)}</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div><p>当前：${escapeHtml(STATUS_LABEL[stop.status])} · ${escapeHtml(clockText(event.occurredAt))}</p><label for="progressStatus">真实进度</label><select id="progressStatus">${Object.entries({planned:'未完成，回到计划',en_route:'正在前往',visiting:'已经到达，正在游览',completed:'已完成',skipped:'已跳过'}).map(([value,label])=>`<option value="${value}" ${value===stop.status?'selected':''}>${label}</option>`).join('')}</select><label for="progressReason">纠正说明（选填）</label><textarea id="progressReason" rows="3" maxlength="500" placeholder="例如：误点完成，实际上还没去"></textarea><p>只纠正这个地点的实际进度，保留原记录。改回未完成后可继续调整计划；恢复旧计划不会撤回此次纠正。</p><p id="progressStatusMessage" role="status"></p><button class="btn-primary" data-action="preview-progress-correction">预览纠正</button><div id="progressCorrectionPreview"></div>`);
}
export function previewProgressCorrection() {
  if (!draft || busy) return;
  draft.status = $('progressStatus').value; draft.reason = $('progressReason').value.trim();
  if (draft.status === draft.previous) { $('progressStatusMessage').textContent = '请选择需要改成的进度。'; $('progressCorrectionPreview').innerHTML = ''; return; }
  $('progressStatusMessage').textContent = '';
  $('progressCorrectionPreview').innerHTML = `<p>${escapeHtml(STATUS_LABEL[draft.previous])} → ${escapeHtml(STATUS_LABEL[draft.status])}</p><p>${escapeHtml(draft.reason || '未填写说明')}</p><button class="btn-primary" data-action="save-progress-correction">确认纠正</button>`;
}
export async function saveProgressCorrection(button) {
  if (busy || !draft?.status) return;
  if (draft.planId) {
    const current = (state.savedPlans || []).find(plan => plan.id === draft.planId);
    if (!usesSavedDayPlans() || !current || draft.revision !== (current.revision || 0)) throw new Error('进度已有变化，请重新打开纠正。');
  } else if (draft.tripId !== tripId() || draft.revision !== tripRevision()) throw new Error('进度已有变化，请重新打开纠正。');
  if ($('progressStatus').value !== draft.status || $('progressReason').value.trim() !== draft.reason) { previewProgressCorrection(); return; }
  const submitted = {...draft};
  const statusMessage = $('progressStatusMessage');
  const controls = [...document.querySelectorAll('#progressStatus, #progressReason, [data-action="preview-progress-correction"], [data-action="save-progress-correction"]')];
  busy = true; controls.forEach(control => {control.disabled = true;});
  statusMessage.textContent = '正在保存纠正……';
  try {
    if (submitted.planId) {
      const updated = await api(`/api/v1/plans/${encodeURIComponent(submitted.planId)}/execution-corrections`, {method:'POST',body:JSON.stringify({eventId:submitted.eventId,type:submitted.type,status:submitted.status,reason:submitted.reason,expectedRevision:submitted.revision})});
      state.savedPlans = (state.savedPlans || []).map(plan => plan.id === updated.id ? updated : plan);
    } else {
      await api(`/api/v1/trips/${submitted.tripId}/execution-corrections`, {method:'POST',body:JSON.stringify({eventId:submitted.eventId,type:submitted.type,status:submitted.status,reason:submitted.reason,expectedRevision:submitted.revision})});
      if (tripId() !== submitted.tripId) return;
      await loadTrip(submitted.tripId).catch(() => {});
      if (tripId() !== submitted.tripId) return;
    }
    if (button.isConnected) closeSheet();
    render(); toast('进度已纠正，原记录和纠正记录均保留');
  } catch(error) { if (statusMessage.isConnected) statusMessage.textContent = error.message; else throw error; }
  finally { busy = false; controls.forEach(control => {control.disabled = false;}); }
}
