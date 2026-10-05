import { $, state } from './store.js';
import { escapeHtml } from './format.js';
import { writingDraft } from './writing-drafts.js';
import { openSheet, toast } from './ui.js';

let pendingDiscard = null;
let discardSequence = 0;
const heading = title => `<div class="sheet-head"><h3>${title}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>`;

export function openMemoryEditDraft(memory, { personal, target }) {
  const storage = writingDraft('memory-edit', `${target || 'personal'}:${memory.memoryId}`);
  const restored = storage.read();
  const version = Number.isSafeInteger(restored?.entryVersion) && restored.entryVersion > 0 ? restored.entryVersion : memory.entryVersion;
  const text = typeof restored?.text === 'string' ? restored.text : memory.userText;
  const conflict = version !== memory.entryVersion;
  const hint = memory.journey ? memory.staleAt ? '原日计划的进度已更新，这里保留此前的路线；这里只编辑标题与旅途感受。' : '这里只编辑标题与旅途感受，路线与时间仍来自实际进度。' : '保存后才会修改原记录；关闭后可以继续草稿。';
  openSheet(`${heading(memory.journey ? '补写这段旅途' : '编辑旅行记忆')}
    <div class="field"><label for="editMemoryText">${memory.journey ? '标题与旅途感受（第一行是标题）' : '记忆内容（第一行是标题）'}</label><textarea id="editMemoryText" rows="8" maxlength="20000">${escapeHtml(text)}</textarea></div>
    <p id="memoryEditDraftStatus" class="stop-meta">${restored ? '已恢复未保存的修改。' + hint : hint}</p>
    ${conflict ? `<section class="memory-edit-conflict"><p>原记录已在其他页面更新，你的草稿已保留。请先核对最新内容。</p><details><summary>查看最新已保存内容</summary><p class="memory-edit-latest">${escapeHtml(memory.userText)}</p></details><label class="memory-edit-review"><input id="memoryEditReviewed" type="checkbox"><span>我已核对最新内容，保存我的修改</span></label></section>` : ''}
    <p id="memoryEditStatus" role="status" class="stop-meta"></p>
    <div class="stop-actions memory-edit-actions"><button class="btn-primary" data-action="save-memory-edit">保存修改</button><button class="btn-soft" data-action="close-sheet">稍后继续</button><button class="btn-ghost" data-action="discard-memory-edit">放弃修改</button></div>`);
  const input = $('editMemoryText');
  const status = $('memoryEditDraftStatus');
  const context = { targetTrip: target || '', memoryId: memory.memoryId, entryVersion: version, latestVersion: memory.entryVersion,
    ownerId: state.principal?.principalId, personal, conflict, input, storage,
    capture: () => ({ text: input.value, entryVersion: version }) };
  input.addEventListener('input', () => {
    const persisted = storage.save(context.capture());
    status.textContent = persisted ? '草稿已暂存，关闭或刷新本标签页后可继续。尚未修改原记录。' : '草稿已暂存，关闭后可继续；刷新可能丢失。';
  });
  return context;
}

export function askDiscardMemoryEdit(context, onDiscard) {
  if (!context || context.ownerId !== state.principal?.principalId) return;
  const captured = context.capture();
  const token = String(++discardSequence);
  pendingDiscard = { context, captured, token, onDiscard };
  openSheet(`${heading('放弃这次修改？')}<p>将清除这条记忆的编辑草稿，已保存的原记录不会改变。</p><div class="stop-actions"><button class="btn-soft" data-action="close-sheet">继续编辑</button><button class="btn-primary" data-action="confirm-discard-memory-edit" data-token="${token}">放弃修改</button></div>`, { nested: true });
}

export function confirmDiscardMemoryEdit(button) {
  const request = pendingDiscard;
  if (!request || request.token !== button?.dataset.token) return;
  pendingDiscard = null;
  if (request.context.ownerId !== state.principal?.principalId || JSON.stringify(request.context.capture()) !== JSON.stringify(request.captured)) {
    toast('账号或草稿已变化，已保留当前内容。', 'error');
    return;
  }
  request.context.storage.clearIf(request.captured);
  request.onDiscard();
}
