import { state } from './store.js';
import { api } from './api.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { loadGeneralMessages } from './loaders.js';
import { captureChatComposer } from './chat-composer.js';
import { render } from './render.js';
import { renderConversationRows } from './agent-conversation-view.js';
import { writingDraft } from './writing-drafts.js';
import { agentConversationSelectionEpoch, invalidateAgentConversationSelection } from './agent-conversation-selection.js';
export { agentConversationSelectionEpoch, invalidateAgentConversationSelection };
const drafts = new Map();
let sequence = 0;
let renaming = false;
const key = () => `${state.principal?.principalId || ''}:${state.agentConversationId || ''}`;
const locked = () => state.accountContextChanged || state.chatPending || state.chatImagesBusy || state.agentConversationLoading || renaming;

export async function openAgentConversations() {
  if (locked()) { toast('请等当前操作完成后再切换对话'); return; }
  const owner = state.principal?.principalId, token = ++sequence, navigation = state.navigationRevision;
  const sheet = document.getElementById('sheet'), contents = sheet?.firstElementChild;
  const sheetHidden = document.getElementById('sheetBackdrop')?.hidden;
  const conversations = await api('/api/v1/agent/conversations');
  if (token !== sequence || owner !== state.principal?.principalId || navigation !== state.navigationRevision || locked() || sheet?.firstElementChild !== contents || document.getElementById('sheetBackdrop')?.hidden !== sheetHidden) return;
  state.agentConversations = conversations;
  openSheet(`<section class="agent-conversation-panel"><div class="sheet-head"><h3>我的对话</h3><button type="button" class="action-icon" data-action="close-sheet" aria-label="关闭对话列表">${uiIcon('close',{size:20})}</button></div><div class="agent-conversation-list-toolbar"><p>${conversations.length} 段对话 · 聊天记录分别保留</p><button type="button" class="btn-soft" data-action="new-agent-conversation">${uiIcon('chat-add',{size:18})}<span>新对话</span></button></div><div class="agent-conversation-list">${renderConversationRows(conversations, state.agentConversationId || '')}</div></section>`);
}

export function renameAgentConversation(conversationId) {
  if (locked()) return;
  const conversation = state.agentConversations.find(item => item.conversationId === conversationId);
  if (!conversation) throw new Error('请重新打开对话列表。');
  openSheet(`<section class="agent-conversation-editor"><div class="sheet-head"><h3>给对话命名</h3><button type="button" class="action-icon" data-action="open-agent-conversations" aria-label="返回对话列表">${uiIcon('close',{size:20})}</button></div><label class="field">对话名称<input id="agentConversationTitle" value="${escapeHtml(conversation.title)}" maxlength="80" autocomplete="off" placeholder="例如：上海半日散步" /></label><p class="stop-meta">修改名称会保留所有聊天记录。</p><p class="agent-conversation-edit-error" role="alert" hidden></p><div class="agent-conversation-editor-actions"><button type="button" class="btn-ghost" data-action="open-agent-conversations">取消</button><button type="button" class="btn-primary" data-action="save-agent-conversation-title" data-conversation="${escapeHtml(conversationId)}">保存名称</button></div></section>`);
  document.getElementById('agentConversationTitle')?.select();
}

export async function saveAgentConversationTitle(conversationId) {
  if (locked()) return;
  const field = document.getElementById('agentConversationTitle');
  if (!field) return;
  const title = field.value.replace(/\s+/g,' ').trim();
  const error = document.querySelector('.agent-conversation-edit-error');
  if (!title || [...title].length > 40) { error.textContent = '请输入1–40个字的名称'; error.hidden = false; field.focus(); return; }
  const owner = state.principal?.principalId;
  const editor = document.querySelector('.agent-conversation-editor'), navigation = state.navigationRevision;
  const controls = [...document.querySelectorAll('.agent-conversation-editor button,.agent-conversation-editor input')];
  renaming = true; controls.forEach(el => { el.disabled = true; });
  try {
    const result = await api(`/api/v1/agent/conversations/${encodeURIComponent(conversationId || 'default')}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    if (owner !== state.principal?.principalId) return;
    state.agentConversations = state.agentConversations.map(item => item.conversationId === conversationId ? result : item);
    renaming = false;
    // Saving remains valid after dismissal; the receipt must not take focus back
    // from the page or dialog the traveller has chosen in the meantime.
    if (editor?.isConnected && navigation === state.navigationRevision && !state.accountContextChanged) {
      render();
      await openAgentConversations();
    }
    toast('对话名称已保存');
  } catch (failure) { if (owner === state.principal?.principalId && error?.isConnected) { error.textContent = failure.message; error.hidden = false; } }
  finally { renaming = false; controls.forEach(el => { if (el.isConnected) el.disabled = false; }); }
}

export function deleteAgentConversation(conversationId) {
  if (locked()) return;
  const conversation = state.agentConversations.find(item => item.conversationId === conversationId);
  if (!conversation) throw new Error('请重新打开对话列表。');
  openSheet(`<section class="agent-conversation-editor"><div class="sheet-head"><h3>删除这段对话？</h3><button type="button" class="action-icon" data-action="open-agent-conversations" aria-label="返回对话列表">${uiIcon('close',{size:20})}</button></div><p><strong>${escapeHtml(conversation.title)}</strong></p><p class="stop-meta">将删除这段对话的聊天记录和未完成任务，无法恢复。已经保存的计划、帖子、笔记和收藏会保留。</p><p class="agent-conversation-edit-error" role="alert" hidden></p><div class="agent-conversation-editor-actions"><button type="button" class="btn-ghost" data-action="open-agent-conversations">取消</button><button type="button" class="btn-danger" data-action="confirm-delete-agent-conversation" data-conversation="${escapeHtml(conversationId)}">删除对话</button></div></section>`);
}

export async function confirmDeleteAgentConversation(conversationId) {
  if (locked()) return;
  const owner = state.principal?.principalId;
  const editor = document.querySelector('.agent-conversation-editor'), navigation = state.navigationRevision;
  const deletingCurrent = conversationId === (state.agentConversationId || '');
  const controls = [...document.querySelectorAll('.agent-conversation-editor button')];
  const error = document.querySelector('.agent-conversation-edit-error');
  renaming = true; controls.forEach(el => { el.disabled = true; });
  if (deletingCurrent) { state.agentConversationLoading = true; render(); }
  try {
    const result = await api(`/api/v1/agent/conversations/${encodeURIComponent(conversationId || 'default')}`, { method:'DELETE' });
    if (owner !== state.principal?.principalId) return;
    invalidateAgentConversationSelection();
    drafts.delete(`${owner || ''}:${conversationId}`);
    const draft = writingDraft('chat-composer', conversationId ? `personal:${conversationId}` : 'personal');
    draft.clearIf(draft.read());
    state.agentConversations = result.conversations;
    renaming = false;
    const dismissEditor = Boolean(editor?.isConnected && navigation === state.navigationRevision);
    if (conversationId === (state.agentConversationId || '')) {
      // Do not capture the just-deleted composer again when selecting the fallback.
      const input = document.getElementById('chatText'); if (input) input.value = '';
      state.chatImages = []; state.chatRetry = null;
      await selectConversation(result.conversations[0].conversationId, owner, { rollback:false, dismissSheet:dismissEditor });
    } else { if (dismissEditor) closeSheet(); render(); }
    toast('对话已删除');
  } catch (failure) { if (owner === state.principal?.principalId && error?.isConnected) { error.textContent = failure.message; error.hidden = false; } }
  finally {
    renaming = false; controls.forEach(el => { if (el.isConnected) el.disabled = false; });
    if (deletingCurrent && owner === state.principal?.principalId) { state.agentConversationLoading = false; render(); }
  }
}

async function selectConversation(conversationId, owner, options = {}) {
  const rollback = options.rollback === undefined ? true : options.rollback;
  const dismissSheet = options.dismissSheet === undefined ? true : options.dismissSheet;
  if (owner !== state.principal?.principalId) return;
  invalidateAgentConversationSelection();
  captureChatComposer();
  drafts.set(key(), { images: structuredClone(state.chatImages || []), retry: state.chatRetry });
  const previous = {
    id:state.agentConversationId || '', messages:state.messages, cursor:state.messagesCursor,
    scroll:state.chatScrollRestore, interrupted:state.agentInterruptedTask, remote:state.agentRemoteTask,
    progress:state.agentTaskProgress, error:state.agentConversationError || '',
  };
  const token = ++sequence;
  state.agentConversationOwner = owner;
  state.agentConversationId = conversationId;
  try { sessionStorage.setItem(`bantu:agent-conversation:${owner}`, conversationId); } catch { /* Current tab still retains its selection. */ }
  const draft = drafts.get(key());
  state.chatImages = draft?.images || []; state.chatRetry = draft?.retry || null;
  state.agentInterruptedTask = null; state.agentRemoteTask = null;
  state.agentTaskProgress = null; state.agentConversationError = '';
  state.messages = []; state.messagesCursor = null; state.chatScrollRestore = null;
  state.agentConversationLoading = true;
  if (dismissSheet) closeSheet(); render();
  try { await loadGeneralMessages(); }
  catch (failure) {
    if (token === sequence && owner === state.principal?.principalId && !state.accountContextChanged) {
      if (rollback) {
        invalidateAgentConversationSelection();
        state.agentConversationId = previous.id;
        try { sessionStorage.setItem(`bantu:agent-conversation:${owner}`, previous.id); } catch {}
        const restored = drafts.get(key());
        state.chatImages = restored?.images || []; state.chatRetry = restored?.retry || null;
        state.messages = previous.messages; state.messagesCursor = previous.cursor; state.chatScrollRestore = previous.scroll;
        state.agentInterruptedTask = previous.interrupted; state.agentRemoteTask = previous.remote;
        state.agentTaskProgress = previous.progress; state.agentConversationError = previous.error;
      } else state.agentConversationError = failure.message || '聊天记录暂时无法读取，请重试。';
    }
    throw failure;
  }
  finally { if (token === sequence && owner === state.principal?.principalId) { state.agentConversationLoading = false; render(); } }
}

export async function switchAgentConversation(conversationId) {
  if (locked()) return;
  if (!state.agentConversations.some(c => c.conversationId === conversationId)) throw new Error('请重新打开对话列表。');
  if (conversationId === (state.agentConversationId || '') && !state.agentConversationError) { closeSheet(); return; }
  await selectConversation(conversationId, state.principal?.principalId);
}

export async function newAgentConversation() {
  if (locked()) return;
  const owner = state.principal?.principalId, navigation = state.navigationRevision;
  state.agentConversationLoading = true; render();
  try {
    const conversation = await api('/api/v1/agent/conversations', { method: 'POST', body: '{}' });
    if (owner !== state.principal?.principalId) return;
    invalidateAgentConversationSelection();
    state.agentConversations = [conversation, ...(state.agentConversations || [])];
    if (navigation !== state.navigationRevision || state.accountContextChanged) return;
    await selectConversation(conversation.conversationId, owner);
  } finally { if (owner === state.principal?.principalId) { state.agentConversationLoading = false; render(); } }
}
