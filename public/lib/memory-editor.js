import { $, state, tripId, usesSavedDayPlans } from './store.js';
import { api } from './api.js';
import { escapeHtml } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { loadAllMemories } from './loaders.js';
import { loadTracked } from './load-state.js';
import { render, navigate } from './render.js';
import { sendChat } from './commands.js';
import { openMemoryEditDraft, askDiscardMemoryEdit, confirmDiscardMemoryEdit } from './memory-edit-draft.js';

let editing;
let busy = false;
let personalMemoriesPromise;
let editRequestSequence = 0;
const personalMemoryScope = () => `all+personal:${state.principal?.username || state.principal?.kind || 'guest'}`;
const heading = (title) => `<div class="sheet-head"><h3>${title}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>`;

/** Load account-owned notes alongside archived trip memories without needing a current Trip. */
export async function loadPersonalMemories({ force = false } = {}) {
  if (!usesSavedDayPlans()) return false;
  const scope = personalMemoryScope();
  if (!force && state.memoriesScope === scope) return true;
  if (personalMemoriesPromise) return personalMemoriesPromise;
  const request = loadTracked('memories', async () => {
    const personal = [];
    let cursor = '';
    let pageCount = 0;
    do {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
      const page = await api(`/api/v1/memories${suffix}`, {}, true);
      personal.push(...(page.data || []));
      cursor = page.meta?.nextCursor || '';
      pageCount += 1;
    } while (cursor && pageCount < 100);
    if (!usesSavedDayPlans() || personalMemoryScope() !== scope) return;
    const archivedTripMemories = (state.memories || []).filter(memory => memory.tripId);
    state.memories = [...archivedTripMemories, ...personal]
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    state.memoriesScope = scope;
  });
  personalMemoriesPromise = request;
  try { return await request; }
  finally { if (personalMemoriesPromise === request) personalMemoriesPromise = null; }
}

export function ensurePersonalMemoriesLoaded() {
  // A failed request must remain visible so the page can show its retry card.
  // Retrying from render() would immediately replace the error with "loading"
  // and, on a persistent outage, create a render/request loop. The explicit
  // refresh action calls loadAllMemories() and is the retry boundary.
  if (!usesSavedDayPlans() || state.memoriesScope === personalMemoryScope() || personalMemoriesPromise || state.loadStatus?.memories?.status === 'error') return;
  void loadPersonalMemories().then(() => {
    if (state.currentView === 'memories') render();
  });
}

/** Keep a committed write visible even when the follow-up archive request fails. */
export async function applyMemoryResultAndRefresh(memory, { deleted = false, refresh = loadAllMemories } = {}) {
  if (memory) {
    const matches = (entry) => entry.memoryId === memory.memoryId && entry.tripId === memory.tripId;
    if (deleted || memory.deletedAt) {
      state.memories = (state.memories || []).filter(entry => !matches(entry));
    } else {
      const entries = (state.memories || []).filter(entry => !matches(entry));
      entries.push(memory);
      state.memories = entries.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }
  }
  return loadTracked('memories', refresh);
}

export async function editMemory(id, targetTrip) {
  if (busy) { toast('记录正在保存，请稍候。'); return; }
  const request = ++editRequestSequence;
  const owner = state.principal?.principalId, view = state.currentView;
  const personal = !targetTrip && usesSavedDayPlans();
  const target = personal ? '' : targetTrip || tripId();
  const memory = personal
    ? await api(`/api/v1/memories/${encodeURIComponent(id)}`)
    : await api(`/api/v1/trips/${target}/memories/${encodeURIComponent(id)}`);
  if (request !== editRequestSequence || owner !== state.principal?.principalId || view !== state.currentView) return;
  if (!memory) throw new Error('这条记录已不存在，请刷新列表。');
  editing = openMemoryEditDraft(memory, { personal, target });
}
export function discardMemoryEdit() {
  if (busy) { toast('记录正在保存，请稍候。'); return; }
  const context = editing;
  askDiscardMemoryEdit(context, () => { if (editing === context) { editing = null; closeSheet(); } });
}
export { confirmDiscardMemoryEdit };
export async function saveMemoryEdit(button) {
  if (busy) return;
  const draft = editing;
  const input = $('editMemoryText');
  if (!draft || input !== draft.input || draft.ownerId !== state.principal?.principalId) return;
  const captured = draft.capture(), text = captured.text.trim();
  if (!text) { $('memoryEditStatus').textContent = '记录内容不能为空；如需移除，请使用删除。'; return; }
  if (draft.conflict && !$('memoryEditReviewed')?.checked) {
    $('memoryEditStatus').textContent = '原记录已更新，请先查看最新内容并勾选确认，或放弃这份草稿。'; return;
  }
  const expectedEntryVersion = draft.conflict ? draft.latestVersion : draft.entryVersion;
  busy = true; button.disabled = true; input.disabled = true;
  try {
    if (draft.personal) {
      const result = await api(`/api/v1/memories/${encodeURIComponent(draft.memoryId)}`, {
        method: 'PATCH', body: JSON.stringify({ userText: text, expectedEntryVersion }),
      });
      draft.storage.clearIf(captured);
      if (draft.ownerId !== state.principal?.principalId) return;
      const refresh = applyMemoryResultAndRefresh(result, {
        refresh: () => loadPersonalMemories({ force: true }),
      });
      if (editing === draft) editing = null;
      if ($('editMemoryText') === input) closeSheet();
      render();
      const refreshed = await refresh;
      if (draft.ownerId !== state.principal?.principalId) return;
      render();
      toast(refreshed ? '修改已保存' : '修改已保存，但列表刷新失败；请重试。', refreshed ? 'info' : 'error');
      return;
    }
    // 内容版本取最新值，但条目版本仍用编辑开始时的值，避免覆盖另一窗口的修改。
    const current = await api(`/api/v1/trips/${draft.targetTrip}`);
    if (draft.ownerId !== state.principal?.principalId) return;
    const result = await api(`/api/v1/trips/${draft.targetTrip}/memories/${draft.memoryId}`, { method: 'PATCH', body: JSON.stringify({
      userText: text, expectedContentRevision: current.trip.contentRevision, expectedEntryVersion,
    }) });
    draft.storage.clearIf(captured);
    if (draft.ownerId !== state.principal?.principalId) return;
    const refresh = applyMemoryResultAndRefresh(result.memory);
    if (editing === draft) editing = null;
    if ($('editMemoryText') === input) closeSheet();
    render();
    const refreshed = await refresh;
    if (draft.ownerId !== state.principal?.principalId) return;
    render();
    toast(refreshed ? '修改已保存' : '修改已保存，但列表刷新失败；可点“刷新”重试。', refreshed ? 'info' : 'error');
  } catch (error) {
    if (draft.ownerId !== state.principal?.principalId) return;
    draft.storage.save(captured);
    const message = `${error.message} 你输入的内容仍保留在草稿中；可重新打开这条记忆核对后继续。`;
    if ($('editMemoryText') === input && $('memoryEditStatus')) $('memoryEditStatus').textContent = message;
    else toast(message, 'error');
  }
  finally { busy = false; button.disabled = false; input.disabled = false; }
}
export function askDeleteMemory(id, targetTrip) {
  const personal = !targetTrip && usesSavedDayPlans();
  const trip = personal ? '' : targetTrip || tripId() || '';
  const memory = state.memories.find((item) => item.memoryId === id && (personal ? !item.tripId : item.tripId === trip));
  if (!memory) return;
  openSheet(`${heading('删除这条记忆？')}<p style="white-space:pre-wrap">${escapeHtml(memory.userText)}</p><p class="stop-meta">删除后，这条内容将从旅行记忆中移除。</p><div class="stop-actions"><button class="btn-danger" data-action="confirm-delete-memory" data-memory="${escapeHtml(id)}" data-trip="${escapeHtml(trip)}">确认删除</button><button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
}
export async function deleteMemory(button) {
  if (busy) return;
  const targetTrip = button.dataset.trip || '';
  const memoryId = button.dataset.memory;
  busy = true; button.disabled = true;
  try {
    if (!targetTrip && usesSavedDayPlans()) {
      const memory = state.memories.find(item => item.memoryId === memoryId && !item.tripId);
      await api(`/api/v1/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
      const refresh = applyMemoryResultAndRefresh(memory, {
        deleted: true,
        refresh: () => loadPersonalMemories({ force: true }),
      });
      closeSheet(); render();
      const refreshed = await refresh;
      render();
      toast(refreshed ? '记录已删除' : '记录已删除，但列表刷新失败；请重试。', refreshed ? 'info' : 'error');
      return;
    }
    if (!targetTrip) throw new Error('当前没有可用的旅行。');
    const result = await api(`/api/v1/trips/${targetTrip}/memories/${memoryId}`, { method: 'DELETE' });
    const refresh = applyMemoryResultAndRefresh(result.memory, { deleted: true });
    closeSheet(); render();
    const refreshed = await refresh;
    render();
    toast(refreshed ? '记录已删除' : '记录已删除，但列表刷新失败；可点“刷新”重试。', refreshed ? 'info' : 'error');
  } finally { busy = false; button.disabled = false; }
}
export async function sendMemoryToAgent() {
  const input = $('memoryText'); const text = input?.value.trim();
  if (!text) { toast('先写下要记录的内容'); return; }
  input.value = ''; navigate('agent'); await sendChat(`帮我记下：${text}`);
}
