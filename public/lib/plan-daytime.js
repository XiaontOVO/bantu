import { api } from './api.js';
import { state } from './store.js';
import { dateKeyInTimeZone, escapeHtml, fmt, monthDay } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { navigate, render } from './render.js';
import { loadPlans } from './plan-library.js';

let session = null;
const ownPanel = current => session === current && current.owner === state.principal?.principalId && current.marker?.isConnected;
const daytimeErrorMessage = error => error instanceof TypeError ? '连接暂时失败，本次没有保存。请重试预览。' : error.message;

function panel(current, status = '') {
  const preview = current.preview;
  openSheet(`<section class="daytime-plan-panel">
    <div class="sheet-head"><h3>把后续安排移到白天</h3><button class="icon-btn" data-action="cancel-daytime-plan" aria-label="关闭白天安排预览">✕</button></div>
    <p class="daytime-plan-intro">保留停留时长，在 09:00–20:00 内优先考虑已知开放时段。先看看新的日期和时间。</p>
    <div class="daytime-plan-status ${status ? 'has-error' : ''}" role="status">${escapeHtml(status || (preview ? `调整 ${preview.destinations.reduce((n, day) => n + day.stops.length, 0)} 次游览，确认后保存。` : '正在核对计划与后续日期……'))}</div>
    ${preview ? `<div class="daytime-plan-days">${preview.destinations.map(day => `<section class="daytime-plan-day"><h4>${escapeHtml(monthDay(day.date))}</h4><p>${escapeHtml(day.planName)} · ${day.existingStops.length ? `保留原有 ${day.existingStops.length} 个安排` : '无其他安排'}</p>${day.stops.map(stop => {
      const label = preview.visitLabels.find(item => item.stopId === stop.stopId);
      return `<div class="daytime-plan-visit"><span>${escapeHtml(stop.place?.name || stop.stopId)}${label?.totalVisits > 1 ? `<small>第 ${label.visitNumber} 次到访</small>` : ''}${!label?.openingKnown ? '<small>开放时段待核对</small>' : ''}</span><b>${fmt(stop.startMinutes)}–${fmt(stop.endMinutes)}</b></div>`;
    }).join('')}</section>`).join('')}</div>
      ${preview.preserved.length ? `<details class="daytime-plan-preserved"><summary>原计划保留 ${preview.preserved.length} 个安排</summary>${preview.preserved.map(stop => `<p><strong>${escapeHtml(stop.name)}</strong><span>${escapeHtml(stop.reason)}</span></p>`).join('')}</details>` : ''}
      <p class="daytime-plan-note">${preview.discardedUnpaidCharges ? `移除 ${preview.discardedUnpaidCharges} 笔失效的未支付交通估价。` : ''}改期后的起点和跨日路线需重新估算，未知路程会标为待估。本次仅调整计划，不记录出发、到达或完成。</p>` : ''}
    <div class="daytime-plan-actions"><button class="btn-soft" data-action="cancel-daytime-plan">取消</button><button class="btn-primary" data-action="apply-daytime-plan" ${!preview || status ? 'disabled' : ''}>确认调整</button><button class="btn-ghost daytime-plan-recheck" data-action="recheck-daytime-plan" ${current.pending ? 'disabled' : ''} ${status ? '' : 'hidden'}>重新核对</button></div>
  </section>`);
  current.marker = document.querySelector('.daytime-plan-panel');
}

async function requestPreview(current, latest = false) {
  if (current.pending) return;
  current.pending = true; current.preview = null; panel(current);
  try {
    if (latest) {
      const plans = await loadPlans();
      if (!ownPanel(current)) return;
      const source = plans.find(plan => plan.id === current.planId);
      if (!source) throw new Error('原计划已不在当前安排中，请关闭后重新查看。');
      current.params.expectedRevision = source.revision || 0;
    }
    const preview = await api(`/api/v1/plans/${encodeURIComponent(current.planId)}/daytime-preview`, { method: 'POST', body: JSON.stringify(current.params) });
    if (!ownPanel(current)) return;
    current.preview = preview; current.pending = false; panel(current);
  } catch (error) {
    if (ownPanel(current)) { current.pending = false; panel(current, daytimeErrorMessage(error)); }
  } finally { current.pending = false; }
}

export async function openDaytimePlan(el) {
  if (session?.pending && ownPanel(session)) return;
  const pending = state.departureReview;
  const planId = el?.dataset?.plan || pending?.planId;
  const stopId = el?.dataset?.stop || pending?.stopId;
  const plan = state.savedPlans.find(plan => plan.id === planId && plan.kind === 'plan');
  const stop = plan?.stops?.find(stop => stop.stopId === stopId);
  if (!plan || !stop) { toast('计划已变化，请重新查看后调整。', 'error'); return; }
  const today = dateKeyInTimeZone(new Date(), plan.timezone || 'Asia/Shanghai');
  const useSameDay = !pending && plan.localDate >= today && (stop.startMinutes ?? stop.plannedStartMinutes ?? 1440) < 540;
  const firstDate = useSameDay ? plan.localDate : new Date(Date.parse(`${plan.localDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  state.departureReview = null;
  session = { planId, owner: state.principal?.principalId, navigationRevision: state.navigationRevision, marker: null,
    params: { stopId, firstDate, expectedRevision: pending?.expectedRevision ?? plan.revision ?? 0 }, preview: null, pending: false };
  await requestPreview(session);
}

export function cancelDaytimePlan() { session = null; closeSheet(); }
export function recheckDaytimePlan() { if (session && ownPanel(session)) return requestPreview(session, true); }

export async function applyDaytimePlan() {
  const current = session;
  if (!current || !ownPanel(current) || current.pending || !current.preview) return;
  current.pending = true;
  current.marker.querySelectorAll('button:not([data-action="cancel-daytime-plan"])').forEach(button => { button.disabled = true; });
  const status = current.marker.querySelector('[role="status"]'); status.textContent = '正在保存白天安排……';
  try {
    const result = await api(`/api/v1/plans/${encodeURIComponent(current.planId)}/daytime-apply`, { method: 'POST', body: JSON.stringify({ ...current.params, previewKey: current.preview.previewKey }) });
    if (current.owner !== state.principal?.principalId) return;
    if (ownPanel(current)) state.savedPlans = result.plans;
    // A committed receipt must not turn into a failed-save prompt if a later refresh fails.
    let refreshFailed = false;
    await loadPlans().catch(() => { refreshFailed = true; });
    if (current.owner !== state.principal?.principalId) return;
    const canNavigate = ownPanel(current) && current.navigationRevision === state.navigationRevision;
    if (ownPanel(current)) cancelDaytimePlan();
    if (canNavigate) { state.planViewDate = result.dates[0]; navigate('today'); }
    else render();
    toast(`已将 ${result.movedCount} 次游览调整到白天${refreshFailed ? '；列表刷新暂时失败，稍后可重新查看' : ''}`);
  } catch (error) {
    if (ownPanel(current)) { current.pending = false; panel(current, daytimeErrorMessage(error)); }
  } finally { current.pending = false; }
}
