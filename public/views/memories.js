/** 我的旅行记忆：保存的手记与按真实进度生成的路线回忆。 */
import { emptyState } from '../lib/components.js';
import { cityName, escapeHtml, monthDay } from '../lib/format.js';
import { state, usesSavedDayPlans } from '../lib/store.js';
import { hasLoadError } from '../lib/load-state.js';
import { currentLocationCityName } from '../lib/journey-post.js';
import { ensurePersonalMemoriesLoaded } from '../lib/memory-editor.js';
import { uiIcon } from '../lib/icons.js';
import { guestRetentionNotice } from '../lib/account-retention.js';

function durationText(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '未完整记录';
  // 旧记忆里可能存有路线估算的小数分钟（高德秒数 ÷ 60），展示一律取整。
  const total = Math.round(minutes);
  if (total === 0) return '不足 1 分钟';
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours && remainder) return `${hours} 小时 ${remainder} 分钟`;
  if (hours) return `${hours} 小时`;
  return `${remainder} 分钟`;
}

function timeText(value, timezone) {
  const instant = Date.parse(String(value || ''));
  if (!Number.isFinite(instant)) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
  } catch {
    return '';
  }
}

function savedAtText(value, timezone = 'Asia/Shanghai') {
  const instant = Date.parse(String(value || ''));
  if (!Number.isFinite(instant)) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
  } catch {
    return '';
  }
}

function transportText(mode) {
  return ({ walking: '步行', transit: '公交', driving: '驾车' })[mode] || '';
}

function memoryTheme(memory, journey) {
  const palette = ['coast', 'grove', 'sunset', 'lavender'];
  const seed = `${memory.tripId}|${memory.memoryId}|${journey.cityCode}|${journey.localDate}|${journey.places?.map(place => place.name).join('|') || ''}`;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function memoryActions(memory) {
  const tripAttribute = memory.tripId ? `data-trip="${escapeHtml(memory.tripId)}"` : '';
  const share = `<button class="btn-small btn-soft" data-action="share-memory" data-memory="${escapeHtml(memory.memoryId)}" ${tripAttribute} ${memory.staleAt ? 'disabled' : ''} title="预览并发帖" aria-label="预览并发帖">分享</button>`;
  const changedHistory = memory.staleAt && !memory.tripId && memory.sourcePlanId;
  const history = changedHistory ? `<button class="btn-small btn-soft" data-action="view-plan-history" data-plan="${escapeHtml(memory.sourcePlanId)}">查看更新记录</button>` : '';
  return `<div class="stop-actions"><button class="btn-small btn-soft" data-action="edit-memory" data-memory="${escapeHtml(memory.memoryId)}" ${tripAttribute} ${memory.staleAt && !changedHistory ? 'disabled' : ''}>${memory.journey ? '补写你的感受' : '编辑'}</button>${history}${share}<button class="btn-small btn-ghost" data-action="delete-memory" data-memory="${escapeHtml(memory.memoryId)}" ${tripAttribute}>删除</button></div>`;
}

function renderJourneyMemory(memory) {
  const journey = memory.journey;
  const [titleLine, ...bodyLines] = memory.userText.split(/\r\n|\n|\r/);
  const title = titleLine.trim() || '这一天，走过的路';
  const story = bodyLines.join('\n').trim();
  const places = journey.places || [];
  // 旅行记忆展示历史行程的城市，不能随着用户现在的定位变化。
  const storedCity = cityName(journey.cityCode);
  const cityLabel = storedCity !== '未命名目的地' ? storedCity : (currentLocationCityName(state.geoLabel) || '当前位置未知');
  const duration = durationText(journey.elapsedMinutes);
  const firstPlace = places[0]?.name || '旅途起点';
  const lastPlace = places[places.length - 1]?.name || firstPlace;
  const routeCaption = places.length > 1 ? `${firstPlace} → ${lastPlace}` : `${firstPlace} · 慢慢走过的一天`;
  const firstTime = timeText(journey.firstEventAt, journey.timezone);
  const lastTime = timeText(journey.completedAt, journey.timezone);
  const timeCaption = firstTime && lastTime && journey.elapsedMinutes !== null
    ? `${firstTime} 开始记录 · ${lastTime} 最后完成`
    : firstTime ? `${firstTime} 开始记录` : '当天行程记录';
  const path = places.map((place, index) => {
    const arrive = timeText(place.arrivedAt, journey.timezone);
    const complete = timeText(place.completedAt, journey.timezone);
    const times = [arrive ? `到达 ${arrive}` : '', complete ? `完成 ${complete}` : ''].filter(Boolean).join(' · ');
    const transfer = index < places.length - 1
      ? places[index + 1]
      : null;
    const mode = transportText(transfer?.transferMode);
    const transferLabel = transfer
      ? [mode, transfer.transferMinutes !== null && transfer.transferMinutes !== undefined ? `预计 ${durationText(transfer.transferMinutes)}` : ''].filter(Boolean).join(' · ')
      : '';
    return `<div class="journey-memory-step" role="listitem">
      <div class="journey-memory-stop">
        <span class="journey-memory-marker" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <article class="journey-memory-place"><span class="journey-memory-kicker">第 ${index + 1} 站</span><h4>${escapeHtml(place.name)}</h4>${times ? `<p class="journey-memory-time">${escapeHtml(times)}</p>` : '<p class="journey-memory-time">时间未记录</p>'}${place.visitMinutes !== null && place.visitMinutes !== undefined ? `<span class="journey-memory-stay">停留 ${escapeHtml(durationText(place.visitMinutes))}</span>` : ''}</article>
      </div>
      ${transfer ? `<div class="journey-memory-connector"><span>${escapeHtml(transferLabel || '继续前行')}</span></div>` : ''}
    </div>`;
  }).join('');
  const generatedLabel = memory.staleAt ? (!memory.tripId && memory.sourcePlanId ? '来源已更新' : '行程有改动') : journey.generatedBy === 'expiry' ? '到期后自动保存' : '';
  const originBadge = generatedLabel ? `<span class="journey-memory-origin">${generatedLabel}</span>` : '';
  return `<article class="memory-card journey-memory-card journey-memory-theme-${memoryTheme(memory, journey)}">
    <header class="journey-memory-cover">
      <svg class="journey-memory-cover-art" viewBox="0 0 190 124" fill="none" aria-hidden="true"><path class="journey-memory-art-hill" d="M4 102C29 78 44 88 67 61S107 72 124 42 158 20 187 8"/><path class="journey-memory-art-route" d="M7 94C36 83 42 54 76 64S113 88 136 49 157 44 181 20"/><circle class="journey-memory-art-point" cx="7" cy="94" r="5"/><circle class="journey-memory-art-point" cx="76" cy="64" r="5"/><circle class="journey-memory-art-point" cx="136" cy="49" r="5"/><circle class="journey-memory-art-point journey-memory-art-point-end" cx="181" cy="20" r="6"/></svg>
      <div class="row-between journey-memory-cover-top"><span class="journey-memory-mark">伴途 · 旅途记忆</span>${originBadge}</div>
      <p class="journey-memory-date">${escapeHtml(cityLabel)} <span>·</span> ${escapeHtml(monthDay(journey.localDate))}</p>
      <h3>${escapeHtml(title)}</h3>
      <p class="journey-memory-route-caption">${escapeHtml(routeCaption)}</p>
      <div class="journey-memory-timeband"><span class="journey-memory-time-icon" aria-hidden="true">◷</span>${escapeHtml(timeCaption)}</div>
      <div class="journey-memory-summary"><span><strong>${places.length}</strong><small>走过的地点</small></span><span class="journey-memory-summary-rule"></span><span><strong>${escapeHtml(duration)}</strong><small>${journey.elapsedMinutes === null ? '时间记录不完整' : '首条进度到最后完成'}</small></span></div>
    </header>
    <div class="journey-memory-content">
      <p class="journey-memory-story">${escapeHtml(story || '当天去过的地点和路线都记录在这里。')}</p>
      ${memory.staleAt ? `<p class="journey-memory-stale" role="status">${!memory.tripId && memory.sourcePlanId ? '原日计划的进度已更新，这里保留更新前的路线记录，仍可补写旅途感受。' : '行程已调整，这里保留原记录。'}</p>` : ''}
      <div class="journey-memory-path" role="list" aria-label="当天走过的地点">${path}</div>
      ${memoryActions(memory)}
      <div class="stop-meta">保存于 ${escapeHtml(savedAtText(memory.updatedAt || memory.createdAt, journey.timezone))}</div>
    </div>
  </article>`;
}

function renderNote(memory) {
  const [firstLine, ...lines] = memory.userText.split(/\r\n|\n|\r/);
  const title = (memory.title || firstLine).trim() || '未命名笔记';
  const body = memory.content ?? lines.join('\n');
  const sourceTripView = (state.trips || []).find(item => (item.trip?.tripId || item.tripId) === memory.tripId);
  const sourceTrip = sourceTripView?.trip || sourceTripView;
  const memoryDate = memory.localDate || sourceTrip?.localDate;
  const storedCity = cityName(sourceTrip?.cityCode);
  const currentCity = currentLocationCityName(state.geoLabel);
  const locationLabel = storedCity !== '未命名目的地' ? storedCity : (currentCity || '当前位置未知');
  const memoryLabel = memory.tripId
    ? `${locationLabel}${memoryDate ? ` · ${monthDay(memoryDate)}` : ''}`
    : `随手记${memoryDate ? ` · ${monthDay(memoryDate)}` : ''}`;
  return `<article class="memory-card"><div class="memory-note-heading"><h4>${escapeHtml(title)}</h4><span class="chip ${memory.staleAt ? 'amber' : 'green'}">${memory.staleAt ? '来源已变化' : '已保存'}</span></div>${body ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(body)}</p>` : ''}<div class="stop-meta">${escapeHtml(memoryLabel)} · ${escapeHtml(savedAtText(memory.updatedAt || memory.createdAt, sourceTrip?.timezone || 'Asia/Shanghai'))}</div>${memoryActions(memory)}</article>`;
}

export function renderMemories() {
  ensurePersonalMemoriesLoaded();
  const standaloneMode = usesSavedDayPlans();
  const memories = state.memories || [];
  return `
    <div class="page-head memory-page-head"><h2>旅行记忆</h2><span class="chip">${hasLoadError('memories') ? '暂未加载' : `${memories.length} 条`}</span><div class="page-head-actions"><button class="btn-soft" data-action="open-plan-history">往日记录</button>${standaloneMode ? '<button class="btn-primary" data-action="write-day-note">写笔记</button>' : ''}<button class="btn-ghost" data-action="load-memories">刷新</button></div></div>
    ${guestRetentionNotice(state.principal)}
    ${!standaloneMode ? `<div class="card composer journey-memory-composer">
      <div><strong>给这趟旅程留句话</strong><p class="stop-meta">完成的地点会整理成路线，也可以写下这趟旅行的感受。</p></div>
      <textarea id="memoryText" rows="3" placeholder="西湖的一天&#10;今天和妈妈逛得很开心……" aria-label="输入旅行记录"></textarea>
      <div class="stop-actions"><button class="btn-good" data-action="add-memory">保存手记</button><button class="btn-soft" data-action="memory-to-agent">整理这段记录</button></div>
    </div>` : ''}
    <div class="content-card-grid">${memories.length ? memories.map(memory => memory.journey ? renderJourneyMemory(memory) : renderNote(memory)).join('') : hasLoadError('memories') ? '' : emptyState(standaloneMode ? '还没有随手记' : '还没有旅行记忆', standaloneMode ? '写下第一条，之后还可以继续编辑。' : '完成一站后，可以把当天走过的地点连成一段记忆。', '', '')}</div>`;
}
