import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const editorPromise = import(pathToFileURL(join(process.cwd(), 'public/lib/memory-editor.js')).href) as Promise<Record<string, any>>;
const storePromise = import(pathToFileURL(join(process.cwd(), 'public/lib/store.js')).href) as Promise<Record<string, any>>;

test('committed memory edits and deletes survive a failed archive refresh', async () => {
  const [editor, storeModule] = await Promise.all([editorPromise, storePromise]);
  const state = storeModule.state;
  const previous = { memories: state.memories, loadStatus: state.loadStatus };
  const original = {
    tripId: 'trip-1', memoryId: 'note-1', type: 'note', userText: 'Before',
    createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z',
  };
  try {
    state.memories = [original];
    state.loadStatus = {};
    const edited = { ...original, userText: 'After', updatedAt: '2026-09-20T10:00:00.000Z' };
    const editRefreshed = await editor.applyMemoryResultAndRefresh(edited, {
      refresh: async () => { throw new Error('network unavailable'); },
    });
    assert.equal(editRefreshed, false);
    assert.equal(state.memories[0].userText, 'After');
    assert.equal(state.loadStatus.memories.status, 'error');
    assert.match(state.loadStatus.memories.message, /network unavailable/);

    const deleted = { ...edited, deletedAt: '2026-09-20T11:00:00.000Z' };
    const deleteRefreshed = await editor.applyMemoryResultAndRefresh(deleted, {
      deleted: true,
      refresh: async () => { throw new Error('still offline'); },
    });
    assert.equal(deleteRefreshed, false);
    assert.equal(state.memories.length, 0);
    assert.equal(state.loadStatus.memories.status, 'error');
  } finally {
    Object.assign(state, previous);
  }
});
