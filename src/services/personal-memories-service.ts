import { randomUUID } from 'node:crypto';
import type { ExecutionEvent, JourneyMemoryPlace, JourneyMemorySnapshot } from '../domain/types.js';

export interface PersonalMemory {
  memoryId: string;
  type: 'note';
  title: string;
  content: string;
  userText: string;
  localDate?: string;
  status: 'saved';
  entryVersion: number;
  createdAt: string;
  updatedAt: string;
  /** 完成日计划自动生成的记忆来源，用于幂等，旧笔记没有此字段。 */
  sourcePlanId?: string;
  journey?: JourneyMemorySnapshot;
  /** 原始进度后来被补记或纠正；保存的文字和记忆快照不自动改写。 */
  staleAt?: string;
}

export type JourneyMemoryPlan = {
  id: string;
  localDate?: string;
  timezone?: string;
  cityCode?: string;
  stops?: unknown[];
  routeLegs?: unknown[];
  executionEvents?: ExecutionEvent[];
};

type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

const MAX_TEXT_LENGTH = 20_000;

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** Account-owned notes that do not require, or create, a Trip. */
export class PersonalMemoriesService {
  private readonly notes: Record<string, PersonalMemory[]> = {};
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  list(actorId: string): PersonalMemory[] {
    return structuredClone(this.notes[actorId] ?? []);
  }

  create(actorId: string, input: { title?: string; content?: string; userText: string; localDate?: string }): ServiceResult<PersonalMemory> {
    const fields = input.title !== undefined || input.content !== undefined
      ? { title: input.title?.trim() ?? '', content: input.content?.trim() ?? '' }
      : splitUserText(input.userText);
    const text = composeUserText(fields.title, fields.content);
    if (!text) return this.invalid('请填写笔记内容。');
    if (text.length > MAX_TEXT_LENGTH) return this.invalid(`笔记不能超过 ${MAX_TEXT_LENGTH} 个字符。`);
    if (input.localDate !== undefined && !isValidDateKey(input.localDate)) {
      return this.invalid('日期格式无效。');
    }
    const timestamp = this.now();
    const note: PersonalMemory = {
      memoryId: `memory_${randomUUID()}`,
      type: 'note',
      ...fields,
      userText: text,
      ...(input.localDate ? { localDate: input.localDate } : {}),
      status: 'saved',
      entryVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    (this.notes[actorId] ??= []).unshift(note);
    return { ok: true, value: structuredClone(note) };
  }

  /**
   * 将无 Trip 的日计划进度保存为可编辑的旅行记忆。
   * 日计划会在完成最后一站时调用；重复调用只返回原记录，避免刷新或重试生成重复卡片。
   */
  createJourney(actorId: string, input: {
    plan: JourneyMemoryPlan;
    places: JourneyMemoryPlace[];
    firstEventAt: string | null;
    completedAt: string | null;
    elapsedMinutes: number | null;
    generatedBy: JourneyMemorySnapshot['generatedBy'];
  }): ServiceResult<PersonalMemory> {
    const plan = input.plan;
    const localDate = plan.localDate || '';
    if (!isValidDateKey(localDate)) return this.invalid('旅行记忆日期格式无效。');
    const existing = (this.notes[actorId] ?? []).find(note => note.sourcePlanId === plan.id);
    if (existing) return { ok: true, value: structuredClone(existing) };
    const places = input.places.filter(place => Boolean(place?.name));
    if (!places.length) return this.invalid('没有已完成的地点，暂时无法生成旅行记忆。');
    const route = places.map(place => place.name).join(' → ');
    const title = '这一天，走过的路';
    const content = `地点：${route}`;
    const userText = `${title}\n${content}`;
    const timestamp = this.now();
    const journey: JourneyMemorySnapshot = {
      localDate,
      timezone: plan.timezone || 'Asia/Shanghai',
      cityCode: plan.cityCode || '',
      generatedBy: input.generatedBy,
      firstEventAt: input.firstEventAt,
      completedAt: input.completedAt,
      elapsedMinutes: input.elapsedMinutes,
      places,
    };
    const note: PersonalMemory = {
      memoryId: `memory_${randomUUID()}`,
      type: 'note',
      title,
      content,
      userText,
      localDate,
      status: 'saved',
      entryVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      sourcePlanId: plan.id,
      journey,
    };
    (this.notes[actorId] ??= []).unshift(note);
    return { ok: true, value: structuredClone(note) };
  }

  markJourneyChanged(actorId: string, planId: string) {
    const note = (this.notes[actorId] || []).find(item => item.sourcePlanId === planId);
    if (note && !note.staleAt) { note.staleAt = this.now(); note.entryVersion += 1; }
  }

  patch(actorId: string, memoryId: string, input: { title?: string; content?: string; userText?: string; localDate?: string | null; expectedEntryVersion?: number }): ServiceResult<PersonalMemory> {
    const list = this.notes[actorId] ?? [];
    const index = list.findIndex(note => note.memoryId === memoryId);
    if (index < 0) return this.notFound();

    const previous = list[index];
    if (input.expectedEntryVersion !== undefined) {
      if (!Number.isSafeInteger(input.expectedEntryVersion) || input.expectedEntryVersion < 1) return this.invalid('笔记版本无效，请重新打开记录。');
      if (input.expectedEntryVersion !== previous.entryVersion) return { ok: false, error: {
        code: 'ENTRY_VERSION_CONFLICT', message: '这条笔记已在其他页面更新，请重新打开并核对；当前修改尚未保存。',
      } };
    }
    const fields = input.userText !== undefined
      ? splitUserText(input.userText)
      : { title: input.title?.trim() ?? previous.title, content: input.content?.trim() ?? previous.content };
    const text = composeUserText(fields.title, fields.content);
    if (!text) return this.invalid('笔记内容不能为空。');
    if (text.length > MAX_TEXT_LENGTH) return this.invalid(`笔记不能超过 ${MAX_TEXT_LENGTH} 个字符。`);
    if (input.localDate !== undefined && input.localDate !== null && !isValidDateKey(input.localDate)) {
      return this.invalid('日期格式无效。');
    }

    const next: PersonalMemory = {
      ...previous,
      ...fields,
      userText: text,
      ...(input.localDate === undefined
        ? {}
        : input.localDate === null
          ? { localDate: undefined }
          : { localDate: input.localDate }),
      entryVersion: previous.entryVersion + 1,
      updatedAt: this.now(),
    };
    list[index] = next;
    return { ok: true, value: structuredClone(next) };
  }

  delete(actorId: string, memoryId: string): ServiceResult<{ deleted: true }> {
    const list = this.notes[actorId] ?? [];
    const index = list.findIndex(note => note.memoryId === memoryId);
    if (index < 0) return this.notFound();
    list.splice(index, 1);
    return { ok: true, value: { deleted: true } };
  }

  serialize(): string {
    return JSON.stringify(this.notes);
  }

  loadSerialized(value: string): void {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('个人记忆数据格式无效。');
    }
    const restored: Record<string, PersonalMemory[]> = {};
    for (const [actorId, rawList] of Object.entries(parsed)) {
      if (!Array.isArray(rawList)) throw new Error('个人记忆数据格式无效。');
      restored[actorId] = rawList.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('个人记忆条目格式无效。');
        const item = raw as Record<string, unknown>;
        if (
          typeof item.memoryId !== 'string' || !item.memoryId ||
          typeof item.userText !== 'string' || !item.userText.trim() ||
          typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' ||
          (item.localDate !== undefined && (typeof item.localDate !== 'string' || !isValidDateKey(item.localDate)))
        ) throw new Error('个人记忆条目格式无效。');
        return {
          memoryId: item.memoryId,
          type: 'note',
          ...splitUserText(item.userText),
          userText: item.userText,
          ...(typeof item.localDate === 'string' ? { localDate: item.localDate } : {}),
          ...(typeof item.sourcePlanId === 'string' && item.sourcePlanId ? { sourcePlanId: item.sourcePlanId } : {}),
          ...(typeof item.staleAt === 'string' && Number.isFinite(Date.parse(item.staleAt)) ? { staleAt: item.staleAt } : {}),
          ...(item.journey && typeof item.journey === 'object' && !Array.isArray(item.journey)
            ? { journey: restoreJourney(item.journey as Record<string, unknown>) }
            : {}),
          status: 'saved',
          entryVersion: Number.isSafeInteger(item.entryVersion) && Number(item.entryVersion) > 0 ? Number(item.entryVersion) : 1,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      });
    }
    for (const key of Object.keys(this.notes)) delete this.notes[key];
    Object.assign(this.notes, restored);
  }

  private invalid(message: string): ServiceResult<never> {
    return { ok: false, error: { code: 'INVALID_INPUT', message } };
  }

  private notFound(): ServiceResult<never> {
    return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '这条笔记不存在。' } };
  }
}

function splitUserText(userText: string): { title: string; content: string } {
  const [firstLine = '', ...rest] = userText.split(/\r\n|\n|\r/);
  return { title: firstLine.trim(), content: rest.join('\n').trim() };
}

function composeUserText(title: string, content: string): string {
  return [title.trim(), content.trim()].filter(Boolean).join('\n');
}

function restoreJourney(value: Record<string, unknown>): JourneyMemorySnapshot {
  const localDate = typeof value.localDate === 'string' ? value.localDate : '';
  if (!isValidDateKey(localDate)) throw new Error('个人旅行记忆日期格式无效。');
  const rawPlaces = Array.isArray(value.places) ? value.places : [];
  const places: JourneyMemoryPlace[] = rawPlaces.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || !item.name.trim()) return [];
    return [{
      stopId: typeof item.stopId === 'string' ? item.stopId : `memory-stop-${index + 1}`,
      ...(typeof item.placeId === 'string' ? { placeId: item.placeId } : {}),
      name: item.name,
      ...(typeof item.arrivedAt === 'string' ? { arrivedAt: item.arrivedAt } : {}),
      ...(typeof item.completedAt === 'string' ? { completedAt: item.completedAt } : {}),
      ...(typeof item.visitMinutes === 'number' ? { visitMinutes: item.visitMinutes } : {}),
      ...(typeof item.transferMode === 'string' ? { transferMode: item.transferMode as JourneyMemoryPlace['transferMode'] } : {}),
      ...(typeof item.transferMinutes === 'number' ? { transferMinutes: item.transferMinutes } : {}),
    }];
  });
  return {
    localDate,
    timezone: typeof value.timezone === 'string' && value.timezone ? value.timezone : 'Asia/Shanghai',
    cityCode: typeof value.cityCode === 'string' ? value.cityCode : '',
    generatedBy: value.generatedBy === 'expiry' ? 'expiry' : 'manual',
    firstEventAt: typeof value.firstEventAt === 'string' ? value.firstEventAt : null,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    elapsedMinutes: typeof value.elapsedMinutes === 'number' && Number.isFinite(value.elapsedMinutes) ? value.elapsedMinutes : null,
    places,
  };
}
