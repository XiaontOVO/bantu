/** 首页临时变化由模型调用工具托管；保留旧消息的手动候选入口。 */
import { state } from './store.js';
import { closeSheet, toast } from './ui.js';
import { escapeHtml } from './format.js';
import { companionTarget } from './day-plan-selection.js';
import { companionMode } from '../views/companion.js';
import { navigate } from './render.js';
import { sendChat } from './commands.js';

const labels = { rest: '我想休息一下', rain: '下雨了，帮我看看避雨的安排', time: '时间不够了，帮我调整后续安排', replace: '我想换个地方，帮我调整下一站' };
const messageFor = id => state.messages.find(message => message.messageId === id && message.companionAdjustment);

/** 参数追问也可直接在聊天框回答，普通对话不绑定到旧调整。 */
export function companionRequestForText(text) {
  const source = [...state.messages].reverse().find(message => message.role === 'assistant');
  if (source?.companionDelegation?.status === 'needs_input' && source.messageId) {
    const cancel = /^(?:取消(?:调整)?|保留原安排|先不调整)[。！!]?\s*$/.test(text.trim());
    return { action: cancel ? 'cancel_delegate' : 'delegate', sourceMessageId: source.messageId };
  }
  if (!source?.companionAdjustment || !source.messageId) return undefined;
  if (['needs_input', 'preview', 'unavailable'].includes(source.companionAdjustment.status) && /^(?:取消(?:调整)?|保留原安排|先不调整)[。！!]?\s*$/.test(text.trim())) return { action: 'cancel', sourceMessageId: source.messageId };
  if (source.companionAdjustment.status === 'preview' && /^确认(?:采用|应用)/.test(text.trim())) {
    const candidates = source.companionAdjustment.candidates || [];
    const index = text.match(/第\s*([1-3一二三])/);
    const number = index ? Number(index[1]) || ({ 一: 1, 二: 2, 三: 3 })[index[1]] : 0;
    const candidate = number ? candidates[number - 1] : candidates.find(item => text.includes(item.title)) || (candidates.length === 1 ? candidates[0] : null);
    return candidate ? { action: 'apply', sourceMessageId: source.messageId, previewId: candidate.previewId } : undefined;
  }
  if (source.companionAdjustment.status !== 'needs_input') return undefined;
  const request = { action: 'preview', sourceMessageId: source.messageId };
  if (source.companionAdjustment.change === 'rest') {
    const minutes = text.match(/(\d{1,3})\s*分钟/), hours = text.match(/(\d{1,2})\s*小时/);
    if (!minutes && !hours && !/半小时/.test(text)) return undefined;
    request.minutes = minutes ? Number(minutes[1]) : hours ? Number(hours[1]) * 60 : 30;
  } else {
    const time = text.match(/(\d{1,2})[:：](\d{2})/);
    if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return undefined;
    request.deadlineMinutes = Number(time[1]) * 60 + Number(time[2]);
  }
  return request;
}

export async function openCompanionChange(change) {
  if (state.chatPending || state.chatImagesBusy || state.executionPending) { toast('当前操作正在处理，请稍后再调整。'); return; }
  const { plan, next, canExecute } = companionTarget(state.savedPlans, state.companionPlanId);
  if (!plan || !next || !canExecute || !labels[change]) return;
  closeSheet();
  navigate('agent');
  await sendChat(`${labels[change]}。请结合「${plan.name}」的当前进度，${change === 'rest' ? '先在原地休息30分钟，顺延弹性安排；不必强制查询定位或道路' : '查询地点和实际路线，自动调整尚未开始的安排'}，并告诉我改了什么；保留已有进度、预约和必留安排。`, {
    images: [], companionRequest: { action: 'delegate', planId: plan.id, expectedRevision: plan.revision || 0, stopId: next.stopId, change, transportMode: companionMode(plan, next) },
  });
}

export async function queryCompanionAdvice(button) {
  if (state.chatPending) return;
  const source = messageFor(button?.dataset.message);
  if (source?.companionAdjustment?.status !== 'needs_input') return;
  const form = button.closest('.agent-companion-card');
  const request = { action: 'preview', sourceMessageId: source.messageId };
  let text;
  if (source.companionAdjustment.change === 'rest') {
    request.minutes = Number(form.querySelector('#companionRestMinutes')?.value);
    text = `想休息 ${request.minutes} 分钟，请核对后续安排。`;
  } else {
    const value = form.querySelector('#companionDeadline')?.value || '';
    if (!/^\d{2}:\d{2}$/.test(value)) { toast('先选择今天希望结束的时间。', 'error'); return; }
    const [hour, minute] = value.split(':').map(Number);
    request.deadlineMinutes = hour * 60 + minute;
    text = `今天希望 ${value} 前结束，请核对哪些安排可以调整。`;
  }
  await sendChat(text, { images: [], companionRequest: request });
}

export async function applyCompanionAdvice(previewId, sourceMessageId) {
  if (state.chatPending) return;
  const source = messageFor(sourceMessageId), adjustment = source?.companionAdjustment;
  const candidate = adjustment?.candidates?.find(item => item.previewId === previewId);
  if (!candidate || adjustment.status !== 'preview') return;
  await sendChat(`确认采用「${candidate.title}」，保留已有进度与受保护安排。`, {
    images: [], clientMessageId: `apply_${sourceMessageId}_${previewId}`, companionRequest: { action: 'apply', sourceMessageId, previewId },
  });
}

export async function cancelCompanionChange(button) {
  if (state.chatPending) return;
  const delegated = state.messages.find(message => message.messageId === button?.dataset.message && message.companionDelegation?.status === 'needs_input');
  if (delegated) {
    await sendChat('保留原安排，先不调整。', { images: [], companionRequest: { action: 'cancel_delegate', sourceMessageId: delegated.messageId } });
    return;
  }
  const source = messageFor(button?.dataset.message);
  if (!source) return;
  await sendChat('保留原安排，先不调整。', { images: [], companionRequest: { action: 'cancel', sourceMessageId: source.messageId } });
  if (state.messages.at(-1)?.companionAdjustment?.status === 'cancelled') navigate('home');
}

export function renderAgentCompanionAdjustment(message) {
  if (message.companionDelegation && message.messageId) {
    const last = [...state.messages].reverse().find(item => item.role === 'assistant');
    if (last !== message) return '';
    const status = message.companionDelegation.status;
    const label = status === 'applied' ? '已自动调整后续安排' : status === 'unchanged' ? '已保留原安排' : status === 'needs_input' ? '补充信息后继续自动调整' : status === 'cancelled' ? '已保留原安排' : '本次尚未完成调整';
    const outcome = message.companionDelegation.outcome;
    const changes = outcome ? `<div class="companion-change-list">${outcome.changes.map(item => `<div><strong>${escapeHtml(item.name)}</strong><p><span>原安排</span>${escapeHtml(item.before)}</p><p><span>调整后</span>${escapeHtml(item.after)}</p></div>`).join('')}</div>` : '';
    const cancel = status === 'needs_input' ? `<button class="btn-soft" data-action="cancel-companion-change" data-message="${escapeHtml(message.messageId)}" ${state.chatPending ? 'disabled' : ''}>取消调整</button>` : '';
    return `<section class="agent-companion-card"><p class="stop-meta" role="status">${label}</p>${changes}<div class="stop-actions agent-companion-return">${cancel}<button class="btn-soft" data-action="open-companion" data-plan="${escapeHtml(message.companionDelegation.planId)}">回首页随行</button></div></section>`;
  }
  const adjustment = message.companionAdjustment;
  if (!adjustment || !message.messageId) return '';
  const last = state.messages.filter(item => item.companionAdjustment).at(-1);
  const currentPlan = state.savedPlans.find(plan => plan.id === adjustment.planId);
  const active = last === message && !state.chatPending && ['needs_input', 'preview', 'unavailable'].includes(adjustment.status);
  const stale = !currentPlan || (currentPlan.revision || 0) !== adjustment.expectedRevision;
  const attributes = `data-message="${escapeHtml(message.messageId)}"`;
  const cancel = `<button class="btn-soft" data-action="cancel-companion-change" ${attributes} ${!active ? 'disabled' : ''}>保留原安排</button>`;
  const back = `<button class="btn-soft" data-action="open-companion" data-plan="${escapeHtml(adjustment.planId)}">回首页随行</button>`;
  if (['applied', 'cancelled', 'superseded'].includes(adjustment.status)) return last === message ? `<div class="stop-actions agent-companion-return">${back}</div>` : '';
  if (adjustment.status === 'needs_input' && last === message) {
    const input = adjustment.change === 'rest'
      ? '<label class="field">想休息多久<select id="companionRestMinutes"><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></label>'
      : '<label class="field">今天最迟几点结束<input id="companionDeadline" type="time" required aria-label="今天最迟几点结束"></label>';
    return `<section class="agent-companion-card" aria-label="补充调整需求"><p class="stop-meta">${escapeHtml(adjustment.planName)} · ${escapeHtml(adjustment.localDate)}</p><div class="companion-change-form">${input}</div><div class="stop-actions"><button class="btn-primary" data-action="query-companion-advice" ${attributes} ${!active || stale ? 'disabled' : ''}>让伴途核对安排</button>${cancel}</div>${stale ? '<p role="status">行程已变化，请回首页重新发起。</p>' : ''}</section>`;
  }
  if (last !== message) return '';
  return `<section class="agent-companion-card" aria-label="伴途调整建议"><p class="stop-meta">${escapeHtml(adjustment.planName)} · ${escapeHtml(adjustment.localDate)}</p>${(adjustment.candidates || []).map(candidate => {
    const expired = !Number.isFinite(Date.parse(candidate.expiresAt)) || Date.now() >= Date.parse(candidate.expiresAt);
    return `<section class="companion-advice-card"><h4>${escapeHtml(candidate.title)}</h4><dl class="companion-advice-impact"><div><dt>结束时间</dt><dd><span>${escapeHtml(candidate.impact.endBefore)}</span> → <strong>${escapeHtml(candidate.impact.endAfter)}</strong></dd></div><div><dt>道路时间</dt><dd><span>${candidate.impact.roadMinutesBefore == null ? '原安排未知' : `原约 ${escapeHtml(candidate.impact.roadMinutesBefore)} 分钟`}</span> → <strong>约 ${escapeHtml(candidate.impact.roadMinutesAfter)} 分钟</strong></dd></div></dl><p class="companion-notice">保护 ${escapeHtml(candidate.impact.protectedStops)} 个后续安排。${escapeHtml(candidate.impact.fees)}</p><div class="companion-change-list">${candidate.changes.map(item => `<div><strong>${escapeHtml(item.name)}</strong><p><span>原安排</span>${escapeHtml(item.before)}</p><p><span>调整后</span>${escapeHtml(item.after)}</p></div>`).join('')}</div><ul class="companion-advice-warnings">${candidate.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul><p class="stop-meta">${expired ? '建议已过期，请回首页重新核对。' : stale ? '行程已变化，请回首页重新核对。' : '确认时会再次核对行程、进度和位置。'}</p><button class="btn-primary" data-action="apply-companion-advice" data-preview="${escapeHtml(candidate.previewId)}" ${attributes} ${!active || stale || expired ? 'disabled' : ''}>确认采用这份调整</button></section>`;
  }).join('')}${adjustment.reasons?.length ? `<div class="companion-notice">${adjustment.reasons.map(reason => `<p>${escapeHtml(reason)}</p>`).join('')}</div>` : ''}<div class="stop-actions">${cancel}${back}</div></section>`;
}
