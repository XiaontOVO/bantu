import { randomUUID } from 'node:crypto';
import type { ActionRequest } from '../domain/types.js';
import { parseConfirmationText, parseDirectCommand } from '../domain/authorization.js';
import { InMemoryTripService, type ServiceResult } from './trip-service.js';

export interface MessageRecord {
  messageId: string;
  tripId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  agentMode?: 'tools' | 'rules';
  companionAdjustment?: import('./personal-agent-companion.js').AgentCompanionAdjustment;
  companionDelegation?: import('./personal-agent-delegation.js').CompanionDelegation;
  images?: Array<{ dataUrl: string; alt: string }>;
  resultLinks?: import('./personal-agent-result-links.js').AgentResultLink[];
  clientMessageId: string | null;
  sourceRefs: string[];
  actionRequestId: string | null;
  createdAt: string;
  redactedAt: string | null;
}

export interface MessageReply {
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  status: 'authorized' | 'rejected' | 'needs_clarification' | 'answered' | 'recorded';
  actionRequest?: ActionRequest;
  memory?: { memoryId: string; userText: string };
}

export interface MessageRedaction {
  message: MessageRecord;
  changed: boolean;
}

/** 内存版对话入口：只处理确定性确认和直接命令，其他文本留给模型任务。 */
export class MessageService {
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly conversationMetadata = new Map<string, { title?: string; createdAt: string; deleted?: boolean }>();

  constructor(
    private readonly tripService: InMemoryTripService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private append(record: MessageRecord): MessageRecord {
    const list = this.messages.get(record.tripId) ?? [];
    list.push(record);
    this.messages.set(record.tripId, list);
    return record;
  }

  /** 组装并追加一条消息；字段默认值集中在这里，避免各处字面量漂移。 */
  private build(input: {
    tripId: string;
    role: MessageRecord['role'];
    text: string;
    createdAt: string;
    clientMessageId?: string | null;
    actionRequestId?: string | null;
    sourceRefs?: string[];
  }): MessageRecord {
    return this.append({
      messageId: `message_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      tripId: input.tripId,
      role: input.role,
      text: input.text,
      clientMessageId: input.clientMessageId ?? null,
      sourceRefs: input.sourceRefs ?? [],
      actionRequestId: input.actionRequestId ?? null,
      createdAt: input.createdAt,
      redactedAt: null,
    });
  }

  list(tripId: string): MessageRecord[] {
    return (this.messages.get(tripId) ?? []).filter((message) => !message.redactedAt);
  }

  /** Read the newest messages first, then page backward from a stable message ID. */
  page(tripId: string, limit: number, beforeMessageId?: string): {
    items: MessageRecord[];
    nextCursor: string | null;
  } | null {
    const records = this.messages.get(tripId) ?? [];
    let end = records.length;
    if (beforeMessageId) {
      const boundary = records.findIndex((message) => message.messageId === beforeMessageId);
      if (boundary < 0) return null;
      end = boundary;
    }

    const visible = records.slice(0, end).filter((message) => !message.redactedAt);
    const items = visible.slice(-limit);
    const hasEarlier = visible.length > items.length;
    return {
      items,
      nextCursor: hasEarlier && items.length ? items[0].messageId : null,
    };
  }

  /** 用实际任务结果替换占位回复；刷新后仍显示同一结果。 */
  updateReply(message: MessageRecord, text: string): void {
    message.text = text;
  }

  redact(tripId: string, messageId: string): ServiceResult<MessageRedaction> {
    const list = this.messages.get(tripId) ?? [];
    const message = list.find((item) => item.messageId === messageId);
    if (!message) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '消息不存在。' } };
    }
    const changed = !message.redactedAt;
    if (changed) { message.redactedAt = this.now(); delete message.images; }
    return { ok: true, value: { message, changed } };
  }

  redactGeneral(actorId: string, messageId: string): ServiceResult<MessageRedaction> {
    return this.redact(this.generalKey(actorId), messageId);
  }

  /** 旅行被删除后清理其对话，避免内存里留下仍可读取的孤儿记录。 */
  clearTrip(tripId: string): void {
    this.messages.delete(tripId);
  }

  /** 无旅行的通用对话：按 actorId 会话键存取，不校验行程，也不触发行程授权。 */
  private generalKey(actorId: string, conversationId = ''): string {
    const root = `agent-general-${actorId}`;
    if (!conversationId) {
      if (this.conversationMetadata.get(root)?.deleted) throw new Error('对话已删除。');
      return root;
    }
    const key = `${root}:${conversationId}`;
    if (!/^conversation_[a-f0-9]{32}$/.test(conversationId) || !this.messages.has(key)) throw new Error('对话不存在或不属于当前账号。');
    return key;
  }

  createGeneralConversation(actorId: string) {
    const conversationId = `conversation_${randomUUID().replaceAll('-', '')}`;
    const key = `agent-general-${actorId}:${conversationId}`;
    this.messages.set(key, []);
    this.conversationMetadata.set(key, { createdAt: this.now() });
    return this.generalConversations(actorId).find(item => item.conversationId === conversationId)!;
  }

  renameGeneralConversation(actorId: string, conversationId: string, value: unknown) {
    const key = this.generalKey(actorId, conversationId);
    if (typeof value !== 'string') throw new Error('请填写对话名称。');
    const title = value.replace(/\s+/g, ' ').trim();
    if (!title || [...title].length > 40) throw new Error('对话名称应为1–40个字。');
    this.conversationMetadata.set(key, { title, createdAt: this.conversationMetadata.get(key)?.createdAt || this.list(key)[0]?.createdAt || this.now() });
    return this.generalConversations(actorId).find(item => item.conversationId === conversationId)!;
  }

  deleteGeneralConversation(actorId: string, conversationId: string) {
    const key = this.generalKey(actorId, conversationId);
    this.messages.delete(key);
    this.conversationMetadata.delete(key);
    // The legacy empty ID must stay invalid after deletion, including after restart.
    if (!conversationId) this.conversationMetadata.set(key, { createdAt: this.now(), deleted: true });
    if (!this.generalConversations(actorId).length) this.createGeneralConversation(actorId);
    return { deleted: true, conversationId, conversations: this.generalConversations(actorId) };
  }

  generalConversations(actorId: string) {
    const root = `agent-general-${actorId}`;
    const keys = [...(this.conversationMetadata.get(root)?.deleted ? [] : [root]), ...[...this.messages.keys()].filter(key => key.startsWith(root + ':'))];
    return keys.map((key, index) => {
      const messages = this.list(key);
      const metadata = this.conversationMetadata.get(key);
      const first = messages.find(m => m.role === 'user')?.text || '';
      const subject = first.split(/[。！？!?\n]/, 1)[0].replace(/^(?:请|帮我|麻烦你)\s*/, '').trim();
      const createdAt = metadata?.createdAt || messages[0]?.createdAt || '';
      const latest = messages.at(-1);
      return { conversationId: key === root ? '' : key.slice(root.length + 1),
        number: index + 1, title: metadata?.title || [...subject].slice(0, 24).join('') || (key === root ? '最初的对话' : `新对话 ${index + 1}`),
        customTitle: Boolean(metadata?.title), preview: latest?.text.replace(/\s+/g, ' ').slice(0, 100) || '还没有消息，开始聊聊这次旅程',
        messageCount: messages.length, createdAt, updatedAt: latest?.createdAt || createdAt };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
  }

  serializeConversationMetadata(): string { return JSON.stringify([...this.conversationMetadata]); }
  loadConversationMetadata(value: string): void {
    const entries = JSON.parse(value) as Array<[string, { title?: string; createdAt: string; deleted?: boolean }]>;
    if (!Array.isArray(entries)) throw new Error('对话名称缓存格式错误');
    this.conversationMetadata.clear();
    for (const [key, metadata] of entries) this.conversationMetadata.set(key, metadata);
  }

  findGeneralMessage(actorId: string, messageId: string): MessageRecord | undefined {
    return this.generalConversations(actorId).flatMap(c => this.generalList(actorId, c.conversationId)).find(m => m.messageId === messageId);
  }

  handleGeneral(input: { actorId: string; text: string; conversationId?: string; clientMessageId?: string; images?: MessageRecord['images'] }): { userMessage: MessageRecord; assistantMessage: MessageRecord } {
    const key = this.generalKey(input.actorId, input.conversationId);
    const userMessage = this.build({
      tripId: key, role: 'user', text: input.text,
      createdAt: this.now(), clientMessageId: input.clientMessageId ?? null,
    });
    const assistantMessage = this.build({ tripId: key, role: 'assistant', text: '正在思考……', createdAt: this.now() });
    if (input.images?.length) userMessage.images = structuredClone(input.images);
    return { userMessage, assistantMessage };
  }

  generalList(actorId: string, conversationId = ''): MessageRecord[] {
    return this.list(this.generalKey(actorId, conversationId));
  }

  /** 对话记录随 StateStore 一起恢复；否则重启后旅行还在、聊天记录却消失。 */
  serialize(): string {
    return JSON.stringify([...this.messages.entries()]);
  }

  loadSerialized(serialized: string): void {
    const entries = JSON.parse(serialized) as Array<[string, MessageRecord[]]>;
    this.messages.clear();
    for (const [tripId, list] of entries) this.messages.set(tripId, list);
  }

  async handle(input: {
    actorId: string;
    sessionId: string;
    tripId: string;
    text: string;
    clientMessageId?: string;
    proposalId?: string;
  }): Promise<ServiceResult<MessageReply>> {
    const trip = this.tripService.getTrip(input.actorId, input.tripId);
    if (!trip.ok) return trip;

    const now = this.now();
    const userMessage = this.build({
      tripId: input.tripId,
      role: 'user',
      text: input.text,
      createdAt: now,
      clientMessageId: input.clientMessageId,
    });

    const confirmation = parseConfirmationText(input.text);
    // “不要安排休息，请比较路线”是需求，不是拒绝整份提案。
    const explicitRejection = /^(?:不要|不用|拒绝|取消|算了|不采用|不应用|换一个|都不好)(?:(?:应用|采用)?(?:这个|该|当前|第[一二三四五六七八九十\d]+个)?(?:方案|提案)?)?[。！!\s]*$/.test(input.text.trim());
    if (confirmation.kind === 'approve' || (confirmation.kind === 'reject' && explicitRejection)) {
      const resolved = this.tripService.confirmFromText({
        actorId: input.actorId,
        sessionId: input.sessionId,
        tripId: input.tripId,
        text: input.text,
        proposalId: input.proposalId,
        now,
      });
      if (!resolved.ok) {
        const assistantMessage = this.build({
          tripId: input.tripId,
          role: 'assistant',
          text: resolved.error?.message ?? '需要更明确的确认。',
          createdAt: now,
        });
        return {
          ok: true,
          value: {
            userMessage,
            assistantMessage,
            status: confirmation.kind === 'reject' ? 'rejected' : 'needs_clarification',
          },
        };
      }
      const assistantMessage = this.build({
        tripId: input.tripId,
        role: 'assistant',
        text: confirmation.kind === 'reject' ? '已拒绝该方案，当前行程未修改。' : '已收到具体许可，等待统一命令执行。',
        createdAt: now,
        actionRequestId: resolved.value?.actionRequestId ?? null,
      });
      return {
        ok: true,
        value: {
          userMessage,
          assistantMessage,
          status: confirmation.kind === 'reject' ? 'rejected' : 'authorized',
          actionRequest: resolved.value ?? undefined,
        },
      };
    }

    const direct = parseDirectCommand(input.text);
    if (direct?.kind === 'memory.create') {
      const created = this.tripService.createMemory(input.actorId, input.tripId, {
        userText: direct.text,
        sourceMessageIds: [userMessage.messageId],
      });
      const assistantMessage = this.build({
        tripId: input.tripId,
        role: 'assistant',
        text: created.ok ? '已按原文保存记录。' : created.error?.message ?? '保存失败。',
        createdAt: now,
      });
      return {
        ok: true,
        value: {
          userMessage,
          assistantMessage,
          status: created.ok ? 'recorded' : 'answered',
          ...(created.ok && created.value.memory ? { memory: { memoryId: created.value.memory.memoryId, userText: created.value.memory.userText } } : {}),
        },
      };
    }

    const assistantMessage = this.build({
      tripId: input.tripId,
      role: 'assistant',
      text: '当前未连接语言模型。这条消息已保存，但我暂时不能据此生成或调整方案；你可以手动编辑计划，或在「我的」里配置模型。',
      createdAt: now,
    });
    return {
      ok: true,
      value: { userMessage, assistantMessage, status: 'answered' },
    };
  }
}
