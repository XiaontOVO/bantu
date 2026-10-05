import { createHash } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';
import type { PersonalAgentTask } from './personal-agent-tasks.js';

type PendingLoad = NonNullable<PersonalAgentTask['pendingLoad']>;

function localToday(now: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const value = (key: string) => parts.find(p => p.type === key)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** The confirmation is bound to server-owned data, never to model-provided consent. */
export function loadAgentScheme(ctx: ServerContext, actorId: string, schemeId: string, requestedDate?: string, approval?: PendingLoad) {
  const scheme = ctx.planLibrary.get(actorId, schemeId);
  if (scheme.kind !== 'scheme' || !scheme.days?.length) throw new Error('请选择可复用方案，日计划不需要再次载入。');
  const startDate = requestedDate || localToday(ctx.now(), scheme.timezone || 'Asia/Shanghai');
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== startDate) throw new Error('起始日期无效。');
  if (startDate < localToday(ctx.now(), scheme.timezone || 'Asia/Shanghai')) throw new Error('不能载入到过去的日期。');
  const dates = scheme.days.map(day => new Date(startMs + day.dayIndex * 86400000).toISOString().slice(0, 10));
  const existing = ctx.planLibrary.list(actorId).filter(p => p.kind === 'plan' && (p.sourceSchemeId === schemeId || dates.includes(p.localDate || '')));
  const fingerprint = createHash('sha256').update(JSON.stringify({ scheme, existing, startDate })).digest('hex');
  const needsApproval = existing.length > 0;
  const staleApproval = Boolean(approval && (approval.fingerprint !== fingerprint || approval.schemeId !== schemeId || approval.startDate !== startDate));
  if ((needsApproval && !approval) || staleApproval) {
    const affected = existing.map(p => `「${p.name}」（${p.localDate}）`).join('、');
    const prompt = `${approval ? '计划已变化，需要重新确认。\n' : ''}载入「${scheme.name}」将从 ${startDate} 开始${affected ? `，覆盖 ${affected} 的待进行安排` : `，安排 ${dates.length} 天`}。已有执行记录会保留，时间冲突的新安排会顺延。回复“确认载入”继续，或“取消”。`;
    return { pending: { schemeId, startDate, fingerprint, prompt }, reply: prompt };
  }
  // This synchronous read/validate/write block cannot interleave with another request.
  let result = ctx.planLibrary.loadAsPlans(actorId, schemeId, startDate);
  if ((result.conflict || result.progressConflict) && needsApproval && approval?.fingerprint === fingerprint) {
    result = ctx.planLibrary.loadAsPlans(actorId, schemeId, startDate, true, { stops: [], confirmed: true, confirmationToken: result.confirmationToken });
  }
  if (!result.plans) throw new Error('方案未载入，请重新读取计划后再试。');
  return { plans: result.plans, date: result.plans[0]?.localDate, reply: `已将「${scheme.name}」载入为 ${result.plans.length} 天计划，从 ${startDate} 开始。` };
}
