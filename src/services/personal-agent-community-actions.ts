import { createHash } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';
import type { PendingAgentDelete } from './personal-agent-delete.js';
import { sharedJourneyMemory, normalizePostImages } from './community-service.js';

export type CommunityActionKind = 'post_publish' | 'post_visibility' | 'post_reply' | 'post_withdraw' | 'comment_delete' | 'share_publish' | 'share_withdraw' | 'place_review' | 'discovery_publish' | 'discovery_withdraw' | 'discovery_submit';
export interface PendingCommunityAction {
  actorId: string;
  kind: CommunityActionKind;
  data: { text?: string; postId?: string; visibility?: 'public' | 'private'; expectedVisibility?: 'public' | 'private'; parentCommentId?: string; commentId?: string; placeRefs?: Array<{ placeId: string; name: string }>; planId?: string; shareId?: string; dayNames?: string[][]; share?: { code: string; name: string; cityCode: string; cityLabel: string; stopCount: number } };
  placeReview?: { placeId: string; name: string; rating: number };
  discovery?: { name: string; cityCode: string; address: string; description: string; lat?: number; lng?: number; coordinateCrs?: 'WGS84' | 'GCJ02' | 'BD09' };
  discoveryId?: string;
  discoverySubmission?: { evidence: string; lat?: number; lng?: number; coordinateCrs?: 'WGS84' | 'GCJ02' | 'BD09' };
  fingerprint: string;
  memoryId?: string;
  images?: Array<{ dataUrl: string; alt: string }>;
  prompt: string;
}
export type PendingAgentAction = PendingAgentDelete | PendingCommunityAction;
export const isPersonalDelete = (a: PendingAgentAction): a is PendingAgentDelete => a.kind === 'plan' || a.kind === 'memory';
export function actionConfirmation(a: PendingAgentAction): string {
  if (a.kind === 'post_visibility') return '确认修改';
  if (a.kind === 'discovery_submit') return '确认提交';
  return isPersonalDelete(a) || a.kind === 'comment_delete' ? '确认删除' : a.kind === 'post_withdraw' || a.kind === 'share_withdraw' || a.kind === 'discovery_withdraw' ? '确认撤回' : '确认发布';
}
export function actionTool(a: PendingAgentAction): string {
  return isPersonalDelete(a) ? a.kind === 'plan' ? 'plans.delete' : 'memories.delete' : `community.${a.kind}`;
}

export function prepareCommunityAction(ctx: ServerContext, actorId: string, kind: CommunityActionKind, data: PendingCommunityAction['data'], memoryId?: string, images?: PendingCommunityAction['images'], placeReview?: PendingCommunityAction['placeReview'], discovery?: PendingCommunityAction['discovery'], discoveryId?: string, discoverySubmission?: PendingCommunityAction['discoverySubmission']): PendingCommunityAction {
  if (ctx.accounts.profile(actorId).kind !== 'account') throw new Error('请先登录账号，再使用社区写入功能。');
  const nickname = ctx.accounts.nicknameOf(actorId);
  const post = data.postId ? ctx.communityService.postDetail(data.postId, actorId) : undefined;
  if (['post_reply', 'post_visibility', 'post_withdraw', 'comment_delete'].includes(kind) && !post) throw new Error('帖子不存在或已撤回。');
  let context: unknown = null;
  let preview = '';
  if (kind === 'discovery_submit') {
    if (!discoverySubmission || !discoveryId) throw new Error('请补充推荐编号和收录依据。');
    if ((discoverySubmission.lat !== undefined || discoverySubmission.lng !== undefined) && !discoverySubmission.coordinateCrs) throw new Error('请明确坐标的来源坐标系。');
    const item = ctx.communityService.previewSubmission(discoveryId, actorId, discoverySubmission);
    context = { before: ctx.communityService.detail(discoveryId, actorId), discoverySubmission };
    preview = `将申请收录「${item.name}」\n位置：${item.address}\n坐标（WGS84）：${item.lat}, ${item.lng}\n核实依据：${item.evidence}\n\n提交后等待平台审核，通过后才会进入地点目录。`;
  } else if (kind === 'discovery_publish') {
    if (!discovery) throw new Error('请补充地点推荐内容。');
    if ((discovery.lat !== undefined || discovery.lng !== undefined) && !discovery.coordinateCrs) throw new Error('请明确坐标的来源坐标系。');
    const item = ctx.communityService.previewPublish(actorId, discovery, nickname);
    context = discovery;
    preview = `将以「${nickname}」保存地点推荐「${item.name}」\n城市代码：${item.cityCode}\n位置：${item.address}\n\n${item.description}\n\n${item.lat === null ? '暂未填写坐标。' : `坐标（WGS84）：${item.lat}, ${item.lng}`}\n保存后仅自己可见；申请收录并审核通过后，才会进入地点目录。`;
  } else if (kind === 'discovery_withdraw') {
    const item = ctx.communityService.ownDiscoveries(actorId).find(item => item.id === discoveryId);
    if (!item) throw new Error('只能撤回自己的地点推荐，请重新查询。');
    context = item;
    preview = `将撤回地点推荐「${item.name}」\n${item.address}\n\n撤回后推荐和评价不再展示；如已收录，该地点也会退出目录。`;
  } else if (kind === 'place_review') {
    if (!placeReview || !Number.isInteger(placeReview.rating) || placeReview.rating < 1 || placeReview.rating > 5) throw new Error('评分需在 1–5 星之间。');
    if (!data.text?.trim() || data.text.trim().length > 1000) throw new Error('评价需填写 1 至 1000 字。');
    data = { text: data.text.trim() };
    context = { placeReview, previous: ctx.communityService.ownPlaceReview(placeReview.placeId, actorId) };
    preview = `将以「${nickname}」评价「${placeReview.name}」：${placeReview.rating} 星\n\n${data.text}${ctx.communityService.ownPlaceReview(placeReview.placeId, actorId) ? '\n\n这将更新你之前的评价。' : ''}`;
  } else if (kind === 'share_publish') {
    if (!data.share || !data.planId) throw new Error('请先生成方案分享预览。');
    const plan = ctx.planLibrary.get(actorId, data.planId);
    context = plan;
    const days = plan.kind === 'scheme' ? plan.days || [] : [{ stops: plan.stops }];
    preview = `将以「${nickname}」分享「${data.share.name}」，共 ${days.length} 天、${data.share.stopCount} 个地点。\n` + (data.dayNames || []).map((names, index) => `第 ${index + 1} 天：${names.join(' → ') || '待安排'}`).join('\n');
  } else if (kind === 'share_withdraw') {
    const share = ctx.communityService.listPlanShares(actorId).find(s => s.id === data.shareId);
    if (!share || !share.mine) throw new Error('只能撤回自己发布的方案分享。');
    context = share;
    preview = `将撤回方案分享「${share.name}」（${share.shareCode}）。撤回后其他人无法再查找或导入，已经导入的副本不受影响。`;
  } else if (kind === 'post_visibility') {
    if (!post!.mine) throw new Error('只能修改自己帖子的可见范围。');
    if (data.visibility !== 'public' && data.visibility !== 'private') throw new Error('请选择公开或仅自己可见。');
    if (data.expectedVisibility !== 'public' && data.expectedVisibility !== 'private') throw new Error('请先读取帖子的当前可见范围。');
    if (post!.visibility !== data.expectedVisibility) throw new Error('帖子可见范围已有更新，请重新读取并生成确认预览。');
    context = {id:post!.id,text:post!.text,visibility:post!.visibility};
    const label = (visibility: string) => visibility === 'private' ? '仅自己可见' : '公开';
    preview = `将修改你的帖子「${post!.text.split('\n')[0]}」\n当前可见范围：${label(post!.visibility)}\n修改后：${label(data.visibility)}${data.visibility === 'private' ? '\n其他人将无法查看正文、照片和评论，其收藏快照也会移除。' : '\n公开后，其他人可以查看正文、照片和评论。'}\n正文、照片和原评论会保留。`;
  } else if (kind === 'post_publish' || kind === 'post_reply') {
    const content = data.text?.trim();
    if (!content || content.length > (kind === 'post_publish' ? 10000 : 1000)) throw new Error('发布内容为空或超过字数限制。');
    data = { ...data, text: content };
    if (kind === 'post_publish') {
      if (data.visibility !== undefined && data.visibility !== 'public' && data.visibility !== 'private') throw new Error('请选择公开或仅自己可见。');
      data.visibility = data.visibility === 'private' ? 'private' : 'public';
    }
    const parent = data.parentCommentId ? post?.comments.find(c => c.id === data.parentCommentId) : undefined;
    if (data.parentCommentId && (!parent || parent.deleted)) throw new Error('要回复的评论不存在或已删除。');
    context = post ? { id: post.id, text: post.text, nickname: post.nickname, parent } : null;
    const [title, ...bodyLines] = content.split('\n');
    preview = kind === 'post_publish' ? `将以「${nickname}」发布帖子：\n可见范围：${data.visibility === 'private' ? '仅自己可见（不会公开）' : '公开（其他人可查看）'}\n\n标题：${title}\n正文：\n${bodyLines.join('\n') || '（无正文）'}${data.placeRefs?.length ? `\n\n关联地点：${data.placeRefs.map(p => p.name).join('、')}` : ''}`
      : `将以「${nickname}」回复${parent ? `「${parent.nickname}」的评论：${parent.text}` : `「${post!.nickname}」的帖子：${post!.text.slice(0, 120)}`}\n\n${content}`;
  } else if (kind === 'post_withdraw') {
    if (!post!.mine) throw new Error('只能撤回自己发布的帖子。');
    context = post;
    preview = `将撤回你的帖子：\n\n${post!.text}\n\n其中有 ${post!.commentCount} 条评论。撤回后其他人无法查看。`;
  } else {
    const comment = post!.comments.find(c => c.id === data.commentId);
    if (!comment || !comment.mine || comment.deleted) throw new Error('只能删除自己尚未删除的评论。');
    context = { comment, replies: post!.comments.filter(c => c.parentCommentId === comment.id) };
    preview = `将删除你的评论：\n\n${comment.text}\n\n其他人的楼中回复会保留。`;
  }
  if (memoryId) {
    if (kind !== 'post_publish') throw new Error('只有帖子可以附上旅行记忆。');
    const memory = ctx.personalMemoriesService.list(actorId).find(m => m.memoryId === memoryId);
    if (!memory?.journey) throw new Error('找不到你的旅行足迹记忆，请重新选择。');
    const journey = sharedJourneyMemory({ ...memory.journey, currentCity: '', places: memory.journey.places.map(p => ({ name: p.name, visitMinutes: p.visitMinutes ?? null })) })!;
    context = { context, memory };
    preview += `\n\n附上旅行记忆「${memory.title}」：${journey.localDate}\n${journey.places.map(p => `${p.name}${p.visitMinutes === null ? '' : `（${p.visitMinutes} 分钟）`}`).join(' → ')}${journey.elapsedMinutes === null ? '' : `\n记录跨度：${journey.elapsedMinutes} 分钟`}`;
  }
  if (images?.length) {
    if (kind !== 'post_publish') throw new Error('只有帖子可以附照片。');
    normalizePostImages(images);
    preview += `\n\n照片（${images.length} 张）：${images.map((image, index) => `${index + 1}. ${image.alt}`).join('；')}`;
  }
  const pending: PendingCommunityAction = { actorId, kind, data: structuredClone(data), ...(memoryId ? { memoryId } : {}), ...(images?.length ? { images: structuredClone(images) } : {}), fingerprint: createHash('sha256').update(JSON.stringify({ actorId, kind, data, context, nickname, images: images?.length ? images : undefined })).digest('hex'), prompt: '' };
  pending.prompt = `${preview}\n\n回复“${actionConfirmation(pending)}”执行，或“取消”。`;
  if (placeReview) pending.placeReview = structuredClone(placeReview);
  if (discovery) pending.discovery = structuredClone(discovery);
  if (discoveryId) pending.discoveryId = discoveryId;
  if (discoverySubmission) pending.discoverySubmission = structuredClone(discoverySubmission);
  return pending;
}

/** Re-resolve review targets at confirmation; never publish against a removed directory entry. */
export async function confirmCommunityActionWithDirectory(ctx: ServerContext, actorId: string, approval: PendingCommunityAction, conversationId = '') {
  if (approval.actorId !== actorId) throw new Error('不能确认其他账号的操作。');
  if (approval.kind === 'place_review') {
    const place = await (ctx.options.placeProvider || ctx.fallbackPlaceProvider).detail(approval.placeReview?.placeId || '');
    if (!place) throw new Error('地点已不存在，评价未发布。');
    approval = { ...approval, placeReview: { ...approval.placeReview!, name: place.name } };
  }
  if (ctx.personalAgentTasks.current(actorId,conversationId)?.cancelRequested) throw new Error('操作已停止，尚未发布。');
  return confirmCommunityAction(ctx, actorId, approval);
}

export function confirmCommunityAction(ctx: ServerContext, actorId: string, approval: PendingCommunityAction) {
  if (approval.actorId !== actorId) throw new Error('不能确认其他账号的操作。');
  if (approval.kind === 'post_publish' && approval.data.visibility === undefined) throw new Error('旧发布预览未包含可见范围，请重新生成预览后确认；帖子尚未发布。');
  const current = prepareCommunityAction(ctx, actorId, approval.kind, approval.data, approval.memoryId, approval.images, approval.placeReview, approval.discovery, approval.discoveryId, approval.discoverySubmission);
  if (current.fingerprint !== approval.fingerprint) {
    if (approval.kind === 'share_publish') throw new Error('方案或发布昵称已有更新，请重新生成分享预览后确认。');
    current.prompt = `内容已变化，请重新确认。\n${current.prompt}`;
    return { pending: current, completed: false, reply: current.prompt, refresh: [] as string[] };
  }
  const data = approval.data;
  const nickname = ctx.accounts.nicknameOf(actorId);
  let result: unknown;
  if (approval.kind === 'discovery_submit') {
    result = ctx.communityService.submit(approval.discoveryId!, actorId, approval.discoverySubmission!);
    return { completed: true, result, reply: '收录申请已提交，正在等待审核，尚未进入地点目录。', refresh: ['community', 'places'] };
  }
  if (approval.kind === 'discovery_publish') {
    result = ctx.communityService.publish(actorId, approval.discovery!, nickname);
    return { completed: true, result, reply: '地点推荐已保存，仅自己可见；尚未申请收录，也未进入地点目录。', refresh: ['community', 'places'] };
  }
  if (approval.kind === 'discovery_withdraw') {
    result = ctx.communityService.remove(approval.discoveryId!, actorId);
    return { completed: true, result, reply: '地点推荐已撤回。', refresh: ['community', 'places', 'favorites'] };
  }
  if (approval.kind === 'place_review') {
    const review = ctx.communityService.reviewPlace(approval.placeReview!.placeId, actorId, { text: data.text, rating: approval.placeReview!.rating }, nickname);
    const { actorId: _actorId, ...visible } = review;
    return { completed: true, result: visible, reply: '地点评价已发布。', refresh: ['places', 'community'] };
  }
  if (approval.kind === 'post_visibility') {
    const post = ctx.communityService.updatePostVisibility(actorId,data.postId!,data.visibility);
    if (post.visibility === 'private') ctx.favoritesService.removePostForOthers(post.id,actorId);
    return {completed:true,result:post,reply:`帖子已设为${post.visibility === 'private' ? '仅自己可见' : '公开'}。`,refresh:['community','favorites']};
  }
  if (approval.kind === 'share_publish') result = ctx.communityService.publishPlanShare(actorId, { ...data.share, nickname });
  else if (approval.kind === 'share_withdraw') result = ctx.communityService.removePlanShare(actorId, data.shareId!);
  else if (approval.kind === 'post_publish') {
    const memory = approval.memoryId ? ctx.personalMemoriesService.list(actorId).find(m => m.memoryId === approval.memoryId) : undefined;
    const journeyMemory = memory?.journey ? sharedJourneyMemory({ ...memory.journey, currentCity: '', places: memory.journey.places.map(p => ({ name: p.name, visitMinutes: p.visitMinutes ?? null })) }) : undefined;
    result = ctx.communityService.publishPost(actorId, { ...data, journeyMemory, images: approval.images }, nickname);
  }
  else if (approval.kind === 'post_reply') result = ctx.communityService.addComment(actorId, data.postId!, data, nickname);
  else if (approval.kind === 'post_withdraw') {
    result = ctx.communityService.removePost(actorId, data.postId!);
    ctx.favoritesService.markPostWithdrawn(data.postId!);
  } else result = ctx.communityService.removeComment(actorId, data.postId!, data.commentId!);
  const reply = approval.kind === 'share_publish' ? `方案已分享，方案码：${(result as { shareCode: string }).shareCode}。`
    : approval.kind === 'share_withdraw' ? '方案分享已撤回。'
    : approval.kind === 'post_publish' ? data.visibility === 'private' ? '帖子已发布，仅自己可见。' : '帖子已发布，所有人可见。' : approval.kind === 'post_reply' ? '回复已发布。' : approval.kind === 'post_withdraw' ? '帖子已撤回。' : '评论已删除。';
  return { completed: true, result, reply, refresh: ['community', 'favorites'] };
}
