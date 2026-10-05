/** 保留首页主卡、足迹与快捷入口，在旅程一览中整合随行。 */
import { placeCard, proposalBanner } from '../lib/components.js';
import { dateKeyInTimeZone, escapeHtml, monthDay } from '../lib/format.js';
import { state } from '../lib/store.js';
import { renderCompanion } from './companion.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { companionTarget } from '../lib/day-plan-selection.js';
import { smartCompanionEnabled } from '../lib/smart-companion-preferences.js';

// Brand illustration, rather than a geographic map or a planned route.
const landscape = `<div class="journey-art" aria-hidden="true">
  <div class="journey-postcard"><img src="/images/brand/city-day.svg" alt="" width="800" height="520" decoding="async"><div class="journey-postcard-foot"><span>下一站，好心情</span><svg viewBox="0 0 60 22" fill="none"><path d="M2 14c12-20 20 12 32-1S48 5 56 8m-7-7 8 7-10 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div>
  <span class="journey-sticker"><svg viewBox="0 0 24 24" fill="none"><path d="m12 2 2.6 6.9L22 12l-7.4 3.1L12 22l-2.6-6.9L2 12l7.4-3.1L12 2Z" fill="currentColor"/></svg>出去走走</span>
</div>`;

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfFootprintWeek(dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return shiftDateKey(dateKey, -((weekday + 6) % 7));
}

function footprintDateKey(memory) {
  const savedDate = memory.localDate || memory.journey?.localDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(savedDate || '')) return savedDate;
  const instant = Date.parse(String(memory.createdAt || memory.updatedAt || ''));
  if (!Number.isFinite(instant)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: memory.journey?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return ''; }
}

export function toggleHomeFootprint() {
  state.homeFootprintOpen = !state.homeFootprintOpen;
  if (typeof document === 'undefined') return;
  const card = document.querySelector('.home-impression');
  if (!card) return;
  const open = state.homeFootprintOpen;
  card.classList.toggle('is-flipped', open);
  const front = card.querySelector('.home-impression-front');
  const back = card.querySelector('.home-impression-back');
  front?.setAttribute('aria-hidden', String(open));
  front?.toggleAttribute('inert', open);
  back?.setAttribute('aria-hidden', String(!open));
  back?.toggleAttribute('inert', !open);
  card.querySelectorAll('.impression-flip, .impression-return').forEach(button => {
    button.setAttribute('aria-pressed', String(open));
  });
}

export function stepFootprintWeek(direction) {
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const currentWeek = startOfFootprintWeek(today);
  const shownWeek = startOfFootprintWeek(state.footprintWeekStart || today);
  const step = direction === 'next' || Number(direction) > 0 ? 1 : -1;
  const nextWeek = shiftDateKey(shownWeek, step * 7);
  if (step > 0 && nextWeek > currentWeek) return;
  state.footprintWeekStart = nextWeek;
}

function footprintCard(front) {
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const weekStart = startOfFootprintWeek(state.footprintWeekStart || today);
  const days = Array.from({ length: 7 }, (_, index) => shiftDateKey(weekStart, index));
  const countByDate = new Map();
  for (const memory of state.memories || []) {
    const date = footprintDateKey(memory);
    if (date && days.includes(date)) countByDate.set(date, (countByDate.get(date) || 0) + 1);
  }
  const recordedDays = days.filter(date => countByDate.has(date)).length;
  const recordCount = days.reduce((sum, date) => sum + (countByDate.get(date) || 0), 0);
  const first = days[0];
  const last = days[6];
  const weekLabel = first.slice(5).replace('-', '.') + ' — ' + last.slice(5).replace('-', '.');
  const calendar = days.map((date, index) => {
    const count = countByDate.get(date) || 0;
    const isToday = date === today;
    return `<div class="footprint-day${count ? ' has-memory' : ''}${isToday ? ' is-today' : ''}" role="listitem" aria-label="${date}${count ? `，${count} 条记忆` : '，暂无记忆'}"><span class="footprint-weekday">${WEEKDAY_LABELS[index]}</span><strong>${Number(date.slice(-2))}</strong><i aria-hidden="true"></i></div>`;
  }).join('');
  const hasPreviousWeek = weekStart > startOfFootprintWeek('2000-01-03');
  const hasNextWeek = shiftDateKey(weekStart, 7) <= startOfFootprintWeek(today);
  return `<div class="home-impression${state.homeFootprintOpen ? ' is-flipped' : ''}">
    <div class="home-impression-inner">
      <div class="home-impression-face home-impression-front" aria-hidden="${state.homeFootprintOpen ? 'true' : 'false'}" ${state.homeFootprintOpen ? 'inert' : ''}>${front}<button class="impression-flip" data-action="toggle-home-footprint" aria-label="查看旅行足迹" aria-pressed="${state.homeFootprintOpen ? 'true' : 'false'}">足迹</button></div>
      <div class="home-impression-face home-impression-back" aria-hidden="${state.homeFootprintOpen ? 'false' : 'true'}" ${state.homeFootprintOpen ? '' : 'inert'}>
        <section class="card footprint-card" aria-label="旅行足迹">
          <header class="footprint-head"><div class="footprint-title"><span class="footprint-title-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 18.5 9.2 5l5.2 14 5.6-13.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.2" cy="5" r="2" fill="currentColor"/><circle cx="14.4" cy="19" r="2" fill="currentColor"/></svg></span><div><h2>旅行足迹</h2><p>走过的日子，都值得记下</p></div></div><button class="impression-return" data-action="toggle-home-footprint" aria-label="返回首页卡片" aria-pressed="${state.homeFootprintOpen ? 'true' : 'false'}">返回</button></header>
          <div class="footprint-calendar-head"><button data-action="step-footprint-week" data-direction="previous" aria-label="上一周" ${hasPreviousWeek ? '' : 'disabled'}>‹</button><strong>${weekLabel}</strong><button data-action="step-footprint-week" data-direction="next" aria-label="下一周" ${hasNextWeek ? '' : 'disabled'}>›</button></div>
          <div class="footprint-calendar" role="list" aria-label="本周旅行记忆">${calendar}</div>
          <footer class="footprint-foot"><span><strong>${recordedDays}</strong> 天有记录 <i></i> 共 <strong>${recordCount}</strong> 条</span><button data-action="navigate" data-view="memories">查看记忆</button></footer>
        </section>
      </div>
    </div>
  </div>`;
}

export function renderHome() {
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const target = companionTarget(state.savedPlans || [], state.companionPlanId);
  const plan = target.plan;
  const conflict = target.phase === 'conflict';
  const completed = (plan?.stops || []).filter(stop => stop.status === 'completed').length;
  const pendingCount = (plan?.stops || []).filter(stop => ['planned', 'en_route', 'visiting'].includes(stop.status || 'planned')).length;
  const future = plan && plan.localDate > dateKeyInTimeZone(new Date(), plan.timezone || 'Asia/Shanghai');
  const heroLabel = conflict ? '核对完整安排' : future ? '看看出行安排' : target.phase === 'finished' ? '回顾今天' : plan ? `${['travel', 'visit'].includes(target.phase) ? '继续' : '开始'}随行` : '开始规划';
  const heroIcon = conflict || future || !plan ? 'calendar' : target.phase === 'finished' ? 'archive' : 'compass';
  const front = `<section class="hero-card home-hero"><div class="journey-copy"><p class="journey-eyebrow"><span class="journey-date">${escapeHtml(monthDay(today))}</span><span>今天，也有新发现</span></p><h2>${conflict ? '整理好安排，<br>再轻松出发。' : plan ? '按自己的节奏，<br>遇见好风景。' : '把日子过成<br>喜欢的风景。'}</h2><p>${conflict ? escapeHtml(target.reason) : plan ? `${escapeHtml(plan.name)}${future ? ` · ${escapeHtml(monthDay(plan.localDate))} 行前安排` : ''} · ${pendingCount} 个待进行 · 已完成 ${completed} 个` : '想去的地方，交给伴途安排。\n你只管带上好心情，出发。'}</p><div class="hero-actions"><button class="btn-primary" ${conflict ? 'data-action="view-companion-plan"' : plan ? 'data-action="focus-home-companion"' : 'data-action="navigate" data-view="today"'}>${buttonContent(heroIcon, heroLabel)}</button><button data-action="navigate" data-view="agent">${buttonContent('chat', '和伴途聊聊')}</button></div></div>${landscape}</section>`;
  return `<div class="home-intro">${footprintCard(front)}
    <div class="quick-grid home-shortcuts"><button class="quick-card" data-action="navigate" data-view="places" aria-label="发现地点"><span class="q-icon q-icon-place" aria-hidden="true">${uiIcon('pin', { size: 24 })}</span><strong>发现地点</strong><span>发现旅途里的小惊喜</span></button><button class="quick-card" data-action="navigate" data-view="today" aria-label="计划与进度"><span class="q-icon" aria-hidden="true">${uiIcon('calendar', { size: 24 })}</span><strong>计划与进度</strong><span>安排地点，记录今天</span></button></div>
    </div>${proposalBanner()}
    <div class="section-head"><h3>${escapeHtml(state.geoLabel || state.currentLocation?.name || '当前定位')} · 旅程一览</h3><button data-action="view-companion-plan">完整行程</button></div>
    <div class="smart-companion-entry"><div>${uiIcon('agent',{size:18})}<span>${smartCompanionEnabled(state.principal?.principalId)?'伴途正在留意附近的风景':'到达地点，让伴途陪你看一看'}</span></div><button class="btn-soft" data-action="open-smart-companion-settings">${uiIcon('display',{size:18})}<span>智能伴行</span></button></div>
    <section id="homeCompanion" class="home-companion" tabindex="-1" aria-label="首页随行">${renderCompanion({ showHeading: false })}</section>
    <div class="section-head"><h3>沿途灵感</h3><button data-action="navigate" data-view="places">全部地点</button></div>
    <div class="place-grid home-inspiration">${state.places.slice(0, 3).map(place => placeCard(place, { priority: true })).join('') || '<div class="card"><p class="stop-meta">还没有地点，去地点页找找旅行灵感。</p></div>'}</div>`;
}
