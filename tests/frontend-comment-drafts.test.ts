import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const drafts = await load('public/lib/comment-drafts.js');
const { writingDraft } = await load('public/lib/writing-drafts.js');
let sequence = 0;
function harness() {
  const previous = { document: globalThis.document, principal: state.principal, sessionStorage: globalThis.sessionStorage };
  state.principal = { principalId: `comment-owner-${++sequence}`, kind: 'account' };
  const values = new Map<string, string>();
  globalThis.sessionStorage = { get length() { return values.size; }, clear: () => { values.clear(); }, key: (index: number) => [...values.keys()][index] || null,
    getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  let nodes: any[] = [];
  const doc: any = { querySelectorAll: () => nodes, activeElement: null };
  globalThis.document = doc;
  function input(key = 'post:reply', text = '', open = true) {
    const reply = key.includes(':') ? { open } : null, status = { textContent: '', hidden: true };
    const node: any = { dataset: { commentKey: key, post: 'post' }, value: text, selectionStart: 2, selectionEnd: 4,
      closest: (selector: string) => selector === '.post-comment-reply' ? reply : { querySelector: () => status },
      focus: () => { doc.activeElement = node; }, setSelectionRange: (start: number, end: number) => { node.selectionStart = start; node.selectionEnd = end; } };
    return { node, reply, status };
  }
  return { input, doc, use: (...entries: ReturnType<typeof input>[]) => { nodes = entries.map(entry => entry.node); },
    restore() { globalThis.document = previous.document; globalThis.sessionStorage = previous.sessionStorage; state.principal = previous.principal; } };
}

test('rerenders preserve reply text, expansion and the active caret', () => {
  const h = harness();
  try {
    const old = h.input('post:reply', '想回复的文字'); h.use(old); h.doc.activeElement = old.node;
    const captured = drafts.captureCommentEditors();
    const next = h.input('post:reply', '', false); h.use(next); drafts.restoreCommentEditors(captured);
    assert.equal(next.node.value, '想回复的文字'); assert.equal(next.reply!.open, true);
    assert.equal(h.doc.activeElement, next.node); assert.equal(next.node.selectionStart, 2); assert.equal(next.node.selectionEnd, 4);
  } finally { h.restore(); }
});

test('typing persists separate main comments and replies before navigation or refresh', () => {
  const h = harness();
  try {
    const main = h.input('post', '主评论'), reply = h.input('post:reply', '回复草稿'); h.use(main, reply);
    drafts.syncCommentDraft(main.node); drafts.syncCommentDraft(reply.node);
    assert.match(reply.status.textContent, /尚未发表/);
    const nextMain = h.input('post'), nextReply = h.input('post:reply', '', false); h.use(nextMain, nextReply);
    drafts.restoreCommentEditors();
    assert.equal(nextMain.node.value, '主评论'); assert.equal(nextReply.node.value, '回复草稿'); assert.equal(nextReply.reply!.open, true);
    assert.match(nextMain.status.textContent, /已恢复/);
    assert.equal([...h.doc.querySelectorAll()].length, 2);
  } finally { h.restore(); }
});

test('switching account cannot capture previous DOM text into the new owner draft', () => {
  const h = harness();
  try {
    const first = h.input('post:reply', '账号甲的草稿'); h.use(first); drafts.syncCommentDraft(first.node); drafts.restoreCommentEditors();
    state.principal = { principalId: 'different-comment-owner' };
    drafts.captureCommentEditors();
    const second = h.input('post:reply', '', false); h.use(second); drafts.restoreCommentEditors();
    assert.equal(second.node.value, ''); assert.equal(writingDraft('comment', 'post:reply').read(), null);
  } finally { h.restore(); }
});

test('a successful receipt removes only the submitted text and preserves a newer draft', () => {
  const h = harness();
  try {
    const reply = h.input('post:reply', '先发出的文字'); h.use(reply);
    const submission = drafts.captureCommentSubmission(reply.node);
    reply.node.value = '等待时继续写的新内容'; drafts.syncCommentDraft(reply.node);
    drafts.clearSubmittedComment(submission);
    assert.equal(reply.node.value, '等待时继续写的新内容'); assert.equal(writingDraft('comment', 'post:reply').read().text, reply.node.value);
    const nextSubmission = drafts.captureCommentSubmission(reply.node);
    drafts.clearSubmittedComment(nextSubmission);
    assert.equal(reply.node.value, ''); assert.equal(writingDraft('comment', 'post:reply').read(), null);
  } finally { h.restore(); }
});

test('clearing a submitted reply never clears another reply or account', () => {
  const h = harness();
  try {
    const first = h.input('post:reply', '提交的回复'), other = h.input('post:other', '另一条回复'); h.use(first, other);
    drafts.syncCommentDraft(other.node); const submission = drafts.captureCommentSubmission(first.node);
    state.principal = { principalId: 'next-owner' };
    const current = h.input('post:reply', '新账号正在写'); h.use(current); drafts.syncCommentDraft(current.node);
    drafts.clearSubmittedComment(submission);
    assert.equal(current.node.value, '新账号正在写'); assert.equal(writingDraft('comment', 'post:reply').read().text, '新账号正在写');
    assert.equal(other.node.value, '另一条回复');
  } finally { h.restore(); }
});

test('unavailable browser storage keeps drafts in memory and explains the refresh limit', () => {
  const h = harness();
  try {
    globalThis.sessionStorage.setItem = () => { throw new Error('Storage unavailable'); };
    const reply = h.input('post:reply', '临时回复'); h.use(reply); drafts.syncCommentDraft(reply.node);
    assert.match(reply.status.textContent, /刷新可能丢失/);
    const next = h.input('post:reply', '', false); h.use(next); drafts.restoreCommentEditors();
    assert.equal(next.node.value, '临时回复');
  } finally { h.restore(); }
});

test('failed comment submissions retain input and display a Chinese retry message in the same form', async () => {
  const h = harness(), previousFetch = globalThis.fetch;
  try {
    const { submitComment } = await load('public/lib/community.js');
    const reply = h.input('post:reply', '失败也要保留的回复'); h.use(reply);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const button = { dataset: { post: 'post', parentComment: 'reply' }, disabled: false,
      closest: () => ({ querySelector: () => reply.node }) };
    await submitComment(button);
    assert.equal(reply.node.value, '失败也要保留的回复'); assert.equal(button.disabled, false);
    assert.equal(writingDraft('comment', 'post:reply').read().text, reply.node.value);
    assert.match(reply.status.textContent, /发送失败，草稿仍保留/); assert.match(reply.status.textContent, /检查连接后重试/);
    assert.doesNotMatch(reply.status.textContent, /Failed to fetch/);
  } finally { globalThis.fetch = previousFetch; h.restore(); }
});
