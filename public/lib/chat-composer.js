import { state } from './store.js';
import { writingDraft } from './writing-drafts.js';

const unavailableStorage = new Set();
const composerOwner = () => state.principal?.principalId || '';
const composerStore = () => writingDraft('chat-composer', state.agentConversationId ? `personal:${state.agentConversationId}` : 'personal');
const composerInput = root => root?.querySelector?.('#chatText') || root?.getElementById?.('chatText') || null;
const ownedInput = input => input && (input.dataset?.chatOwner === undefined || input.dataset.chatOwner === composerOwner()) && (input.dataset?.chatConversation === undefined || input.dataset.chatConversation === (state.agentConversationId || ''));

export function chatComposerDraft() {
  const value = composerStore().read();
  return { text: typeof value?.text === 'string' ? value.text : '', prompt: typeof value?.prompt === 'string' ? value.prompt : '' };
}

function writeComposerDraft(value, store = composerStore(), owner = composerOwner()) {
  if (!value.text && !value.prompt) { store.clearIf(store.read()); unavailableStorage.delete(owner); return; }
  if (store.save(value)) unavailableStorage.delete(owner);
  else unavailableStorage.add(owner);
}

export function resizeChatComposer(input) {
  if (!input?.style || input.tagName !== 'TEXTAREA' || typeof getComputedStyle !== 'function') return;
  const scroll = input.scrollTop;
  input.style.height = 'auto';
  const style = getComputedStyle(input);
  const minimum = parseFloat(style.minHeight) || 48, maximum = parseFloat(style.maxHeight) || 120;
  input.style.height = `${Math.min(maximum, Math.max(minimum, input.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)))}px`;
  input.scrollTop = scroll;
}

export function chatComposerNotice() {
  return unavailableStorage.has(composerOwner()) ? '文字留在当前页，刷新可能丢失' : '未发送文字已暂存';
}

export function captureChatComposer(root = globalThis.document) {
  const input = composerInput(root);
  if (!ownedInput(input)) return;
  const previous = chatComposerDraft();
  writeComposerDraft({ ...previous, text: input.value });
  resizeChatComposer(input);
  const status = input.closest?.('[data-chat-form]')?.querySelector?.('[data-chat-draft-status]');
  if (status) {
    status.hidden = !input.value;
    const notice = chatComposerNotice();
    if (status.textContent !== notice) status.textContent = notice;
  }
}

export function mountChatComposer(root = globalThis.document) {
  const input = composerInput(root);
  if (!ownedInput(input)) return;
  resizeChatComposer(input);
}

/** A scene question is offered alongside the draft, never silently replaces it. */
export function offerChatPrompt(text) {
  if (!text?.trim()) return;
  captureChatComposer();
  const previous = chatComposerDraft();
  if (!previous.text.trim()) {
    writeComposerDraft({ text, prompt: '' });
    const input = composerInput(globalThis.document);
    if (ownedInput(input)) { input.value = text; resizeChatComposer(input); }
  }
  else if (previous.text.trim() !== text.trim()) writeComposerDraft({ ...previous, prompt: text });
}

export function appendChatPrompt() {
  captureChatComposer();
  const current = chatComposerDraft();
  if (!current.prompt) return;
  const text = current.text ? `${current.text}\n\n${current.prompt}` : current.prompt;
  writeComposerDraft({ text, prompt: '' });
  const input = composerInput(globalThis.document);
  if (ownedInput(input)) input.value = text;
}

export function dismissChatPrompt() {
  captureChatComposer();
  const current = chatComposerDraft();
  writeComposerDraft({ ...current, prompt: '' });
}

/** Capture the exact submitted text and its original owner before an async call. */
export function beginChatComposerSubmission(text) {
  captureChatComposer();
  const owner = composerOwner(), store = composerStore(), previous = chatComposerDraft();
  const input = composerInput(globalThis.document);
  const fromInput = ownedInput(input) && input.value.trim() === text.trim();
  const originalText = fromInput ? input.value : text;
  if (fromInput) {
    input.value = '';
    writeComposerDraft({ ...previous, text: '' }, store, owner);
    resizeChatComposer(input);
  }
  return { owner, store, text: originalText };
}

export function restoreChatComposerSubmission(submission) {
  if (submission.owner === composerOwner()) captureChatComposer();
  const current = submission.store.read();
  if (current?.text) return;
  writeComposerDraft({ text: submission.text, prompt: current?.prompt || '' }, submission.store, submission.owner);
  if (submission.owner !== composerOwner()) return;
  const input = composerInput(globalThis.document);
  if (ownedInput(input) && !input.value) { input.value = submission.text; resizeChatComposer(input); }
}
