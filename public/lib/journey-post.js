import { cityName, escapeHtml, monthDay } from './format.js';

export function currentLocationCityName(label) {
  const location = String(label || '').trim();
  if (!location) return '';
  const match = location.match(/^(.+?(?:特别行政区|自治州|市|地区|盟))/);
  return match ? match[1].replace(/市$/, '') : '';
}

export function journeyPostSnapshot(memory, locationLabel = '') {
  const journey = memory?.journey;
  if (!journey || !Array.isArray(journey.places) || !journey.places.length) return null;
  const storedCity = cityName(journey.cityCode);
  return {
    // 旅行记忆里的城市是行程发生地；当前定位只作为旧数据缺少 cityCode 时的后备。
    currentCity: storedCity !== '未命名目的地' ? storedCity : currentLocationCityName(locationLabel),
    localDate: String(journey.localDate || ''),
    elapsedMinutes: Number.isSafeInteger(journey.elapsedMinutes) && journey.elapsedMinutes >= 0 ? journey.elapsedMinutes : null,
    places: journey.places
      .filter(place => typeof place?.name === 'string' && place.name.trim())
      .slice(0, 40)
      .map(place => ({
        name: place.name.trim().slice(0, 120),
        visitMinutes: Number.isSafeInteger(place.visitMinutes) && place.visitMinutes >= 0 ? place.visitMinutes : null,
      })),
  };
}

function durationText(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return '未完整记录';
  if (minutes === 0) return '不足 1 分钟';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours && remainder) return `${hours} 小时 ${remainder} 分钟`;
  if (hours) return `${hours} 小时`;
  return `${remainder} 分钟`;
}

function themeIndex(snapshot, places) {
  const seed = `${snapshot.currentCity}|${snapshot.localDate}|${places.map(place => place.name).join('|')}`;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 4;
}

export function renderJourneyPost(snapshot, { compact = false, fallbackLocationLabel = '' } = {}) {
  if (!snapshot || !Array.isArray(snapshot.places)) return '';
  const places = snapshot.places.filter(place => typeof place?.name === 'string' && place.name.trim()).slice(0, 40);
  if (!places.length) return '';
  const cityLabel = String(snapshot.currentCity || '').trim()
    || currentLocationCityName(fallbackLocationLabel)
    || '当前位置未知';
  const dateLabel = monthDay(snapshot.localDate);
  const stayCount = places.filter(place => Number.isSafeInteger(place.visitMinutes) && place.visitMinutes >= 0).length;
  const route = places.length > 1 ? `${places[0].name} → ${places[places.length - 1].name}` : places[0].name;
  const theme = `journey-post-theme-${themeIndex(snapshot, places)}`;

  if (compact) {
    const shownPlaces = places.slice(0, 3);
    return `<section class="journey-post-card journey-post-card-compact ${theme}" aria-label="旅行记忆：${escapeHtml(cityLabel)}，${places.length} 个地点">
      <div class="journey-post-compact-top"><span class="journey-post-eyebrow">旅途记忆</span><span>${escapeHtml(cityLabel)} · ${escapeHtml(dateLabel)}</span></div>
      <strong class="journey-post-compact-route">${shownPlaces.map((place, index) => `${index ? '<span class="journey-post-compact-arrow" aria-hidden="true">›</span>' : ''}<span>${escapeHtml(place.name)}</span>`).join('')}${places.length > shownPlaces.length ? `<span class="journey-post-more-stops">+${places.length - shownPlaces.length}</span>` : ''}</strong>
      <div class="journey-post-compact-stats"><span>${places.length} 个地点</span><span>记录跨度 ${escapeHtml(durationText(snapshot.elapsedMinutes))}</span>${stayCount ? `<span>${stayCount} 站有停留记录</span>` : ''}</div>
    </section>`;
  }

  const steps = places.map((place, index) => `<div class="journey-post-step" role="listitem">
    <span class="journey-post-step-marker" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
    <div class="journey-post-step-place"><span>第 ${index + 1} 站</span><strong>${escapeHtml(place.name)}</strong>${Number.isSafeInteger(place.visitMinutes) && place.visitMinutes >= 0 ? `<small>停留 ${escapeHtml(durationText(place.visitMinutes))}</small>` : ''}</div>
  </div>`).join('');
  return `<section class="journey-post-card journey-post-card-full ${theme}" aria-label="旅行记忆路线">
    <header class="journey-post-cover">
      <svg class="journey-post-art" viewBox="0 0 180 105" fill="none" aria-hidden="true"><path d="M5 85C34 78 32 38 66 53S104 76 124 38 153 25 175 9"/><circle cx="7" cy="85" r="5"/><circle cx="66" cy="53" r="5"/><circle cx="124" cy="38" r="5"/><circle cx="175" cy="9" r="6"/></svg>
      <div class="journey-post-cover-top"><span class="journey-post-eyebrow">伴途 · 旅行记忆</span><span class="journey-post-route-count">${places.length} 站</span></div>
      <p class="journey-post-date">${escapeHtml(cityLabel)} <span>·</span> ${escapeHtml(dateLabel)}</p>
      <h3>${escapeHtml(route)}</h3>
      <div class="journey-post-summary"><span><strong>${places.length}</strong><small>走过的地点</small></span><span class="journey-post-summary-rule"></span><span><strong>${escapeHtml(durationText(snapshot.elapsedMinutes))}</strong><small>当天记录跨度</small></span></div>
    </header>
    <div class="journey-post-route" role="list" aria-label="按顺序走过的地点">${steps}</div>
  </section>`;
}
