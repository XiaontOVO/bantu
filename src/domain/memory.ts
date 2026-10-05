import type {
  ExecutionEvent,
  MemoryEntry,
  PlanStop,
  RouteLeg,
} from './types.js';

export interface MemoryState {
  tripId: string;
  contentRevision: number;
  entries: MemoryEntry[];
}

export interface MemoryResult {
  ok: boolean;
  state?: MemoryState;
  entry?: MemoryEntry;
  code?: string;
  message?: string;
}

export interface GenerateJourneyMemoryInput {
  localDate: string;
  timezone: string;
  cityCode: string;
  generatedBy: 'manual' | 'expiry';
  fallbackDate?: string;
  stops: readonly PlanStop[];
  executionEvents: readonly ExecutionEvent[];
  routeLegs: readonly RouteLeg[];
  sourceContentRevision?: number;
  now?: string;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function findEntry(state: MemoryState, memoryId: string): MemoryEntry | undefined {
  return state.entries.find((entry) => entry.memoryId === memoryId);
}

/**
 * 生成一个在本趟记录内**未被占用**的 id。
 *
 * 不能用 `Date.now()`：它只有毫秒精度，同一毫秒内创建的两条记录会拿到同一个 id。
 * 而查找／替换／删除都是按 memoryId 做的，重复 id 会让两条记录变成一条——
 * 编辑其中一条等于改两条，删除一条等于删两条（并发提交随手记时必现）。
 *
 * 序号取自当前条目数并从 1 开始试探，因此与持久化/恢复后的状态一致，也不需要随机源：
 * 领域层没有 IO，能算出来的东西就不要靠时钟或随机数。
 */
function nextMemoryId(state: MemoryState, prefix: string): string {
  const taken = new Set(state.entries.map((entry) => entry.memoryId));
  let seq = state.entries.length + 1;
  let candidate = `${prefix}_${seq.toString(36)}`;
  while (taken.has(candidate)) {
    seq += 1;
    candidate = `${prefix}_${seq.toString(36)}`;
  }
  return candidate;
}

/** 调用方显式指定 id 时，占用了别的记录就拒绝，不要静默合并两条记录。 */
function idTaken(state: MemoryState, memoryId: string | undefined): boolean {
  return memoryId !== undefined && findEntry(state, memoryId) !== undefined;
}

function replaceEntry(state: MemoryState, entry: MemoryEntry): MemoryState {
  return {
    ...state,
    entries: state.entries.map((item) => (item.memoryId === entry.memoryId ? entry : item)),
  };
}

/** 用户随手记直接 saved，来源可为空；新增用户材料使 contentRevision 递增。 */
export function createMemoryNote(
  state: MemoryState,
  input: {
    memoryId?: string;
    userText: string;
    localDate?: string;
    sourceEventIds?: string[];
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    provenanceRefs?: string[];
    originOperationId?: string | null;
    now?: string;
  },
): MemoryResult {
  if (!input.userText.trim()) {
    return { ok: false, code: 'INVALID_INPUT', message: '记录内容不能为空。' };
  }
  if (input.localDate !== undefined && !isDateKey(input.localDate)) {
    return { ok: false, code: 'INVALID_INPUT', message: '旅行记录日期无效。' };
  }
  if (idTaken(state, input.memoryId)) {
    return { ok: false, code: 'INVALID_INPUT', message: '记录编号已被占用。' };
  }
  const timestamp = nowIso(input.now);
  const entry: MemoryEntry = {
    memoryId: input.memoryId ?? nextMemoryId(state, 'memory'),
    tripId: state.tripId,
    type: 'note',
    entryVersion: 1,
    userText: input.userText,
    sourceEventIds: input.sourceEventIds ?? [],
    sourceMessageIds: input.sourceMessageIds ?? [],
    sourceMemoryIds: input.sourceMemoryIds ?? [],
    sourceContentRevision: state.contentRevision,
    provenanceRefs: input.provenanceRefs ?? [],
    status: 'saved',
    originOperationId: input.originOperationId ?? null,
    ...(input.localDate ? { localDate: input.localDate } : {}),
    staleAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ok: true,
    entry,
    state: {
      ...state,
      contentRevision: state.contentRevision + 1,
      entries: [...state.entries, entry],
    },
  };
}

/**
 * 生成回顾草稿：
 * - 绑定 baseContentRevision，材料变化后旧任务不能保存；
 * - 生成草稿本身不增加 contentRevision，避免结果一生成就失效；
 * - 同一 originOperationId 最多一条生成草稿。
 */
export function generateRecapDraft(
  state: MemoryState,
  input: {
    memoryId?: string;
    userText: string;
    sourceEventIds?: string[];
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    provenanceRefs?: string[];
    baseContentRevision: number;
    originOperationId: string;
    now?: string;
  },
): MemoryResult {
  if (input.baseContentRevision !== state.contentRevision) {
    return { ok: false, code: 'SOURCE_CHANGED', message: '来源材料已经变化，请重新生成回顾。' };
  }
  const existing = state.entries.find(
    (entry) => entry.type === 'recap' && entry.originOperationId === input.originOperationId,
  );
  if (existing) {
    return { ok: true, state, entry: existing };
  }
  if (idTaken(state, input.memoryId)) {
    return { ok: false, code: 'INVALID_INPUT', message: '记录编号已被占用。' };
  }
  const timestamp = nowIso(input.now);
  const entry: MemoryEntry = {
    memoryId: input.memoryId ?? nextMemoryId(state, 'recap'),
    tripId: state.tripId,
    type: 'recap',
    entryVersion: 1,
    userText: input.userText,
    sourceEventIds: input.sourceEventIds ?? [],
    sourceMessageIds: input.sourceMessageIds ?? [],
    sourceMemoryIds: input.sourceMemoryIds ?? [],
    sourceContentRevision: state.contentRevision,
    provenanceRefs: input.provenanceRefs ?? [],
    status: 'draft',
    originOperationId: input.originOperationId,
    staleAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ok: true, entry, state: { ...state, entries: [...state.entries, entry] } };
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function elapsedMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration / 60_000) : null;
}

function eventIsArrival(event: ExecutionEvent): boolean {
  return event.statusOverride !== undefined
    ? event.statusOverride === 'visiting'
    : event.type === 'arrive';
}

function eventIsCompletion(event: ExecutionEvent): boolean {
  return event.statusOverride !== undefined
    ? event.statusOverride === 'completed'
    : event.type === 'complete';
}

function eventIsJourneyMoment(event: ExecutionEvent): boolean {
  if (event.statusOverride !== undefined) {
    return ['en_route', 'visiting', 'completed'].includes(event.statusOverride);
  }
  return ['depart', 'arrive', 'complete'].includes(event.type);
}

/**
 * 把当天已完成的地点和真实进度时间冻结为一条旅行记忆。
 * originOperationId 由旅行与当地日期组成，因此手动和过期任务都只会生成一条。
 */
export function generateJourneyMemory(
  state: MemoryState,
  input: GenerateJourneyMemoryInput,
): MemoryResult {
  if (!isDateKey(input.localDate)) {
    return { ok: false, code: 'INVALID_INPUT', message: '旅行日期无效。' };
  }
  const originOperationId = `journey:${state.tripId}:${input.localDate}`;
  const existing = state.entries.find(entry => entry.type === 'recap' && entry.originOperationId === originOperationId);

  const stops = input.stops.filter(stop =>
    stop?.status === 'completed' && (stop.date || input.fallbackDate) === input.localDate,
  );
  const correctedIds = new Set(input.executionEvents.flatMap(event =>
    event.correctsEventId ? [event.correctsEventId] : [],
  ));
  const validEvents = input.executionEvents.filter(event =>
    !correctedIds.has(event.executionEventId) && Number.isFinite(Date.parse(event.occurredAt)),
  );
  const sourceEvents = validEvents.filter(event => stops.some(stop => stop.stopId === event.stopId));
  if (!stops.length) {
    if (existing && !existing.deletedAt) {
      // Expiry maintenance removes the source stops only after freezing this
      // snapshot. A later retry for that date must not infer a correction from
      // the intentionally pruned source data.
      if (existing.staleAt || existing.journey) return { ok: true, state, entry: existing };
      const timestamp = nowIso(input.now);
      const staleEntry = { ...existing, staleAt: timestamp, updatedAt: timestamp };
      return { ok: true, state: replaceEntry(state, staleEntry), entry: staleEntry };
    }
    return { ok: false, code: 'INVALID_INPUT', message: '这一天还没有已完成的地点，暂时不能生成旅行记忆。' };
  }
  if (existing) {
    if (existing.deletedAt && input.generatedBy === 'expiry') return { ok: true, state, entry: existing };
    const savedStopIds = new Set(existing.journey?.places.map(place => place.stopId) || []);
    const currentStopIds = new Set(stops.map(stop => stop.stopId));
    const sameStops = savedStopIds.size === currentStopIds.size &&
      [...currentStopIds].every(stopId => savedStopIds.has(stopId));
    const savedEvents = new Set(existing.sourceEventIds);
    const currentEvents = new Set(sourceEvents.map(event => event.executionEventId));
    const sameEvents = savedEvents.size === currentEvents.size &&
      [...currentEvents].every(eventId => savedEvents.has(eventId));
    if (!existing.deletedAt && !existing.staleAt && existing.journey && sameStops && sameEvents) {
      return { ok: true, state, entry: existing };
    }
  }

  const resetAt = new Map<string, number>();
  for (const event of validEvents) {
    if (event.type !== 'abort' && event.statusOverride !== 'planned') continue;
    const time = Date.parse(event.occurredAt);
    resetAt.set(event.stopId, Math.max(resetAt.get(event.stopId) ?? Number.NEGATIVE_INFINITY, time));
  }
  const journeyEvents = validEvents.filter(event => {
    if (!eventIsJourneyMoment(event)) return false;
    const reset = resetAt.get(event.stopId);
    return reset === undefined || Date.parse(event.occurredAt) > reset;
  });
  const originalOrder = new Map(stops.map((stop, index) => [stop.stopId, index]));
  const firstEventTime = new Map<string, number>();
  for (const stop of stops) {
    const eventTimes = journeyEvents
      .filter(event => event.stopId === stop.stopId)
      .map(event => Date.parse(event.occurredAt));
    if (eventTimes.length) firstEventTime.set(stop.stopId, Math.min(...eventTimes));
  }
  const hasCompleteActualOrder = stops.every(stop => firstEventTime.has(stop.stopId));
  const orderedStops = stops.slice().sort((a, b) => {
    const aTime = firstEventTime.get(a.stopId);
    const bTime = firstEventTime.get(b.stopId);
    if (hasCompleteActualOrder && aTime !== undefined && bTime !== undefined && aTime !== bTime) return aTime - bTime;
    const plannedOrder = (a.plannedArrivalMinutes ?? Number.MAX_SAFE_INTEGER) -
      (b.plannedArrivalMinutes ?? Number.MAX_SAFE_INTEGER);
    return plannedOrder || (originalOrder.get(a.stopId) ?? 0) - (originalOrder.get(b.stopId) ?? 0);
  });

  const places = orderedStops.map((stop, index) => {
    const stopEvents = journeyEvents
      .filter(event => event.stopId === stop.stopId)
      .slice()
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const completion = stopEvents.slice().reverse().find(eventIsCompletion);
    const completionTime = completion ? Date.parse(completion.occurredAt) : Number.POSITIVE_INFINITY;
    const arrival = stopEvents.slice().reverse().find(event =>
      eventIsArrival(event) && Date.parse(event.occurredAt) <= completionTime,
    );
    const visit = elapsedMinutes(arrival?.occurredAt ?? null, completion?.occurredAt ?? null);
    const previous = orderedStops[index - 1];
    const leg = previous && input.routeLegs.find(item =>
      item.fromStopId === previous.stopId && item.toStopId === stop.stopId,
    );
    const transferMinutes = leg?.durationMinutes ?? (leg?.durationSeconds !== undefined
      ? Math.ceil(leg.durationSeconds / 60)
      : undefined);
    return {
      stopId: stop.stopId,
      placeId: stop.place?.placeId || stop.placeId || null,
      name: stop.place?.name?.trim() || stop.placeId || stop.stopId,
      arrivedAt: arrival?.occurredAt ?? null,
      completedAt: completion?.occurredAt ?? null,
      visitMinutes: visit,
      transferMode: leg?.transportMode ?? null,
      transferMinutes: transferMinutes ?? null,
    };
  });

  const completedStopIds = new Set(stops.map(stop => stop.stopId));
  const timedEvents = journeyEvents
    .filter(event => completedStopIds.has(event.stopId))
    .slice()
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const firstEventAt = timedEvents[0]?.occurredAt ?? null;
  const completedAt = timedEvents.slice().reverse().find(eventIsCompletion)?.occurredAt ?? null;
  const totalMinutes = firstEventAt && completedAt && Date.parse(completedAt) >= Date.parse(firstEventAt)
    ? elapsedMinutes(firstEventAt, completedAt)
    : null;
  const names = places.map(place => place.name);
  const routeTitle = names.length > 1
    ? `${names[0]} 到 ${names[names.length - 1]}`
    : `${names[0]} 的一天`;
  const route = names.join('、');
  const durationText = totalMinutes === null
    ? '当天没有完整的起止进度记录，无法计算用时。'
    : `从当天第一条进度记录到最后一站完成，相隔 ${totalMinutes === 0 ? '不足 1 分钟' : totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)} 小时${totalMinutes % 60 ? ` ${totalMinutes % 60} 分钟` : ''}` : `${totalMinutes} 分钟`}。`;
  const generatedText = `${routeTitle}\n${input.localDate}，你走过 ${route}。${durationText}每一次停留，都让这条路线成为只属于你的记忆。`;
  const userText = existing && !existing.deletedAt && existing.entryVersion > 1
    ? existing.userText
    : generatedText;
  const timestamp = nowIso(input.now);
  const entry: MemoryEntry = {
    memoryId: existing?.memoryId ?? nextMemoryId(state, 'journey'),
    tripId: state.tripId,
    type: 'recap',
    entryVersion: existing?.deletedAt ? 1 : existing?.entryVersion ?? 1,
    userText,
    sourceEventIds: sourceEvents.map(event => event.executionEventId),
    sourceMessageIds: [],
    sourceMemoryIds: [],
    sourceContentRevision: input.sourceContentRevision ?? state.contentRevision,
    provenanceRefs: sourceEvents.map(event => event.executionEventId),
    status: 'saved',
    originOperationId,
    journey: {
      localDate: input.localDate,
      timezone: input.timezone,
      cityCode: input.cityCode,
      generatedBy: input.generatedBy,
      firstEventAt,
      completedAt,
      elapsedMinutes: totalMinutes,
      places,
    },
    staleAt: null,
    deletedAt: null,
    createdAt: existing?.deletedAt ? timestamp : existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  return {
    ok: true,
    entry,
    state: existing
      ? replaceEntry(state, entry)
      : { ...state, entries: [...state.entries, entry] },
  };
}

/**
 * A progress correction changes the source facts captured by a journey memory.
 * Keep the original card as a historical snapshot, but mark it so the UI cannot
 * present it as an up-to-date account of the trip.
 */
export function invalidateJourneyMemoryForEvent(
  state: MemoryState,
  eventId: string,
  now?: string,
): MemoryState {
  const timestamp = nowIso(now);
  let changed = false;
  const entries = state.entries.map(entry => {
    if (
      !entry.journey || entry.deletedAt || entry.staleAt ||
      !entry.sourceEventIds.includes(eventId)
    ) return entry;
    changed = true;
    return { ...entry, staleAt: timestamp, updatedAt: timestamp };
  });
  return changed ? { ...state, entries } : state;
}

/** 编辑草稿或保存；只有用户文本/状态变化增加 entryVersion，不改变 contentRevision。 */
export function patchMemory(
  state: MemoryState,
  input: {
    memoryId: string;
    userText?: string;
    status?: 'draft' | 'saved';
    expectedContentRevision: number;
    expectedEntryVersion: number;
    now?: string;
  },
): MemoryResult {
  const entry = findEntry(state, input.memoryId);
  if (!entry || entry.deletedAt) {
    return { ok: false, code: 'RESOURCE_NOT_FOUND', message: '记录不存在。' };
  }
  if (entry.staleAt) {
    return { ok: false, code: 'SOURCE_CHANGED', message: '来源材料已经变化，请重新生成。' };
  }
  if (input.expectedContentRevision !== state.contentRevision) {
    return { ok: false, code: 'SOURCE_CHANGED', message: '来源材料已经变化，请重新生成。' };
  }
  if (input.expectedEntryVersion !== entry.entryVersion) {
    return { ok: false, code: 'ENTRY_VERSION_CONFLICT', message: '记录已被修改，请刷新后重试。' };
  }
  const next: MemoryEntry = {
    ...entry,
    userText: input.userText ?? entry.userText,
    status: input.status ?? entry.status,
    entryVersion: entry.entryVersion + 1,
    updatedAt: nowIso(input.now),
  };
  return { ok: true, entry: next, state: replaceEntry(state, next) };
}

/**
 * 删除记录：
 * - 删除 note 属于用户材料变化，contentRevision 递增并使派生回顾失效；
 * - 删除 recap 不递增材料版本，但它的派生回顾也必须失效。
 */
export function deleteMemory(
  state: MemoryState,
  memoryId: string,
  now?: string,
): MemoryResult {
  const entry = findEntry(state, memoryId);
  if (!entry || entry.deletedAt) {
    return { ok: false, code: 'RESOURCE_NOT_FOUND', message: '记录不存在。' };
  }
  const timestamp = nowIso(now);
  const deleted: MemoryEntry = { ...entry, deletedAt: timestamp, updatedAt: timestamp };
  const withDeletedEntry = replaceEntry(state, deleted);
  const invalidated = invalidateMemorySources(withDeletedEntry.entries, [entry.memoryId], timestamp, {
    // Old recaps can predate explicit source references. Preserve the existing
    // conservative policy for removed notes, but don't invalidate unrelated
    // drafts when the removed source is itself a recap.
    invalidateUnlinkedRecaps: entry.type === 'note',
  });
  const nextState: MemoryState = {
    ...withDeletedEntry,
    contentRevision: entry.type === 'note' ? withDeletedEntry.contentRevision + 1 : withDeletedEntry.contentRevision,
    entries: invalidated.entries,
  };
  return { ok: true, entry: deleted, state: nextState };
}

/** 删除来源消息：contentRevision 变化，相关派生内容标记 stale。 */
export function deleteSourceMessage(
  state: MemoryState,
  messageId: string,
  now?: string,
): MemoryResult {
  const timestamp = nowIso(now);
  // First collect entries that cite the message, then walk memory-to-memory
  // references so every downstream recap is invalidated as well. Keep deleted
  // entries in the traversal: live descendants can still depend on them.
  const affectedIds = new Set(
    state.entries
      .filter((entry) => entry.sourceMessageIds.includes(messageId))
      .map((entry) => entry.memoryId),
  );
  const removesActiveMemorySource = state.entries.some((entry) =>
    affectedIds.has(entry.memoryId) && !entry.deletedAt && !entry.staleAt,
  );
  // Older recap drafts may not record which memories they used. Invalidate
  // those drafts when this message actually removes active saved material.
  if (removesActiveMemorySource) {
    for (const entry of state.entries) {
      if (
        entry.type === 'recap' &&
        !entry.deletedAt &&
        !entry.journey &&
        entry.sourceMessageIds.length === 0 &&
        entry.sourceEventIds.length === 0 &&
        entry.sourceMemoryIds.length === 0
      ) {
        affectedIds.add(entry.memoryId);
      }
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const entry of state.entries) {
      if (
        !affectedIds.has(entry.memoryId) &&
        entry.sourceMemoryIds.some((sourceId) => affectedIds.has(sourceId))
      ) {
        affectedIds.add(entry.memoryId);
        expanded = true;
      }
    }
  }

  let changed = false;
  const entries = state.entries.map((entry) => {
    if (!affectedIds.has(entry.memoryId) || entry.deletedAt || entry.staleAt) return entry;
    changed = true;
    return { ...entry, staleAt: timestamp, updatedAt: timestamp };
  });
  return {
    ok: true,
    state: changed ? {
      ...state,
      contentRevision: state.contentRevision + 1,
      entries,
    } : state,
  };
}

/**
 * sourceRefs 失效传播：not source of truth 的草稿/回顾不能恢复已删除材料。
 * 返回新 entries 与被影响数量。
 */
export function invalidateMemorySources(
  entries: readonly MemoryEntry[],
  removedMemoryIds: readonly string[],
  now: string,
  options: { invalidateUnlinkedRecaps?: boolean } = {},
): { entries: MemoryEntry[]; affectedMemoryIds: string[] } {
  const affected = new Set(removedMemoryIds);
  if (options.invalidateUnlinkedRecaps && removedMemoryIds.length > 0) {
    for (const entry of entries) {
      if (
        entry.type === 'recap' &&
        !entry.journey &&
        entry.sourceMessageIds.length === 0 &&
        entry.sourceEventIds.length === 0 &&
        entry.sourceMemoryIds.length === 0
      ) affected.add(entry.memoryId);
    }
  }
  // Follow recap-to-recap references to a fixed point. Keep deleted entries in
  // the graph so their live descendants are still invalidated.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const entry of entries) {
      if (!affected.has(entry.memoryId) && entry.sourceMemoryIds.some(id => affected.has(id))) {
        affected.add(entry.memoryId);
        expanded = true;
      }
    }
  }

  const next = entries.map((entry) => {
    if (!affected.has(entry.memoryId) || entry.deletedAt || entry.staleAt) {
      return entry;
    }
    return { ...entry, staleAt: now, updatedAt: now };
  });
  return { entries: next, affectedMemoryIds: [...affected] };
}

/** 旧任务保存前 CAS 校验：来源版本或条目版本不符都不能覆盖。 */
export function assertMemoryWritable(
  state: MemoryState,
  entry: MemoryEntry,
  expectedContentRevision: number,
  expectedEntryVersion: number,
): { ok: true } | { ok: false; code: string; message: string } {
  if (entry.deletedAt || entry.staleAt) {
    return { ok: false, code: 'SOURCE_CHANGED', message: '记录已失效。' };
  }
  if (expectedContentRevision !== state.contentRevision) {
    return { ok: false, code: 'SOURCE_CHANGED', message: '来源材料已经变化。' };
  }
  if (expectedEntryVersion !== entry.entryVersion) {
    return { ok: false, code: 'ENTRY_VERSION_CONFLICT', message: '记录已被修改。' };
  }
  return { ok: true };
}
