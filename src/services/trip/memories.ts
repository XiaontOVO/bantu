/**
 * 旅行记忆（随手记、路线回忆与回顾）。
 *
 * 两条贯穿全模块的规则：
 * - **只写真实素材**：来源（事件／消息／既有记录）被删除时，派生出的回顾会失效，
 *   而不是继续显示一段无法追溯的文字；
 * - **内容版本与计划版本分开**：这里只推进 `contentRevision`，不动 `revision`。
 */
import {
  createMemoryNote,
  deleteSourceMessage as deleteSourceMessageDomain,
  deleteMemory as deleteMemoryDomain,
  generateJourneyMemory as generateJourneyMemoryDomain,
  generateRecapDraft,
  patchMemory as patchMemoryDomain,
  type MemoryResult,
} from '../../domain/memory.js';
import { ownedTrip, toView } from './access.js';
import { tripClock } from '../../domain/plan-boundaries.js';
import { serviceError } from './helpers.js';
import type { MemoryCommandResult, ServiceResult, TripRecord } from './contracts.js';
import type { TripState } from './state.js';

export interface CreateMemoryInput {
  userText: string;
  localDate?: string;
  memoryId?: string;
  sourceEventIds?: string[];
  sourceMessageIds?: string[];
  expectedContentRevision?: number;
}

export interface PatchMemoryInput {
  userText?: string;
  status?: 'draft' | 'saved';
  expectedContentRevision: number;
  expectedEntryVersion: number;
}

export interface GenerateRecapInput {
  userText: string;
  baseContentRevision: number;
  originOperationId: string;
  sourceEventIds?: string[];
  sourceMessageIds?: string[];
  sourceMemoryIds?: string[];
}

/** 记录集的内容版本必须跟着旅行的内容版本走，否则来源失效判断会用到过期基准。 */
function syncMemories(record: TripRecord): void {
  record.memories.contentRevision = record.contentRevision;
}

/** 写入变更后的记录并返回它的视图；各写入口共用这段收尾。 */
function commit(
  state: TripState,
  record: TripRecord,
  entry: MemoryResult['entry'],
): ServiceResult<MemoryCommandResult> {
  state.trips.set(record.tripId, record);
  return { ok: true, value: { trip: toView(state, record), memory: entry } };
}

export function createMemory(
  state: TripState,
  actorId: string,
  tripId: string,
  input: CreateMemoryInput,
): ServiceResult<MemoryCommandResult> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  const now = state.now();
  syncMemories(record);
  if (
    input.expectedContentRevision !== undefined &&
    input.expectedContentRevision !== record.contentRevision
  ) {
    return { ok: false, error: serviceError('SOURCE_CHANGED', '来源材料已经变化，请重新读取。') };
  }
  const result = createMemoryNote(record.memories, {
    ...input,
    // Freeform notes and chat-recorded notes still need a date for the archive.
    // A day journal's explicitly selected date takes precedence.
    localDate: input.localDate ?? tripClock(record.snapshot, now).date,
    now,
  });
  if (!result.ok || !result.state || !result.entry) {
    return {
      ok: false,
      error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '记录失败。'),
    };
  }
  record.memories = result.state;
  record.contentRevision = result.state.contentRevision;
  record.updatedAt = now;
  return commit(state, record, result.entry);
}

export function patchMemory(
  state: TripState,
  actorId: string,
  tripId: string,
  memoryId: string,
  input: PatchMemoryInput,
): ServiceResult<MemoryCommandResult> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  syncMemories(record);
  const result = patchMemoryDomain(record.memories, { memoryId, ...input, now: state.now() });
  if (!result.ok || !result.state || !result.entry) {
    return {
      ok: false,
      error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '编辑失败。'),
    };
  }
  record.memories = result.state;
  record.updatedAt = state.now();
  return commit(state, record, result.entry);
}

export function generateRecap(
  state: TripState,
  actorId: string,
  tripId: string,
  input: GenerateRecapInput,
): ServiceResult<MemoryCommandResult> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  syncMemories(record);
  const result = generateRecapDraft(record.memories, { ...input, now: state.now() });
  if (!result.ok || !result.state || !result.entry) {
    return {
      ok: false,
      error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '生成回顾失败。'),
    };
  }
  record.memories = result.state;
  record.updatedAt = state.now();
  return commit(state, record, result.entry);
}

/** 手动保存某天的完成进度；旧日期在 ownedTrip 维护时已自动归档，按同一幂等键返回原记忆。 */
export function generateJourneyMemory(
  state: TripState,
  actorId: string,
  tripId: string,
  localDate: string,
): ServiceResult<MemoryCommandResult> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  const now = state.now();
  const timezone = record.snapshot.timezone || record.timezone || 'Asia/Shanghai';
  const today = tripClock(record.snapshot, now).date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(localDate) && localDate > today) {
    return { ok: false, error: serviceError('INVALID_INPUT', '未来的计划还没有真实完成进度，暂时不能生成旅行记忆。') };
  }
  syncMemories(record);
  const previousMemories = record.memories;
  const result = generateJourneyMemoryDomain(record.memories, {
    localDate,
    timezone,
    cityCode: record.cityCode,
    generatedBy: 'manual',
    fallbackDate: record.snapshot.travelDate || record.snapshot.localDate || record.snapshot.tripSettings?.localDate || record.localDate,
    stops: record.snapshot.stops || [],
    executionEvents: record.snapshot.executionEvents || [],
    routeLegs: record.snapshot.routeLegs || [],
    sourceContentRevision: record.contentRevision,
    now,
  });
  if (!result.ok || !result.state || !result.entry) {
    return {
      ok: false,
      error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '生成旅行记忆失败。'),
    };
  }
  record.memories = result.state;
  if (result.state !== previousMemories) record.updatedAt = now;
  return commit(state, record, result.entry);
}

export function deleteMemory(
  state: TripState,
  actorId: string,
  tripId: string,
  memoryId: string,
): ServiceResult<MemoryCommandResult> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  syncMemories(record);
  const result = deleteMemoryDomain(record.memories, memoryId, state.now());
  if (!result.ok || !result.state) {
    return {
      ok: false,
      error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '删除失败。'),
    };
  }
  record.memories = result.state;
  record.contentRevision = result.state.contentRevision;
  record.updatedAt = state.now();
  return commit(state, record, result.entry);
}

/** Mark personal records that cite a deleted chat message, and their derivatives, as stale. */
export function invalidateMessageSource(
  state: TripState,
  actorId: string,
  tripId: string,
  messageId: string,
): ServiceResult<true> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  syncMemories(record);
  const now = state.now();
  const result = deleteSourceMessageDomain(record.memories, messageId, now);
  if (!result.ok || !result.state) {
    return { ok: false, error: serviceError(result.code ?? 'INVALID_INPUT', result.message ?? '来源更新失败。') };
  }
  if (result.state === record.memories) return { ok: true, value: true };
  record.memories = result.state;
  record.contentRevision = result.state.contentRevision;
  record.updatedAt = now;
  state.trips.set(record.tripId, record);
  return { ok: true, value: true };
}

export function listMemories(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<MemoryResult['entry'][]> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  return {
    ok: true,
    value: tripResult.value.memories.entries.filter((entry) => !entry.deletedAt),
  };
}
