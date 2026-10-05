import { escapeHtml } from './format.js';
import { state } from './store.js';

const groups = [
  { entry:'home', title:'首页', pages:[['home','伴途随行']] },
  { entry:'places', title:'地点', pages:[['places','地点目录'],['place','地点详情'],['scene','地点现场']] },
  { entry:'today', title:'行程', pages:[['today','计划与进度'],['plan','方案候选'],['map','地图与路线'],['plan-history','往日记录']] },
  { entry:'community', title:'社区', pages:[['community','旅行帖子'],['plan-shares','方案分享']] },
  { entry:'mine', title:'我的', pages:[['mine','我的'],['favorites','我的收藏'],['memories','旅行记忆'],['achievements','旅行成就']] },
];
// 旧随行地址与导航统一落到首页，不再维护第二套随行页面。
export const canonicalView = view => view === 'companion' ? 'home' : view;
export const navigationGroup = view => view === 'moderation'
  ? groups.find(group => group.entry === 'mine')
  : view === 'post-detail'
  ? groups.find(group => group.entry === 'community')
  : groups.find(group => group.pages.some(([page]) => page === canonicalView(view)));

export function sectionNavigation(view) {
  if (view === 'post-detail' || view === 'moderation') return '';
  const group = navigationGroup(view);
  if (!group) return '';
  // 地点详情用自己的返回按钮，不显示「目录／详情」切换标签。
  const pages = group.entry === 'places'
    ? group.pages.filter(([page]) => page === 'places')
    : group.pages;
  // 只剩一个可去页面时切换条没有意义，直接不渲染。
  if (pages.length <= 1) return '';
  return `<nav class="section-navigation" aria-label="${escapeHtml(group.title)}内导航">${pages.map(([page,label]) => `<button data-nav="${page}" ${page === view ? 'class="active" aria-current="page"' : ''}>${escapeHtml(label)}</button>`).join('')}</nav>`;
}
