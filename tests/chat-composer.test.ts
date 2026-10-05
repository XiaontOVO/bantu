import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const loadComposerModule = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await loadComposerModule('public/lib/store.js');
const composer = await loadComposerModule('public/lib/chat-composer.js');
let sequence = 0;

function withComposerFixture(run: (input: any, values: Map<string, string>, owner: string) => void) {
  const previous = { principal: state.principal, document: globalThis.document, storage: globalThis.sessionStorage };
  const owner = `composer-unit-${++sequence}`;
  const input = { value: '', dataset: { chatOwner: owner } };
  const values = new Map<string, string>();
  state.principal = { principalId: owner };
  globalThis.document = { getElementById: (id: string) => id === 'chatText' ? input : null } as unknown as Document;
  globalThis.sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as unknown as Storage;
  try { run(input, values, owner); }
  finally { state.principal = previous.principal; globalThis.document = previous.document; globalThis.sessionStorage = previous.storage; }
}

test('offered scene question preserves the active command until explicitly appended', () => {
  withComposerFixture(input => {
    input.value = '我的原指令\n保留已有计划';
    composer.captureChatComposer();
    composer.offerChatPrompt('介绍一下红砖');
    composer.captureChatComposer(); // A subsequent render captures the live field again.
    assert.deepEqual(composer.chatComposerDraft(), { text: input.value, prompt: '介绍一下红砖' });
    composer.appendChatPrompt();
    assert.equal(input.value, '我的原指令\n保留已有计划\n\n介绍一下红砖');
    assert.equal(composer.chatComposerDraft().prompt, '');
    composer.offerChatPrompt('另一个问题');
    composer.dismissChatPrompt();
    assert.equal(composer.chatComposerDraft().text, input.value);
    assert.equal(composer.chatComposerDraft().prompt, '');
  });
});

test('an empty live composer accepts a question and survives the next capture', () => {
  withComposerFixture(input => {
    composer.offerChatPrompt('请解释眼前建筑');
    composer.captureChatComposer();
    assert.equal(input.value, '请解释眼前建筑');
    assert.equal(composer.chatComposerDraft().text, input.value);
    composer.offerChatPrompt('请解释眼前建筑');
    assert.equal(composer.chatComposerDraft().prompt, '');
  });
});

test('submission consumes only its exact current draft, retaining queued questions and newer text', () => {
  withComposerFixture((input, values) => {
    input.value = '  安排明天\n保留预约  ';
    composer.captureChatComposer();
    composer.offerChatPrompt('建筑介绍');
    const sent = composer.beginChatComposerSubmission('安排明天\n保留预约');
    assert.equal(input.value, '');
    assert.equal(composer.chatComposerDraft().prompt, '建筑介绍');
    input.value = '下一条还没发送';
    composer.restoreChatComposerSubmission(sent);
    assert.equal(input.value, '下一条还没发送');
    assert.equal(composer.chatComposerDraft().text, input.value);
    assert.equal(values.size, 1);
  });
});

test('failed send restores exact whitespace and multiline text when the composer is empty', () => {
  withComposerFixture(input => {
    input.value = '  第一行\n第二行  ';
    const sent = composer.beginChatComposerSubmission(input.value.trim());
    composer.restoreChatComposerSubmission(sent);
    assert.equal(input.value, '  第一行\n第二行  ');
    assert.equal(composer.chatComposerDraft().text, input.value);
  });
});

test('principal switch cannot capture the previous DOM or restore its message into another account', () => {
  withComposerFixture((input, values, owner) => {
    input.value = '原账号私人消息';
    const sent = composer.beginChatComposerSubmission(input.value);
    input.value = '旧页面未提交';
    state.principal = { principalId: owner + '-other' };
    composer.captureChatComposer();
    assert.equal(composer.chatComposerDraft().text, '');
    input.dataset.chatOwner = state.principal.principalId;
    input.value = '另一个账号的输入';
    composer.captureChatComposer();
    composer.restoreChatComposerSubmission(sent);
    assert.equal(input.value, '另一个账号的输入');
    assert.equal(composer.chatComposerDraft().text, input.value);
    assert.equal(values.size, 2);
    state.principal = { principalId: owner };
    assert.equal(composer.chatComposerDraft().text, '原账号私人消息');
  });
});

test('storage failure keeps the current-page draft and exposes the limited recovery scope', () => {
  withComposerFixture(input => {
    globalThis.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); } } as unknown as Storage;
    input.value = '断网时继续编辑';
    composer.captureChatComposer();
    assert.equal(composer.chatComposerDraft().text, input.value);
    assert.match(composer.chatComposerNotice(), /刷新可能丢失/);
    const sent = composer.beginChatComposerSubmission(input.value);
    assert.equal(composer.chatComposerDraft().text, '');
    composer.restoreChatComposerSubmission(sent);
    assert.equal(input.value, '断网时继续编辑');
  });
});
