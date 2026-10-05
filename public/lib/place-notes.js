/** 我的地点私有备注：按账号按地点一条，仅自己可见（后端 placeNotes 存储）。 */
import { api } from './api.js';
import { $ } from './store.js';
import { state } from './store.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { render } from './render.js';
import { escapeHtml } from './format.js';
import { writingDraft, retainWritingDraft } from './writing-drafts.js';

let editing;
const loading = new Map();

/** 详情页渲染时按需拉取一次备注；拉取完成后重渲染补上内容。 */
export function maybeLoadPlaceNote(id) {
  const owner = state.principal?.principalId;
  const key = `${owner}:${id}`;
  if (!id || state.myPlaceNotes[id] !== undefined || loading.has(key)) return;
  const request = api(`/api/v1/places/${encodeURIComponent(id)}/note`).then(result => {
    if (owner !== state.principal?.principalId) return;
    state.myPlaceNotes[id] = result.note || '';
    if (state.currentView === 'place') render();
  }).catch(() => {}).finally(() => { if (loading.get(key) === request) loading.delete(key); });
  loading.set(key, request);
}

export async function editPlaceNote(id) {
  const owner = state.principal?.principalId;
  openSheet(`<div class="sheet-head"><h3>我的备注</h3><button data-action="close-sheet" class="icon-btn" aria-label="关闭">✕</button></div><p id="placeNoteLoading" role="status">正在读取备注…</p>`);
  const marker = $('placeNoteLoading');
  const result = await api(`/api/v1/places/${encodeURIComponent(id)}/note`);
  if (owner !== state.principal?.principalId || $('placeNoteLoading') !== marker) return;
  const current = result.note || '';
  const storage = writingDraft('place-note', id);
  const restored = storage.read();
  openSheet(`<div class="sheet-head"><h3>我的备注</h3><button data-action="close-sheet" class="icon-btn" aria-label="关闭">✕</button></div>
    <div class="field"><label for="myPlaceNoteInput">私有备注</label><textarea id="myPlaceNoteInput" rows="4" maxlength="500" placeholder="例如：周二闭馆，记得在公众号预约">${escapeHtml(restored?.text ?? current)}</textarea></div>
    <p class="stop-meta">最多 500 个字。备注只对自己可见；清空保存即删除。</p>
    <p id="placeNoteDraftStatus" class="stop-meta" role="status">${restored ? '已恢复未保存的备注，可继续编辑。' : ''}</p>
    <p id="placeNoteSaveStatus" class="stop-meta" role="alert"></p>
    <button class="btn-primary" data-action="save-place-note" data-place="${escapeHtml(id)}">保存备注</button>`);
  const input = $('myPlaceNoteInput');
  const capture = retainWritingDraft(storage, { text: input }, $('placeNoteDraftStatus'));
  editing = { id, owner, storage, input, capture, saving: false };
}

export async function savePlaceNote(button) {
  const context = editing;
  if (!context || context.saving || context.id !== button.dataset.place || context.owner !== state.principal?.principalId || $('myPlaceNoteInput') !== context.input) return;
  const captured = context.capture();
  if (captured.text.length > 500) { $('placeNoteSaveStatus').textContent = '备注最多 500 个字，请缩短后保存。'; return; }
  context.storage.save(captured);
  context.saving = true; button.disabled = true; context.input.disabled = true;
  try {
    const result = await api(`/api/v1/places/${encodeURIComponent(context.id)}/note`, { method: 'POST', body: JSON.stringify({ note: captured.text }) });
    context.storage.clearIf(captured);
    if (context.owner !== state.principal?.principalId) return;
    state.myPlaceNotes[context.id] = result.note || '';
    if ($('myPlaceNoteInput') === context.input) closeSheet();
    if (state.currentView === 'place') render();
    toast('备注已保存');
  } catch (error) {
    if (context.owner === state.principal?.principalId && $('myPlaceNoteInput') === context.input) {
      $('placeNoteSaveStatus').textContent = `保存失败，输入仍保留。${error.message === 'Failed to fetch' ? '请检查连接后重试。' : error.message}`;
    }
  } finally {
    context.saving = false; button.disabled = false; context.input.disabled = false;
  }
}
