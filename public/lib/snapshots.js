import { api } from './api.js';
import { $, state, tripId, tripRevision } from './store.js';
import { escapeHtml, fmt, fmtWithDay, clockText } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { openDurationPickerPanel } from './ui-picker.js';
import { navigate, render } from './render.js';
import { loadTrip } from './loaders.js';
import { patchPlanStops } from './commands.js';
import { itineraryTiming, itineraryTimeLabel } from './itinerary-timing.js';
import { checkStartTime, currentTripClock } from './trip-clock.js';

/**
 * 直接恢复某一版本的计划：待进行站点整体回到该版本，
 * 已发生的事实（已完成/进行中/跳过）原样保留，不生成候选、不需要二次确认。
 */
export async function restoreVersion(revision, requestedDate = '') {
  const target = tripId(), baseRevision = tripRevision();
  const version = await api(`/api/v1/trips/${target}/versions/${revision}`);
  if (target !== tripId() || baseRevision !== tripRevision()) return;
  const mountDate = state.mountedDate || state.trip?.trip?.localDate;
  const targetDate = requestedDate || state.planViewDate || mountDate;
  const historicFallbackDate = targetDate === mountDate ? mountDate : '';
  const allStops = state.trip?.snapshot.stops || [];
  // 按所选日期隔离：其它日期的站点原样保留，只重建该日的计划。
  const otherDates = allStops.filter(stop => (stop.date ?? mountDate) !== targetDate);
  const facts = allStops
    .filter(stop => (stop.date ?? mountDate) === targetDate && stop.status !== 'planned')
    .map(stop => ({ ...stop, date: stop.date ?? targetDate }));
  const factIds = new Set(facts.map(stop => stop.stopId));
  const historicStops = (version.snapshot.stops || []).filter(stop =>
    (stop.date ?? historicFallbackDate) === targetDate && !factIds.has(stop.stopId));
  const stops = [
    ...otherDates,
    ...facts,
    ...historicStops.map(stop => ({ ...stop, status: stop.status === 'skipped' ? 'skipped' : 'planned', date: targetDate })),
  ];
  const currentDateIds = new Set(allStops.filter(stop => (stop.date ?? mountDate) === targetDate).map(stop => stop.stopId));
  const historicDateIds = new Set(historicStops.map(stop => stop.stopId));
  const belongsToDate = (leg, ids) => ids.has(leg.fromStopId) || ids.has(leg.toStopId);
  const routeLegs = [
    ...(state.trip?.snapshot.routeLegs || []).filter(leg => !belongsToDate(leg, currentDateIds)),
    ...(version.snapshot.routeLegs || []).filter(leg => belongsToDate(leg, historicDateIds)),
  ].filter((leg, index, all) => all.findIndex(item => item.legId === leg.legId) === index);
  const chargeDate = charge => charge.date ?? charge.localDate;
  const plannedCharges = [
    ...(state.trip?.snapshot.plannedCharges || []).filter(charge => chargeDate(charge) !== targetDate),
    ...(version.snapshot.plannedCharges || []).filter(charge =>
      chargeDate(charge) === targetDate || (chargeDate(charge) == null && targetDate === mountDate)),
  ];
  await api(`/api/v1/trips/${target}/plan-edits`, { method: 'POST', body: JSON.stringify({
    expectedRevision: baseRevision, allowPast: true, stops, routeLegs, plannedCharges,
  }) });
  closeSheet();
  await loadTrip(target);
  render();
  toast(`已恢复 ${targetDate} 的第 ${revision} 版计划，实际进度保留`);
}

const scheduledStart = stop => [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes]
  .find(Number.isFinite);
const scheduledEnd = stop => [stop.endMinutes, stop.plannedDepartureMinutes, stop.departureMinutes]
  .find(Number.isFinite);

function shiftStopSchedule(stop, delta) {
  const shifted = { ...stop };
  for (const field of ['travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes', 'endMinutes', 'departureMinutes', 'plannedDepartureMinutes']) {
    if (Number.isFinite(shifted[field])) shifted[field] += delta;
  }
  return shifted;
}

/** 将重叠的待计划地点顺延；实际进度固定，不能被计划编辑改写。 */
function orderAndAdjustStops(stops, fallbackDate) {
  const ordered = stops.map((stop, index) => ({ stop: { ...stop }, index }))
    .sort((left, right) => {
      const leftDate = left.stop.date ?? fallbackDate ?? '';
      const rightDate = right.stop.date ?? fallbackDate ?? '';
      const leftStart = scheduledStart(left.stop);
      const rightStart = scheduledStart(right.stop);
      return leftDate.localeCompare(rightDate) ||
        ((Number.isFinite(leftStart) ? leftStart : Number.POSITIVE_INFINITY) -
          (Number.isFinite(rightStart) ? rightStart : Number.POSITIVE_INFINITY)) ||
        left.index - right.index;
    });
  const adjusted = [];
  let group = null;
  let previousEnd = null;
  for (const entry of ordered) {
    let stop = entry.stop;
    if ((stop.status || 'planned') === 'skipped') continue;
    const date = stop.date ?? fallbackDate ?? '';
    const nextGroup = date ? 'dated' : 'undated';
    if (nextGroup !== group) { group = nextGroup; previousEnd = null; }
    let start = scheduledStart(stop);
    let end = scheduledEnd(stop);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const dayNumber = date ? Date.parse(`${date}T00:00:00.000Z`) / 86400000 : 0;
    const absoluteStart = dayNumber * 1440 + start;
    let absoluteEnd = dayNumber * 1440 + end;
    if (previousEnd !== null && absoluteStart < previousEnd) {
      if (stop.status && stop.status !== 'planned') {
        throw new Error(`「${stop.place?.name || stop.stopId}」与前面的实际进度时间重叠，请先纠正进度记录。`);
      }
      const delta = previousEnd - absoluteStart;
      stop = shiftStopSchedule(stop, delta);
      start = scheduledStart(stop);
      end = scheduledEnd(stop);
      entry.stop = stop;
      adjusted.push(stop);
      absoluteEnd = dayNumber * 1440 + end;
    }
    previousEnd = previousEnd === null ? absoluteEnd : Math.max(previousEnd, absoluteEnd);
  }
  return { stops: ordered.map(entry => entry.stop), adjusted };
}

export function editStopTime(stopId) {
  const stop = state.trip.snapshot.stops.find((item) => item.stopId === stopId);
  if (!stop || stop.status !== 'planned') return;
  state.timeEdit = { tripId: tripId(), revision: tripRevision(), stopId };
  const clock = currentTripClock();
  const timing = itineraryTiming(stop, state.trip.snapshot);
  const originalStart = timing.departure ?? stop.startMinutes ?? clock?.minutes ?? 9 * 60;
  const start = clock?.relation === 'today' ? Math.max(originalStart, clock.minutes) : originalStart;
  const leave = timing.leave;
  const end = Number.isFinite(leave) ? leave <= originalStart ? leave + 1440 : leave
    : originalStart + (stop.plannedDurationMinutes || stop.minDurationMinutes || 60) + (timing.minutes ?? 0);
  const minimumDuration = Math.min(480, (timing.minutes ?? 0) + 15);
  const duration = Math.max(minimumDuration, Math.min(480, end - originalStart || 60));
  const durationLabel = (m) => {
    const h = Math.floor(m / 60), r = m % 60;
    return h && r ? `${h} 小时 ${r} 分钟` : h ? `${h} 小时` : `${r} 分钟`;
  };
  openSheet(`<div class="sheet-head"><h3>调整 · ${escapeHtml(stop.place?.name || stopId)}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <div class="field"><label for="stopStart">预计出发时间</label><input id="stopStart" type="time" data-ui="picker" ${clock?.relation === 'today' ? `min="${fmt(clock.minutes)}"` : ''} value="${fmt(start)}" required></div>
    <div class="field"><label>预计持续时间</label><button type="button" id="stopDurationBtn" class="btn-soft" style="width:100%;text-align:left">${durationLabel(duration)}</button><input type="hidden" id="stopDuration" value="${duration}"></div>
    <p class="stop-meta">自动填入当前可用出发时间；持续时间包含前往和游览。后续未开始地点若重叠会顺延，实际进度保留。</p>
    <button class="btn-primary" data-action="preview-time">预览修改</button><p id="timeEditStatus" role="status"></p><div id="timeEditPreview" aria-live="polite"></div>`);
  const durationBtn = document.getElementById('stopDurationBtn');
  const durationInput = document.getElementById('stopDuration');
  durationBtn?.addEventListener('click', () => {
    const current = parseInt(durationInput?.value, 10) || 60;
    openDurationPickerPanel(durationBtn, current, (minutes) => {
      const fitted = Math.max(minimumDuration, minutes);
      durationInput.value = String(fitted);
      durationBtn.textContent = durationLabel(fitted);
    });
  });
}

export function previewStopTime() {
  const draft = state.timeEdit;
  if (!draft || draft.tripId !== tripId() || draft.revision !== tripRevision()) throw new Error('行程已有更新，请重新打开时间编辑。');
  if (draft.saving) return;
  draft.stop = null;
  $('timeEditPreview').innerHTML = '';
  $('timeEditStatus').textContent = '';
  let input = $('stopStart')?.value || '';
  let durationInput = parseInt($('stopDuration')?.value, 10);
  const parseTime = value => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('请填写有效的出发时间。');
    const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute;
  };
  if (!Number.isFinite(durationInput) || durationInput < 15 || durationInput > 480) {
    throw new Error('持续时间必须在 15-480 分钟之间。');
  }
  let departure = parseTime(input);
  const clock = currentTripClock();
  if (clock?.relation === 'today' && departure < clock.minutes) {
    departure = clock.minutes;input = fmt(departure);$('stopStart').value = input;
    $('timeEditStatus').textContent = '已填入当前可用出发时间，请核对下方预览。';
  }
  checkStartTime(departure);
  const old = state.trip.snapshot.stops.find(stop => stop.stopId === draft.stopId);
  if (!old || old.status !== 'planned') throw new Error('这个地点的进度已变化，请重新打开时间编辑。');
  const timing = itineraryTiming(old, state.trip.snapshot);
  const fittedDuration = Math.max(durationInput, (timing.minutes ?? 0) + 15);
  if (fittedDuration <= 480 && fittedDuration !== durationInput) {
    durationInput = fittedDuration;$('stopDuration').value = String(durationInput);
    const hours = Math.floor(durationInput / 60), minutes = durationInput % 60;
    $('stopDurationBtn').textContent = `${hours ? `${hours} 小时 ` : ''}${minutes ? `${minutes} 分钟` : ''}`.trim();
    $('timeEditStatus').textContent = '已留出已有路线时间与至少 15 分钟游览，请核对下方预览。';
  }
  const end = departure + durationInput;
  const start = departure + (timing.minutes ?? 0);
  if (start >= end) throw new Error('这段时间不足以完成前往，请增加持续时间。');
  draft.input = input; draft.durationInput = String(durationInput);
  const edited = { ...old, travelStartMinutes: departure, plannedArrivalMinutes:start, startMinutes:start, endMinutes:end, departureMinutes:end, plannedDurationMinutes:end-start };
  const reconciled = orderAndAdjustStops(state.trip.snapshot.stops.map(stop => stop.stopId === old.stopId ? edited : stop), state.trip.snapshot.travelDate || state.trip.snapshot.localDate);
  draft.stop = edited;
  draft.stops = reconciled.stops;
  const moved = reconciled.adjusted.map(stop => `<li>${escapeHtml(stop.place?.name || stop.stopId)} · ${fmt(stop.startMinutes)} - ${fmt(stop.endMinutes)}</li>`).join('');
  $('timeEditPreview').innerHTML = `<h4>确认这次修改</h4><p>${escapeHtml(old.place?.name || old.stopId)}</p><p>${fmtWithDay(timing.departure ?? old.startMinutes)} 出发 — ${fmtWithDay(timing.leave)} 离开 → ${fmtWithDay(departure)} 出发 — ${fmtWithDay(end)} 离开</p>${moved ? `<p class="stop-meta">为避免时间重叠，以下待进行地点会自动顺延：</p><ul>${moved}</ul>` : ''}<p class="stop-meta">保存为新快照，历史版本保留。</p><button class="btn-primary" data-action="save-time">确认保存</button>`;
}

export async function saveStopTime() {
  const draft = state.timeEdit;
  if (draft?.saving) return;
  if (!draft || draft.tripId !== tripId() || draft.revision !== tripRevision()) throw new Error('行程已有更新，请重新打开时间编辑。');
  if (!draft.stop || $('stopStart')?.value !== draft.input || $('stopDuration')?.value !== draft.durationInput) {
    previewStopTime();
    $('timeEditStatus').textContent = '内容已变化，请核对新的预览后再次确认。';
    return;
  }
  checkStartTime(draft.stop.travelStartMinutes);
  draft.saving = true;
  const controls = [...document.querySelectorAll('#stopStart, #stopDurationBtn, #stopDuration, [data-action="preview-time"], [data-action="save-time"]')];
  controls.forEach(control => { control.disabled = true; });
  $('timeEditStatus').textContent = '正在保存……';
  try {
    await patchPlanStops(draft.stops || state.trip.snapshot.stops.map((stop) => stop.stopId === draft.stopId ? draft.stop : stop));
    if (state.timeEdit !== draft || tripId() !== draft.tripId) return;
    state.timeEdit = null; closeSheet(); navigate('today'); toast('时间已保存，新快照可在历史中查看');
  } catch (error) {
    if (state.timeEdit === draft && $('timeEditStatus')) $('timeEditStatus').textContent = error.message;
    else throw error;
  } finally {
    draft.saving = false;
    controls.forEach(control => { control.disabled = false; });
  }
}
