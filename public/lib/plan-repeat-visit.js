import { STATUS_LABEL, escapeHtml, formatTimeRange } from './format.js';
import { uiIcon } from './icons.js';

const startOf = stop => [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes].find(Number.isFinite);

/** 按实际开始日匹配：前一天 24:30 的安排也属于后一天，跳过的地点不算到访。 */
export function repeatedPlanVisits(days, placeId, targetDay) {
  if (!placeId) return [];
  return (days || []).flatMap((day, index) => (day.stops || [])
    .filter(stop => stop.status !== 'skipped' && (stop.placeId || stop.place?.placeId) === placeId &&
      (day.dayIndex ?? index) + Math.floor((startOf(stop) ?? 0) / 1440) === targetDay)
    .map(stop => ({ stop, dayIndex: day.dayIndex ?? index, planId: day.planId || '' })))
    .sort((a, b) => (startOf(a.stop) ?? 0) % 1440 - (startOf(b.stop) ?? 0) % 1440);
}

export function repeatVisitNotice({ place, matches, dayLabel }) {
  return `<section class="plan-repeat-notice" aria-label="已有到访安排">
    <div class="plan-repeat-heading"><span class="plan-repeat-icon" aria-hidden="true">${uiIcon('calendar', { size: 22 })}</span><div><span>${escapeHtml(dayLabel)}</span><strong>「${escapeHtml(place.name)}」的其他到访</strong></div></div>
    <ul class="plan-repeat-times">${matches.map(({ stop }) => {
      const start = startOf(stop), end = [stop.departureMinutes, stop.endMinutes, stop.plannedDepartureMinutes].find(Number.isFinite);
      const time = start === undefined || end === undefined || end < start ? '时间待确认' : formatTimeRange(start % 1440, end - Math.floor(start / 1440) * 1440);
      return `<li><span>${escapeHtml(time)}</span><small>${escapeHtml(STATUS_LABEL[stop.status || 'planned'] || '已安排')}</small></li>`;
    }).join('')}</ul>
    <p>本次将新增一次独立到访，已有安排和进度会保留。</p>
  </section>`;
}

export function focusPlanVisit(stopId) {
  const card = [...document.querySelectorAll('[data-plan-stop]')].find(item => item.dataset.planStop === stopId);
  if (!card) return;
  card.setAttribute('tabindex', '-1');
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'center', behavior: 'auto' });
}
