import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const editor = await load('public/lib/memory-editor.js');
const drafts = await load('public/lib/memory-edit-draft.js');
const { writingDraft } = await load('public/lib/writing-drafts.js');
const ui = await load('public/lib/ui.js');

let ownerSequence = 0;
function harness() {
  const previous = { ...state }, browser = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes: Record<string, any> = {
    sheetBackdrop: { hidden: true }, toast: { textContent: '', className: '' },
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' }, sidebarTrip: { innerHTML: '' }, view: { innerHTML: '' },
  };
  let html = '';
  nodes.sheet = { querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, setAttribute() {}, removeAttribute() {}, focus() {}, childNodes: [] };
  Object.defineProperty(nodes.sheet, 'innerHTML', { get: () => html, set(value: string) {
    html = value;
    const match = value.match(/<textarea id="editMemoryText"[^>]*>([\s\S]*?)<\/textarea>/);
    if (match) {
      const listeners: Record<string, any> = {};
      nodes.editMemoryText = { value: match[1], disabled: false, addEventListener: (event: string, callback: any) => { listeners[event] = callback; },
        input(value: string) { this.value = value; listeners.input?.(); } };
      nodes.memoryEditDraftStatus = { textContent: '' }; nodes.memoryEditStatus = { textContent: '' };
      nodes.memoryEditReviewed = value.includes('id="memoryEditReviewed"') ? { checked: false } : null;
    } else { delete nodes.editMemoryText; }
  } });
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null,
    querySelector: () => null, querySelectorAll: () => [], contains: () => false } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  state.principal = { kind: 'guest', principalId: `memory-edit-owner-${++ownerSequence}` };
  state.currentView = 'memories'; state.trip = null; state.memories = []; state.savedPlans = []; state.places = [];
  state.loadStatus = {}; state.proposal = null; state.sessionRecoveryNotice = null;
  const memory = { memoryId: 'note', userText: '已保存标题\n已保存的内容', entryVersion: 1, type: 'note', createdAt: new Date().toISOString() };
  return { nodes, memory, storage: () => writingDraft('memory-edit', 'personal:note'),
    restore() {
      ui.closeSheet();
      if ((globalThis.window as any).__toastTimer) clearTimeout((globalThis.window as any).__toastTimer);
      Object.assign(state, previous); Object.assign(globalThis, browser);
    } };
}

test('closing a memory editor with Escape restores its exact unsaved text and version on reopening', () => {
  const h = harness();
  try {
    drafts.openMemoryEditDraft(h.memory, { personal: true, target: '' });
    h.nodes.editMemoryText.input('新标题\n未保存的补写');
    ui.handleSheetKeydown({ key: 'Escape', preventDefault() {} });
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
    drafts.openMemoryEditDraft(h.memory, { personal: true, target: '' });
    assert.equal(h.nodes.editMemoryText.value, '新标题\n未保存的补写');
    assert.deepEqual(h.storage().read(), { text: '新标题\n未保存的补写', entryVersion: 1 });
    assert.match(h.nodes.sheet.innerHTML, /已恢复未保存的修改/);
    assert.equal(h.memory.userText, '已保存标题\n已保存的内容');
  } finally { h.restore(); }
});

test('explicit discard clears only the bound edit draft and requires a matching confirmation', () => {
  const h = harness();
  try {
    const context = drafts.openMemoryEditDraft(h.memory, { personal: true, target: '' });
    h.nodes.editMemoryText.input('要放弃的修改');
    const other = writingDraft('memory-edit', 'personal:other'); other.save({ text: '另一条笔记' });
    let discarded = 0;
    drafts.askDiscardMemoryEdit(context, () => { discarded++; });
    const token = h.nodes.sheet.innerHTML.match(/data-token="(\d+)"/)?.[1];
    drafts.confirmDiscardMemoryEdit({ dataset: { token: 'wrong' } });
    assert.ok(h.storage().read());
    drafts.confirmDiscardMemoryEdit({ dataset: { token } });
    drafts.confirmDiscardMemoryEdit({ dataset: { token } });
    assert.equal(discarded, 1); assert.equal(h.storage().read(), null);
    assert.equal(other.read().text, '另一条笔记');
    assert.equal(h.memory.userText, '已保存标题\n已保存的内容');
  } finally { h.restore(); }
});

test('a stale draft shows the latest saved text and blocks saving until the user reviews it', async () => {
  const h = harness();
  try {
    h.storage().save({ text: '原页面补写', entryVersion: 1 });
    const latest = { ...h.memory, userText: '另一个页面已保存', entryVersion: 2 };
    const bodies: any[] = [];
    globalThis.fetch = (async (path: string, init: any = {}) => {
      if (init.method === 'PATCH') { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { ...latest, userText: bodies.at(-1).userText, entryVersion: 3 } })); }
      return new Response(JSON.stringify({ data: path.includes('?') ? [latest] : latest }));
    }) as typeof fetch;
    await editor.editMemory('note');
    assert.equal(h.nodes.editMemoryText.value, '原页面补写');
    assert.match(h.nodes.sheet.innerHTML, /另一个页面已保存/);
    await editor.saveMemoryEdit({ disabled: false });
    assert.equal(bodies.length, 0);
    assert.match(h.nodes.memoryEditStatus.textContent, /勾选确认/);
    h.nodes.memoryEditReviewed.checked = true;
    await editor.saveMemoryEdit({ disabled: false });
    assert.equal(bodies[0].expectedEntryVersion, 2);
    assert.equal(bodies[0].userText, '原页面补写');
    assert.equal(h.storage().read(), null);
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
  } finally { h.restore(); }
});

test('failed memory saves keep text and the original version for conflict review', async () => {
  const h = harness();
  try {
    globalThis.fetch = (async (_path: string, init: any = {}) => new Response(JSON.stringify(init.method === 'PATCH'
      ? { error: { code: 'ENTRY_VERSION_CONFLICT', message: '原记录已更新' } } : { data: h.memory }), { status: init.method === 'PATCH' ? 409 : 200 })) as typeof fetch;
    await editor.editMemory('note'); h.nodes.editMemoryText.input('失败仍保留');
    await editor.saveMemoryEdit({ disabled: false });
    assert.deepEqual(h.storage().read(), { text: '失败仍保留', entryVersion: 1 });
    assert.equal(h.nodes.editMemoryText.value, '失败仍保留'); assert.equal(h.nodes.editMemoryText.disabled, false);
    assert.match(h.nodes.memoryEditStatus.textContent, /仍保留/);
    assert.equal(h.nodes.sheetBackdrop.hidden, false);
  } finally { h.restore(); }
});

test('a late save does not close a new panel or apply another account response', async () => {
  for (const switchedAccount of [false, true]) {
    const h = harness();
    try {
      let complete: (value: Response) => void = () => {};
      globalThis.fetch = (async (path: string, init: any = {}) => init.method === 'PATCH' ? await new Promise<Response>(resolve => { complete = resolve; })
        : new Response(JSON.stringify({ data: path.includes('?') ? [h.memory] : h.memory }))) as typeof fetch;
      await editor.editMemory('note'); h.nodes.editMemoryText.input('已提交的补写');
      const pending = editor.saveMemoryEdit({ disabled: false });
      ui.openSheet('<h3>另一块正在填写的面板</h3>');
      if (switchedAccount) { state.principal = { principalId: 'new-owner', kind: 'guest' }; state.memories = []; }
      complete(new Response(JSON.stringify({ data: { ...h.memory, userText: '已提交的补写', entryVersion: 2 } })));
      await pending;
      assert.equal(h.nodes.sheetBackdrop.hidden, false);
      assert.match(h.nodes.sheet.innerHTML, /另一块正在填写的面板/);
      if (switchedAccount) assert.deepEqual(state.memories, []);
    } finally { h.restore(); }
  }
});
