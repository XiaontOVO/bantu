import { createHash } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';

export interface PendingAgentDelete {
  kind: 'plan' | 'memory';
  id: string;
  fingerprint: string;
  prompt: string;
}

export function prepareAgentDelete(ctx: ServerContext, actorId: string, kind: PendingAgentDelete['kind'], id: string): PendingAgentDelete {
  const target = kind === 'plan' ? ctx.planLibrary.get(actorId, id) : ctx.personalMemoriesService.list(actorId).find(m => m.memoryId === id);
  if (!target) throw new Error('找不到这个对象，或它不属于当前账号。');
  const label = kind === 'plan' ? `方案/日计划「${'name' in target ? target.name : ''}」` : `旅行记忆「${'title' in target ? target.title : ''}」`;
  const impact = kind === 'plan' && 'executionEvents' in target && target.executionEvents?.length
    ? `，包括其中 ${target.executionEvents.length} 条进度记录` : '';
  return { kind, id, fingerprint: createHash('sha256').update(JSON.stringify(target)).digest('hex'),
    prompt: `将删除${label}${impact}。回复“确认删除”执行，或“取消”。` };
}

export function confirmAgentDelete(ctx: ServerContext, actorId: string, approval: PendingAgentDelete) {
  const current = prepareAgentDelete(ctx, actorId, approval.kind, approval.id);
  if (current.fingerprint !== approval.fingerprint) return { pending: { ...current, prompt: `内容已变化，请重新确认。\n${current.prompt}` }, reply: `内容已变化，请重新确认。\n${current.prompt}`, refresh: [] as string[] };
  if (approval.kind === 'plan') ctx.planLibrary.remove(actorId, approval.id);
  else {
    const result = ctx.personalMemoriesService.delete(actorId, approval.id);
    if (!result.ok) throw new Error(result.error.message);
  }
  return { deleted: true, reply: approval.kind === 'plan' ? '已删除所选方案/日计划。' : '已删除所选旅行记忆。', refresh: [approval.kind === 'plan' ? 'plans' : 'memories'] };
}
