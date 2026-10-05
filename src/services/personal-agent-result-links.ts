import type { ModelMessage } from '../providers/model.js';
import type { ServerContext } from '../server/http/context.js';

export interface AgentResultLink {
  view: 'home' | 'today' | 'plan' | 'places' | 'favorites' | 'memories' | 'community';
  label: string;
  date?: string;
  postId?: string;
  planId?: string;
  memoryId?: string;
}

export function agentPersonalResultLinks(ctx: ServerContext, actorId: string, messages: ModelMessage[]): AgentResultLink[] {
  const links = new Map<string, AgentResultLink>();
  const plans = ctx.planLibrary.list(actorId);
  const memories = ctx.personalMemoriesService.list(actorId);
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    try {
      const receipt = JSON.parse(message.content || '');
      if (!receipt.ok) continue;
      const value = receipt.result;
      if ((message.toolName?.startsWith('plans.') && !['plans.list', 'plans.versions', 'plans.delete'].includes(message.toolName)) || ['progress.record','progress.correct','community.import_share'].includes(message.toolName || '')) {
        const ids = message.toolName === 'plans.compare' && Array.isArray(value?.comparisons)
          ? value.comparisons.map((item: { planId?: unknown }) => item?.planId) : [value?.id];
        for (const id of ids) {
          const plan = plans.find(p => p.id === id);
          if (plan?.kind==='scheme') links.set(plan.id, { view: 'plan', label: `查看「${plan.name}」`, planId: plan.id });
          else if(plan?.kind==='plan')links.set(plan.id,{view:'home',label:'回到首页随行',planId:plan.id,date:plan.localDate});
          const journey=memories.find(memory=>memory.sourcePlanId===id);
          if(journey)links.set(journey.memoryId,{view:'memories',label:'查看这次旅行记录',memoryId:journey.memoryId});
        }
      }
      if (['memories.create', 'memories.edit'].includes(message.toolName || '')) {
        const memory = memories.find(m => m.memoryId === value?.memoryId);
        if (memory) links.set(memory.memoryId, { view: 'memories', label: `查看「${memory.title}」`, memoryId: memory.memoryId });
      }
    } catch { /* Ignore failed/legacy receipts, never use model-authored navigation. */ }
  }
  return [...links.values()].slice(-5);
}

/** Read IDs from server-produced successful receipts and recheck current public availability. */
export function agentPostResultLinks(ctx: ServerContext, actorId: string, messages: ModelMessage[]): AgentResultLink[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !['community.post_publish', 'community.post_visibility', 'community.post_detail'].includes(message.toolName || '')) continue;
    try {
      const receipt = JSON.parse(message.content || '');
      if (!receipt.ok) continue;
      const post = ['community.post_publish','community.post_visibility'].includes(message.toolName || '') ? receipt.result?.completed && receipt.result.result : receipt.result;
      if (typeof post?.id === 'string' && ctx.communityService.postDetail(post.id, actorId)) ids.add(post.id);
    } catch { /* A malformed or obsolete receipt must not invent a destination. */ }
  }
  return [...ids].slice(-3).map(postId => ({ view: 'community', label: '查看帖子', postId }));
}

/** Destinations come from committed service refreshes, never model-authored URLs. */
export function agentResultLinks(refresh: string[], date?: string, completedTools?: string[]): AgentResultLink[] {
  const links: AgentResultLink[] = [];
  if (refresh.includes('plans')) {
    links.push({ view: 'today', label: '查看计划', ...(/^\d{4}-\d{2}-\d{2}$/.test(date || '') ? { date } : {}) });
    if (!date) links.push({ view: 'plan', label: '方案候选' });
  }
  if (refresh.includes('places')) links.push({ view: 'places', label: '查看地点' });
  if (refresh.includes('favorites') && (!completedTools || completedTools.some(tool => tool === 'favorites.set' || tool === 'community.post_favorite' || tool === 'community.post_withdraw'))) links.push({ view: 'favorites', label: '查看收藏' });
  if (refresh.includes('memories')) links.push({ view: 'memories', label: '旅行记忆' });
  if (refresh.includes('community')) links.push({ view: 'community', label: '查看社区' });
  return links;
}
