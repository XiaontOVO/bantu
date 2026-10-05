import { $, state } from './store.js';
import { escapeHtml } from './format.js';
import { api } from './api.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { render } from './render.js';
import { loadAllMemories } from './loaders.js';
import { loadPlans } from './plan-library.js';

let draft;
export { localInput as progressLocalInput };
function localInput(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** 输入按计划时区解释，不依赖浏览器所在时区；无效日期和不存在的当地时间拒绝保存。 */
export function progressTimestamp(value, timezone, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写实际发生时间。');
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) throw new Error('实际时间无效。');
  let instant = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = Date.parse(`${localInput(new Date(instant), timezone)}:00Z`);
    instant += wall - shown;
  }
  if (localInput(new Date(instant), timezone) !== value) throw new Error('实际时间无效，请检查日期和时刻。');
  if (instant > now.getTime()) throw new Error('实际发生时间不能在未来。');
  return new Date(instant).toISOString();
}

export function openProgressBackfill(planId, stopId) {
  if (state.executionPending) return;
  const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind === 'plan');
  const stop = plan?.stops?.find(item => item.stopId === stopId && (item.status || 'planned') === 'planned');
  if (!stop) throw new Error('地点的进度已变化，请刷新后重试。');
  draft = { planId, stopId, revision: plan.revision || 0, timezone: plan.timezone || 'Asia/Shanghai' };
  const now = localInput(new Date(), draft.timezone);
  openSheet(`<div class="sheet-head"><h3>补记进度 · ${escapeHtml(stop.place?.name || stop.placeId || stopId)}</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div>
    <label for="backfillType">实际进度</label><select id="backfillType"><option value="arrive">已经到达，正在游览</option><option value="complete">已经完成游览</option></select>
    <label for="backfillTime">实际发生时间</label><input id="backfillTime" type="datetime-local" value="${now}" max="${now}" />
    <p class="stop-meta">时间按行程当地时区记录。未记录到达就直接完成时，到达时间会标为未记录，不计算实际停留时长。</p>
    <p id="backfillMessage" role="status"></p><button class="btn-primary" data-action="save-progress-backfill">保存真实进度</button>`);
}

export async function saveProgressBackfill() {
  if (!draft || state.executionPending) return;
  const plan = (state.savedPlans || []).find(item => item.id === draft.planId);
  if (!plan || (plan.revision || 0) !== draft.revision) throw new Error('计划或进度已变化，请重新打开补记。');
  const type = $('backfillType').value;
  if (!['arrive', 'complete'].includes(type)) throw new Error('请选择实际进度。');
  const occurredAt = progressTimestamp($('backfillTime').value, draft.timezone);
  const message = $('backfillMessage');
  const controls = [...document.querySelectorAll('#backfillType, #backfillTime, [data-action="save-progress-backfill"]')];
  state.executionPending = { planId: plan.id, stopId: draft.stopId, type };
  controls.forEach(control => { control.disabled = true; });
  try {
    const updated = await api(`/api/v1/plans/${encodeURIComponent(plan.id)}/execution-events`, {
      method: 'POST', body: JSON.stringify({ stopId: draft.stopId, type, occurredAt, expectedRevision: draft.revision }),
    });
    state.savedPlans = state.savedPlans.map(item => item.id === updated.id ? updated : item);
    if (updated.migratedNextDayStops) await loadPlans().catch(() => {});
    if (type === 'complete') await loadAllMemories().catch(() => {});
    closeSheet(); toast('已补记真实进度');
  } catch (error) { if (message.isConnected) message.textContent = error.message; else throw error; }
  finally { state.executionPending = null; controls.forEach(control => { control.disabled = false; }); render(); }
}
