import { state } from './store.js';
import { escapeHtml } from './format.js';

const generations = new Map();

export async function loadTracked(key, loader) {
  state.loadStatus ||= {};
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  state.loadStatus[key] = { status: 'loading', message: '' };
  try {
    await loader();
    if (generations.get(key) === generation) state.loadStatus[key] = { status: 'loaded', message: '' };
    return true;
  } catch (error) {
    if (generations.get(key) === generation) {
      state.loadStatus[key] = {
        status: 'error',
        message: error instanceof Error ? error.message : '请求失败，请稍后重试。',
      };
    }
    return false;
  }
}

export function hasLoadError(key) {
  return state.loadStatus?.[key]?.status === 'error';
}

export function loadErrorBanner(keys) {
  const labels = {
    favorites: '收藏', plans: '方案', memories: '旅行记忆', achievements: '旅行成就',
    community: '社区内容', 'post-detail': '帖子详情', places: '地点', messages: '对话记录',
  };
  const failed = [...new Set(keys)].filter(hasLoadError);
  if (!failed.length) return '';
  const names = failed.map(key => labels[key] || key).join('、');
  const details = failed.map(key => state.loadStatus[key].message).filter(Boolean);
  return `<section class="card load-error" role="alert"><strong>${names}暂时没有加载成功</strong><p>${details.length ? escapeHtml(details[0]) : '请检查连接后重试。'}</p><button class="btn-small btn-primary" data-action="retry-current-view">重试</button></section>`;
}
