import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryNote,
  deleteMemory,
  deleteSourceMessage,
  generateRecapDraft,
  patchMemory,
  type MemoryState,
} from '../src/domain/memory.js';

function emptyMemory(): MemoryState {
  return { tripId: 'trip_1', contentRevision: 0, entries: [] };
}

test('SC39 generating a recap draft does not increment contentRevision and is idempotent per operation', () => {
  const noteResult = createMemoryNote(emptyMemory(), {
    memoryId: 'note_1',
    userText: '今天和妈妈逛得很开心',
    now: '2026-09-20T18:00:00+08:00',
  });
  assert.equal(noteResult.ok, true);
  const state = noteResult.state!;
  assert.equal(state.contentRevision, 1);

  const draft = generateRecapDraft(state, {
    userText: '今天走了很多路，但很开心。',
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_1',
    sourceMemoryIds: ['note_1'],
    now: '2026-09-20T18:01:00+08:00',
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.state?.contentRevision, 1);

  const duplicate = generateRecapDraft(draft.state!, {
    userText: '另一份不应保存的草稿',
    baseContentRevision: draft.state!.contentRevision,
    originOperationId: 'op_recap_1',
    now: '2026-09-20T18:02:00+08:00',
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.entry?.memoryId, draft.entry?.memoryId);
  assert.equal(duplicate.state?.entries.length, state.entries.length + 1);
});

test('a day journal keeps its selected date on the saved memory', () => {
  const saved = createMemoryNote(emptyMemory(), {
    userText: '第二天旅行感想\n去了新的地方。',
    localDate: '2026-09-21',
    now: '2026-09-21T18:00:00+08:00',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.entry?.localDate, '2026-09-21');
  const invalid = createMemoryNote(emptyMemory(), {
    userText: '日期错误',
    localDate: '2026-02-30',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_INPUT');
});

test('SC39 saving protects entryVersion and deleting source invalidates derived output', () => {
  const note = createMemoryNote(emptyMemory(), { memoryId: 'note_1', userText: '真实记录' }).state!;
  const draft = generateRecapDraft(note, {
    memoryId: 'recap_1',
    userText: '回顾草稿',
    baseContentRevision: note.contentRevision,
    originOperationId: 'op_1',
    sourceMemoryIds: ['note_1'],
  }).state!;

  const saved = patchMemory(draft, {
    memoryId: 'recap_1',
    status: 'saved',
    expectedContentRevision: draft.contentRevision,
    expectedEntryVersion: 1,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.entry?.entryVersion, 2);
  assert.equal(saved.entry?.status, 'saved');

  const staleWrite = patchMemory(saved.state!, {
    memoryId: 'recap_1',
    userText: '旧任务覆盖',
    expectedContentRevision: draft.contentRevision,
    expectedEntryVersion: 1,
  });
  assert.equal(staleWrite.ok, false);
  assert.ok(staleWrite.code === 'ENTRY_VERSION_CONFLICT' || staleWrite.code === 'SOURCE_CHANGED');

  const unlinked = generateRecapDraft(saved.state!, {
    memoryId: 'recap_without_source',
    userText: 'æ—§ç‰ˆå›žé¡¾è‰ç¨¿',
    baseContentRevision: saved.state!.contentRevision,
    originOperationId: 'op_unlinked',
  }).state!;
  const nested = generateRecapDraft(unlinked, {
    memoryId: 'recap_2',
    userText: 'ä¾èµ–å·²ç»ç”Ÿæˆçš„å›žé¡¾',
    baseContentRevision: saved.state!.contentRevision,
    originOperationId: 'op_2',
    sourceMemoryIds: ['recap_1'],
  }).state!;
  const afterDelete = deleteMemory(nested, 'note_1', '2026-09-20T19:00:00+08:00');
  assert.equal(afterDelete.ok, true);
  const recap = afterDelete.state?.entries.find((entry) => entry.memoryId === 'recap_1');
  assert.ok(recap?.staleAt);
  assert.ok(afterDelete.state?.entries.find((entry) => entry.memoryId === 'recap_2')?.staleAt,
    'deleting a source note invalidates every recap that depends on its recap chain');
  assert.ok(afterDelete.state?.entries.find((entry) => entry.memoryId === 'recap_without_source')?.staleAt,
    'deleting a note keeps the conservative invalidation policy for legacy recaps without source IDs');
  const regenerated = generateRecapDraft(afterDelete.state!, {
    userText: '重新生成',
    baseContentRevision: draft.contentRevision,
    originOperationId: 'op_2',
  });
  assert.equal(regenerated.ok, false);
  assert.equal(regenerated.code, 'SOURCE_CHANGED');
});

test('deleting a source message invalidates dependent memories, recap chains and unlinked recaps', () => {
  let state = emptyMemory();
  state = createMemoryNote(state, {
    memoryId: 'note_direct',
    userText: '聊天记录的原始内容',
    sourceMessageIds: ['message_removed'],
  }).state!;
  state = createMemoryNote(state, {
    memoryId: 'note_unrelated',
    userText: '另一条聊天记录',
    sourceMessageIds: ['message_kept'],
  }).state!;

  state = generateRecapDraft(state, {
    memoryId: 'recap_direct',
    userText: '依赖原始记忆的回顾',
    sourceMemoryIds: ['note_direct'],
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_direct',
  }).state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_nested',
    userText: '继续依赖上一条回顾',
    sourceMemoryIds: ['recap_direct'],
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_nested',
  }).state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_unrelated',
    userText: '只依赖另一条记忆',
    sourceMemoryIds: ['note_unrelated'],
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_unrelated',
  }).state!;

  const deletedNote = createMemoryNote(state, {
    memoryId: 'note_deleted',
    userText: '已删除的消息来源记录',
    sourceMessageIds: ['message_removed'],
  });
  state = deleteMemory(deletedNote.state!, 'note_deleted', '2026-09-20T20:00:00.000Z').state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_deleted',
    userText: '已删除的消息来源回顾',
    sourceMessageIds: ['message_removed'],
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_deleted',
  }).state!;
  state = deleteMemory(state, 'recap_deleted', '2026-09-20T20:01:00.000Z').state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_without_source',
    userText: '没有指向被删除来源的回顾',
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_recap_without_source',
  }).state!;

  const revision = state.contentRevision;
  const deletedAt = state.entries.find((entry) => entry.memoryId === 'note_deleted')?.deletedAt;
  const deletedRecapAt = state.entries.find((entry) => entry.memoryId === 'recap_deleted')?.deletedAt;
  const result = deleteSourceMessage(state, 'message_removed', '2026-09-20T21:00:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.state?.contentRevision, revision + 1);
  const entries = new Map(result.state?.entries.map((entry) => [entry.memoryId, entry]));
  assert.equal(entries.get('note_direct')?.staleAt, '2026-09-20T21:00:00.000Z');
  assert.equal(entries.get('recap_direct')?.staleAt, '2026-09-20T21:00:00.000Z');
  assert.equal(entries.get('recap_nested')?.staleAt, '2026-09-20T21:00:00.000Z');
  assert.equal(entries.get('note_unrelated')?.staleAt, null);
  assert.equal(entries.get('recap_unrelated')?.staleAt, null);
  assert.equal(entries.get('recap_without_source')?.staleAt, '2026-09-20T21:00:00.000Z',
    'recaps without explicit source IDs become stale when source material is removed');
  assert.equal(entries.get('note_deleted')?.deletedAt, deletedAt);
  assert.equal(entries.get('note_deleted')?.staleAt, null);
  assert.equal(entries.get('recap_deleted')?.deletedAt, deletedRecapAt);
  assert.equal(entries.get('recap_deleted')?.staleAt, null);

  const repeated = deleteSourceMessage(result.state!, 'message_removed', '2026-09-20T21:01:00.000Z');
  assert.equal(repeated.state?.contentRevision, revision + 1, 'invalidating the same source must not bump the version again');
  const unrelated = deleteSourceMessage(result.state!, 'message_without_memory', '2026-09-20T21:02:00.000Z');
  assert.equal(unrelated.state, result.state, 'deleting a message with no saved memory source leaves memory state untouched');
});

test('a deleted recap does not increase contentRevision and invalidates only its descendants', () => {
  let state = emptyMemory();
  state = createMemoryNote(state, { memoryId: 'note_1', userText: '记录' }).state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_1',
    userText: '草稿',
    baseContentRevision: state.contentRevision,
    originOperationId: 'op_1',
  }).state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_2', userText: 'ç¬¬äºŒå±‚å›žé¡¾', baseContentRevision: state.contentRevision,
    originOperationId: 'op_2', sourceMemoryIds: ['recap_1'],
  }).state!;
  state = generateRecapDraft(state, {
    memoryId: 'recap_unrelated', userText: 'æ²¡æœ‰æ˜Žç¡®æ¥æºçš„å›žé¡¾', baseContentRevision: state.contentRevision,
    originOperationId: 'op_unrelated',
  }).state!;
  const revision = state.contentRevision;
  const deleted = deleteMemory(state, 'recap_1');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state?.contentRevision, revision);
  assert.ok(deleted.state?.entries.find(entry => entry.memoryId === 'recap_2')?.staleAt,
    'deleting a recap invalidates its explicitly dependent descendants');
  assert.equal(deleted.state?.entries.find(entry => entry.memoryId === 'recap_unrelated')?.staleAt, null,
    'deleting a recap must not invalidate unrelated source-less recaps');
});

test('deleting an unrelated message leaves an empty trip memory unchanged', () => {
  const state = emptyMemory();
  const result = deleteSourceMessage(state, 'message_without_memory', '2026-09-20T21:00:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.state, state);
  assert.equal(result.state?.contentRevision, 0);
});

test('deleting an unreferenced message does not stale unrelated recap drafts', () => {
  const state = generateRecapDraft(emptyMemory(), {
    memoryId: 'unrelated_recap', userText: '已保存回顾', baseContentRevision: 0,
    originOperationId: 'unrelated_recap_op',
  }).state!;
  const result = deleteSourceMessage(state, 'message_without_memory', '2026-09-20T21:00:00.000Z');
  assert.equal(result.state, state);
  assert.equal(result.state.entries[0].staleAt, null);
});
