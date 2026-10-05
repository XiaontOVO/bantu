import type { ServerContext } from '../server/http/context.js';
import { projectAgentPlanResult } from './personal-agent-plan-result.js';

/** A duplicate write is not executed again, but its old snapshot is not current truth. */
export function replayAgentWrite(ctx: ServerContext, actorId: string, tool: string, cached: unknown, args: Record<string, unknown> = {}): unknown {
  const receipt = cached as { ok?: boolean; result?: any };
  if (!receipt?.ok) return cached;
  const value = receipt.result;
  const missing = { ok: false, replayed: true, error: '这一步曾执行成功，但对应内容已不存在。没有重复执行，请重新读取当前内容后再处理。' };
  if (tool === 'community.import_share') {
    const plan = ctx.planLibrary.list(actorId).find(plan => plan.id === value?.id);
    return plan ? { ...receipt, replayed: true, result: plan } : missing;
  }
  if (tool.startsWith('community.') && value?.completed === true) {
    const saved = value.result;
    const current = (result: unknown) => ({ ...receipt, replayed: true, result: { completed: true, result, reply: '已核对当前状态，没有重复执行。', refresh: [] } });
    if (['community.post_publish', 'community.post_visibility', 'community.post_reply', 'community.comment_delete'].includes(tool)) {
      const post = ctx.communityService.postDetail(saved?.id, actorId);
      if (!post || (['community.post_publish','community.post_visibility'].includes(tool) && !post.mine)) return missing;
      return current(post);
    }
    if (['community.discovery_publish', 'community.discovery_submit'].includes(tool)) {
      const discovery = ctx.communityService.ownDiscoveries(actorId).find(item => item.id === saved?.id);
      return discovery ? current(discovery) : missing;
    }
    if (tool === 'community.share_publish') {
      const share = ctx.communityService.listPlanShares(actorId).find(item => item.id === saved?.id && item.mine);
      return share ? current(share) : missing;
    }
    if (tool === 'community.place_review') {
      const review = ctx.communityService.ownPlaceReview(String(args.placeId || ''), actorId);
      return review ? current(review) : missing;
    }
  }
  if (tool.startsWith('plans.') || tool.startsWith('progress.')) {
    const references = value?.id && ['plan', 'scheme'].includes(value.kind) ? [value.id]
      : tool === 'plans.load' && Array.isArray(value?.plans) ? value.plans.map((plan: any) => plan.id) : [];
    const plans = references.length ? ctx.planLibrary.list(actorId) : [];
    if (references.some((id: string) => !plans.some(plan => plan.id === id))) return missing;
    return { ...receipt, replayed: true, result: projectAgentPlanResult(ctx, actorId, tool, value) };
  }
  if (['memories.create', 'memories.edit'].includes(tool) && value?.memoryId) {
    const memory = ctx.personalMemoriesService.list(actorId).find(item => item.memoryId === value.memoryId);
    return memory ? { ...receipt, replayed: true, result: memory } : missing;
  }
  return { ...receipt, replayed: true };
}
