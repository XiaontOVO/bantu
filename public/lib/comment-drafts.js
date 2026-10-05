import { state } from './store.js';
import { writingDraft } from './writing-drafts.js';

const commentDraftOwner = () => state.principal?.principalId || 'guest';
const keyFor = input => input?.dataset?.commentKey || input?.dataset?.post;
const boundOwners = new WeakMap();
const inputs = () => [...(document.querySelectorAll?.('[data-comment-draft]') || [])];
const statusFor = input => input.closest?.('[data-comment-form]')?.querySelector?.('[data-comment-status]');
function showStatus(input, message) {
  const status = statusFor(input);
  if (status) { status.textContent = message; status.hidden = !message; }
}

/** Persist on typing rather than waiting for the next render or navigation. */
export function syncCommentDraft(input, { feedback = true } = {}) {
  const key = keyFor(input);
  if (!key || (boundOwners.has(input) && boundOwners.get(input) !== commentDraftOwner())) return;
  const storage = writingDraft('comment', key);
  const value = { text: input.value, open: Boolean(input.closest?.('.post-comment-reply')?.open) };
  if (!value.text && !value.open) {
    const previous = storage.read();
    if (previous) storage.clearIf(previous);
    if (feedback) showStatus(input, '');
    return;
  }
  const saved = storage.save(value);
  if (feedback) showStatus(input, saved ? '草稿已暂存，刷新本标签页后可继续。尚未发表。' : '草稿暂存于当前页面；刷新可能丢失。');
}

export function captureCommentEditors() {
  let focus;
  for (const input of inputs()) {
    if (document.activeElement === input) focus = { key: keyFor(input), start: input.selectionStart, end: input.selectionEnd };
    syncCommentDraft(input, { feedback: false });
  }
  return { owner: commentDraftOwner(), focus };
}

export function restoreCommentEditors(captured) {
  for (const input of inputs()) {
    boundOwners.set(input, commentDraftOwner());
    const draft = writingDraft('comment', keyFor(input)).read();
    if (draft) {
      input.value = draft.text || '';
      const reply = input.closest?.('.post-comment-reply');
      if (reply) reply.open = Boolean(draft.open);
      if (draft.text) showStatus(input, '已恢复未发表的草稿。');
    }
    if (captured?.owner === commentDraftOwner() && captured.focus?.key === keyFor(input)) {
      input.focus?.({ preventScroll: true });
      input.setSelectionRange?.(captured.focus.start, captured.focus.end);
    }
  }
}

export function captureCommentSubmission(input) {
  if (input && boundOwners.has(input) && boundOwners.get(input) !== commentDraftOwner()) throw new Error('账号已切换，请重新打开帖子再评论。');
  syncCommentDraft(input, { feedback: false });
  return { key: keyFor(input), text: input?.value || '', owner: commentDraftOwner(), storage: writingDraft('comment', keyFor(input)) };
}

/** A late receipt must not erase a newer draft or another account's input. */
export function clearSubmittedComment(submission) {
  const latest = submission.storage.read();
  if (latest?.text === submission.text) submission.storage.clearIf(latest);
  if (submission.owner !== commentDraftOwner()) return;
  for (const input of inputs()) {
    if (keyFor(input) === submission.key && input.value === submission.text) {
      input.value = ''; showStatus(input, '');
    }
  }
}

export function reportCommentFailure(submission, error) {
  if (submission.owner !== commentDraftOwner()) return;
  const detail = /Failed to fetch|NetworkError|Load failed/i.test(error?.message || '')
    ? '请检查连接后重试。' : error?.message || '请稍后重试。';
  for (const input of inputs()) {
    if (keyFor(input) === submission.key) showStatus(input, `发送失败，草稿仍保留。${detail}`);
  }
}
