import { escapeHtml, categoryLabel } from './format.js';
import { api } from './api.js';
import { $, state } from './store.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { loadPlaces, loadCommunity } from './loaders.js';
import { render } from './render.js';
import { refreshPlaceDetailAfterMutation } from './place-detail.js';

export function tagChips(place, addTagAction, { includeProviderTag = true } = {}) {
  const tags = place.tags || [{ label: categoryLabel(place.category), source: 'official' }];
  const chips = tags.map(tag => `<span class="chip ${tag.source === 'user' ? 'user' : ''}" title="${tag.source === 'user' ? '仅自己可见的标签' : '平台统一分类标签'}">${escapeHtml(tag.label)}</span>`);
  // 旅友发现＝旅友推荐并通过平台收录的地点；作为绿色标记混排在标签里，不再单出徽标。
  if (includeProviderTag && place.provider === 'community_reviewed') chips.push('<span class="chip green" title="旅友发现 · 已通过平台收录">旅友发现</span>');
  // 加号＝添加我的标签入口，尺寸与标签一致。
  if (addTagAction) chips.push(`<button class="chip chip-add" data-action="${addTagAction}"${place.placeId ? ` data-place="${escapeHtml(place.placeId)}"` : ''} title="添加我的标签" aria-label="添加我的标签">＋</button>`);
  return `<div class="tag-list">${chips.join('') || '<span class="stop-meta">暂未添加标签</span>'}</div>`;
}
export function tagOptions() {
  return `<div class="field"><label>官方标签（可多选）</label><div class="tag-list">${(state.officialTags || []).map(tag => `<label><input type="checkbox" name="officialTag" value="${escapeHtml(tag.id)}"> ${escapeHtml(tag.label)}</label>`).join('')}</div><p class="stop-meta">标签由平台统一提供，选择标签不代表平台已核实该地点。</p></div>`;
}
export function splitTags(text) { return text.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean); }
export async function editPlaceTags(id) {
  const result = await api(`/api/v1/places/${encodeURIComponent(id)}/tags`);
  state.tagEditorId = id;
  openSheet(`<div class="sheet-head"><h3>我的地点标签</h3><button data-action="close-sheet" class="icon-btn" aria-label="关闭">✕</button></div><div class="field"><label for="customPlaceTags">自定义标签</label><input id="customPlaceTags" value="${escapeHtml(result.customTags.join('，'))}" placeholder="例如：日落很美，小众安静"></div><p class="stop-meta">最多 8 个，用逗号分隔，每个不超过 20 个字。标签只对自己可见；清空可移除自己添加的标签。</p><button class="btn-primary" data-action="save-place-tags">保存标签</button>`);
}
export async function savePlaceTags() {
  const id = state.tagEditorId;
  const customTags = splitTags($('customPlaceTags').value);
  if (customTags.length > 8) { toast('自定义标签最多 8 个。', 'error'); return; }
  if (customTags.some(tag => tag.length > 20)) { toast('每个自定义标签最多 20 个字。', 'error'); return; }
  await api(`/api/v1/places/${encodeURIComponent(id)}/tags`, { method: 'POST', body: JSON.stringify({ customTags }) });
  // 标签写入成功后，列表刷新只是同步画面；其中一个目录暂时不可用不应把成功操作报成失败。
  await Promise.allSettled([loadPlaces(), loadCommunity(), refreshPlaceDetailAfterMutation(id)]); closeSheet(); render(); toast('标签已保存');
}
