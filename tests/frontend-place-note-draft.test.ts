import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const notes = await load('public/lib/place-notes.js');
const ui = await load('public/lib/ui.js');
const { writingDraft } = await load('public/lib/writing-drafts.js');
let sequence = 0;
function harness() {
  const previous = { ...state }, browser = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes: Record<string, any> = { sheetBackdrop: { hidden: true }, toast: {} };
  let html = '';
  nodes.sheet = { querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} };
  Object.defineProperty(nodes.sheet, 'innerHTML', { get: () => html, set(value: string) {
    html = value;
    for (const id of ['placeNoteLoading', 'myPlaceNoteInput', 'placeNoteDraftStatus', 'placeNoteSaveStatus']) delete nodes[id];
    if (value.includes('id="placeNoteLoading"')) nodes.placeNoteLoading = {};
    const match = value.match(/<textarea id="myPlaceNoteInput"[^>]*>([\s\S]*?)<\/textarea>/);
    if (match) {
      let onInput = () => {};
      nodes.myPlaceNoteInput = { value: match[1], disabled: false, addEventListener: (_kind: string, fn: () => void) => { onInput = fn; },
        input(text: string) { this.value = text; onInput(); } };
      nodes.placeNoteDraftStatus = { textContent: '' }; nodes.placeNoteSaveStatus = { textContent: '' };
    }
  } });
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id], querySelectorAll: () => [], contains: () => false } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  state.principal = { principalId: `place-note-test-${++sequence}`, kind: 'account' };
  state.currentView = 'mine'; state.myPlaceNotes = {};
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { note: '原备注' } }))) as typeof fetch;
  return { nodes, storage: () => writingDraft('place-note', 'place'), restore() {
    ui.closeSheet(); clearTimeout((globalThis.window as any).__toastTimer); Object.assign(state, previous); Object.assign(globalThis, browser);
  } };
}

test('Escape and reopening retain exact unsaved place note text for the same account', async () => {
  const h = harness();
  try {
    await notes.editPlaceNote('place'); h.nodes.myPlaceNoteInput.input('散步提醒\n带水，避开路口。');
    ui.handleSheetKeydown({ key: 'Escape', preventDefault() {} });
    await notes.editPlaceNote('place');
    assert.equal(h.nodes.myPlaceNoteInput.value, '散步提醒\n带水，避开路口。');
    assert.match(h.nodes.sheet.innerHTML, /已恢复未保存/);
    state.principal = { principalId: 'another-owner', kind: 'account' };
    await notes.editPlaceNote('place'); assert.equal(h.nodes.myPlaceNoteInput.value, '原备注');
  } finally { h.restore(); }
});

test('a failed save preserves editable text and a retry clears only the saved draft', async () => {
  const h = harness();
  try {
    await notes.editPlaceNote('place'); h.nodes.myPlaceNoteInput.input('未保存的提醒');
    globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
    const button = { dataset: { place: 'place' }, disabled: false };
    await notes.savePlaceNote(button);
    assert.equal(h.nodes.myPlaceNoteInput.value, '未保存的提醒'); assert.equal(h.nodes.myPlaceNoteInput.disabled, false);
    assert.match(h.nodes.placeNoteSaveStatus.textContent, /输入仍保留/);
    assert.equal(h.storage().read().text, '未保存的提醒');
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { note: '未保存的提醒' } }))) as typeof fetch;
    await notes.savePlaceNote(button);
    assert.equal(h.storage().read(), null); assert.equal(state.myPlaceNotes.place, '未保存的提醒');
    assert.equal(h.nodes.sheetBackdrop.hidden, true);
  } finally { h.restore(); }
});

test('closing while a note loads prevents the late response reopening the sheet', async () => {
  const h = harness();
  try {
    let complete: (response: Response) => void = () => {};
    globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
    const pending = notes.editPlaceNote('place'); ui.closeSheet();
    complete(new Response(JSON.stringify({ data: { note: 'late' } }))); await pending;
    assert.equal(h.nodes.sheetBackdrop.hidden, true); assert.equal(h.nodes.myPlaceNoteInput, undefined);
  } finally { h.restore(); }
});

test('a save acknowledgement cannot close a different sheet or update another account', async () => {
  const h = harness();
  try {
    await notes.editPlaceNote('place'); h.nodes.myPlaceNoteInput.input('提交的备注');
    let complete: (response: Response) => void = () => {};
    globalThis.fetch = async () => new Promise<Response>(resolve => { complete = resolve; });
    const pending = notes.savePlaceNote({ dataset: { place: 'place' } });
    ui.openSheet('<h3>另一块面板</h3>'); state.principal = { principalId: 'switched-owner' };
    complete(new Response(JSON.stringify({ data: { note: '提交的备注' } }))); await pending;
    assert.match(h.nodes.sheet.innerHTML, /另一块面板/); assert.equal(state.myPlaceNotes.place, undefined);
  } finally { h.restore(); }
});
