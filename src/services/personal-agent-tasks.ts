import { randomUUID } from 'node:crypto';
import type { ModelMessage } from '../providers/model.js';

export interface PersonalAgentTask {
  id: string;
  actorId: string;
  conversationId?: string;
  status: 'running' | 'interrupted' | 'completed';
  /** A terminal checkpoint ends processing, without claiming all requested work succeeded. */
  terminalReason?: 'context_limit' | 'budget_exhausted';
  messages: ModelMessage[];
  /** The actual instruction that started this task, excluding earlier chat history. */
  requestText?: string;
  writes: Record<string, unknown>;
  images?: Array<{ dataUrl: string; alt: string }>;
  location?: import('./personal-agent-location.js').AgentLocation;
  companionDelegation?: import('./personal-agent-delegation.js').CompanionDelegation;
  refresh: string[];
  date?: string;
  modelCalls: number;
  maxOutputTokens?: number;
  toolCalls: number;
  cancelRequested?: boolean;
  pendingLoad?: { schemeId: string; startDate: string; fingerprint: string; prompt: string };
  pendingLoadCall?: { callId: string; key: string };
  pendingAction?: import('./personal-agent-community-actions.js').PendingAgentAction;
  pendingActionCall?: { callId: string; key: string };
}

/** Checkpoints are committed in the same application snapshot as business writes. */
export class PersonalAgentTasks {
  private tasks: PersonalAgentTask[] = [];
  /** Live cancellation listeners never enter the persisted checkpoint. */
  private readonly cancelListeners = new Map<string, Set<() => void>>();
  onCancel(actorId: string, taskId: string, listener: () => void, conversationId = ''): () => void {
    const task = [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId);
    if (!task || task.id !== taskId) throw new Error('任务不存在或已经切换，请刷新任务状态。');
    if (task.cancelRequested) { listener(); return () => {}; }
    const listeners = this.cancelListeners.get(taskId) || new Set<() => void>();
    listeners.add(listener); this.cancelListeners.set(taskId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.cancelListeners.delete(taskId); };
  }
  current(actorId: string, conversationId = '') {
    const task = [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId);
    return task ? { id: task.id, status: task.status, cancelRequested: Boolean(task.cancelRequested), awaitingConfirmation: Boolean(task.pendingAction || task.pendingLoad), completedSteps: task.toolCalls, refresh: [...task.refresh], date: task.date } : null;
  }
  completedCheckpoint(actorId: string, conversationId = ''): PersonalAgentTask | undefined {
    const task=[...this.tasks].reverse().find(t=>t.actorId===actorId&&(t.conversationId||'')===conversationId);
    return task?.status==='completed'&&!task.pendingAction&&!task.pendingLoad?task:undefined;
  }
  cancel(actorId: string, taskId: string, conversationId = '') {
    const task = [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId);
    if (!task || task.id !== taskId) throw new Error('任务不存在或已经切换，请刷新任务状态。');
    task.cancelRequested = true;
    for (const listener of this.cancelListeners.get(task.id) || []) listener();
    this.cancelListeners.delete(task.id);
    delete task.pendingAction; delete task.pendingActionCall;
    delete task.pendingLoad; delete task.pendingLoadCall;
    if (task.status !== 'running') task.status = 'completed';
    return this.current(actorId, conversationId);
  }
  clearImages(actorId: string): void {
    for (const task of this.tasks.filter(t => t.actorId === actorId)) {
      task.images = [];
      if (task.pendingAction && 'images' in task.pendingAction && task.pendingAction.images?.length) {
        delete task.pendingAction; delete task.pendingActionCall;
      }
    }
  }
  deleteConversation(actorId: string, conversationId = ''): void {
    if (this.tasks.some(t => t.actorId === actorId && (t.conversationId || '') === conversationId && t.status === 'running')) {
      throw new Error('这段对话仍在处理任务，请先停止并等待任务结束。');
    }
    this.tasks = this.tasks.filter(t => t.actorId !== actorId || (t.conversationId || '') !== conversationId);
  }
  pendingAction(actorId: string, conversationId = ''): PersonalAgentTask | undefined {
    return [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId && t.pendingAction);
  }
  pendingLoad(actorId: string, conversationId = ''): PersonalAgentTask | undefined {
    return [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId && t.pendingLoad);
  }
  start(actorId: string, messages: ModelMessage[], conversationId = ''): PersonalAgentTask {
    if (this.tasks.some(t => t.actorId === actorId && t.status === 'running')) throw new Error('上一项任务仍在处理，请稍后继续。');
    const previous = [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId);
    const task: PersonalAgentTask = { id: randomUUID(), actorId, conversationId, status: 'running', messages, requestText:messages.filter(message=>message.role==='user').at(-1)?.content, writes: {}, refresh: [], modelCalls: 0, toolCalls: 0,
      ...(previous?.images ? { images: structuredClone(previous.images) } : {}) };
    this.tasks = this.tasks.filter(t => t.actorId !== actorId || (t.conversationId || '') !== conversationId || (t.status !== 'completed' && !t.pendingLoad && !t.pendingAction));
    this.tasks.push(task);
    return task;
  }
  resume(actorId: string, conversationId = ''): PersonalAgentTask | undefined {
    if (this.tasks.some(t => t.actorId === actorId && t.status === 'running')) throw new Error('上一项任务仍在处理，请稍后继续。');
    const latest = [...this.tasks].reverse().find(t => t.actorId === actorId && (t.conversationId || '') === conversationId);
    const task = latest?.status === 'interrupted' ? latest : undefined;
    if (task) task.status = 'running';
    return task;
  }
  serialize(): string { return JSON.stringify(this.tasks); }
  loadSerialized(value: string): void {
    const tasks = JSON.parse(value) as PersonalAgentTask[];
    if (!Array.isArray(tasks)) throw new Error('Agent 任务数据格式错误');
    this.tasks = tasks.map(task => ({ ...task, status: task.cancelRequested ? 'completed' : task.status === 'running' ? 'interrupted' : task.status }));
  }
}
