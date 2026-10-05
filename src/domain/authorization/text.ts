/**
 * 把用户的中文表达解析成许可意图。
 *
 * 两条**安全边界**都在这里：
 * - `parseConfirmationText` 只认整句确认；否定、假设、引用（"如果…就…"）一律不授权，
 *   因为它们表达的是条件而非同意。
 * - `resolveDisplayedAction` 只在"已展示且唯一"时解析出目标；没有展示过的动作，
 *   说"可以"也不构成许可。
 *
 * 模型可以影响文案，但不能绕过这里——服务端校验不依赖模型自觉。
 */

export type ConfirmationKind = 'approve' | 'reject' | 'ambiguous' | 'none' | 'denied';

export interface ConfirmationDecision {
  kind: ConfirmationKind;
  /** 仅 approve 且文本明确指向第 N 个候选时有值（1-based）。 */
  candidateIndex?: number;
  reason?: string;
}

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.!！?？;；:：'"“”‘’（）()]/g, '')
    .toLowerCase();
}

function parseCandidateIndex(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value >= 1 && value <= 10 ? value : null;
  }
  return CHINESE_NUMBERS[token] ?? null;
}

/**
 * docs/07 §5.3 的确定性边界：
 * 只接受整句匹配，禁止搜索文本里是否含有“确认”二字。
 * 假设、否定、引用和其他人的话均不授予许可。
 */
export function parseConfirmationText(text: string): ConfirmationDecision {
  const raw = text.trim();
  if (!raw) return { kind: 'none' };
  if (/[“”"]/.test(raw) && /确认|采用|应用|同意/.test(raw)) {
    return { kind: 'denied', reason: '引用文本不能授权。' };
  }
  const value = normalizeText(raw);

  if (/如果|假如|假设|要是|万一|会不会|将会|他说|她说|用户说|我说|某人说/.test(value)) {
    return { kind: 'denied', reason: '假设或引用语句不能授权。' };
  }
  if (/不要|不用|拒绝|取消|算了|别|否/.test(value)) {
    return { kind: 'reject' };
  }

  // “不要应用第二个”已经在上面处理；这里匹配明确整句。
  const candidatePatterns = [
    /^(?:好)?(?:就)?按第([一二两三四五六七八九十\d]+)(?:个|项|条)?(?:方案)?(?:改|来|调整|办)?$/,
    /^(?:确认|采用|应用|选择|用)第([一二两三四五六七八九十\d]+)(?:个|项|条)?(?:方案)?$/,
    /^(?:确认|采用|应用)(?:应用|选择)?方案([一二两三四五六七八九十\d]+)$/,
    /^第([一二两三四五六七八九十\d]+)(?:个|项|条)?(?:方案)?(?:确认|采用|应用|可以|行)?$/,
    /^(?:确认|采用|应用)方案([一二两三四五六七八九十\d]+)$/,
  ];
  for (const pattern of candidatePatterns) {
    const match = pattern.exec(value);
    if (match) {
      const index = parseCandidateIndex(match[1]);
      if (index === null) return { kind: 'ambiguous', reason: '候选序号无法识别。' };
      return { kind: 'approve', candidateIndex: index };
    }
  }

  const generic = /^(?:确认|好|好的|可以|同意|就这么办|就这样|按这个来|采用|执行|开始|可以应用|没问题)$/;
  if (generic.test(value)) {
    return { kind: 'approve' };
  }

  if (/^(?:不|好不|真的)?(?:确认|采用|应用|改)$/.test(value)) {
    return { kind: 'ambiguous', reason: '请明确确认或拒绝。' };
  }

  // 明确拒绝一张卡。
  if (/^(?:不采用|不应用|拒绝|不要这个|换一个|都不好)$/.test(value)) {
    return { kind: 'reject' };
  }

  return { kind: 'none' };
}

export interface DisplayedAction {
  actionRequestId: string;
  candidateIndex?: number;
  candidateId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'executed';
  expiresAt?: string;
}

export interface ConfirmationResolution {
  resolvedActionRequestId: string | null;
  decision: ConfirmationDecision;
  reason?: string;
}

/** 将一句确认绑定到当前已展示且有效的具体动作。 */
export function resolveDisplayedAction(
  text: string,
  displayed: readonly DisplayedAction[],
  now = new Date().toISOString(),
  replyToActionRequestId?: string,
): ConfirmationResolution {
  const decision = parseConfirmationText(text);
  if (decision.kind === 'reject') {
    const rejectable = displayed.filter((item) => item.status === 'pending');
    if (replyToActionRequestId) {
      const reply = rejectable.find((item) => item.actionRequestId === replyToActionRequestId);
      if (reply) {
        return { resolvedActionRequestId: reply.actionRequestId, decision };
      }
    }
    if (rejectable.length === 1) {
      return { resolvedActionRequestId: rejectable[0].actionRequestId, decision };
    }
    return { resolvedActionRequestId: null, decision, reason: '请指明拒绝哪一项。' };
  }

  if (decision.kind !== 'approve') return { resolvedActionRequestId: null, decision };

  const valid = displayed.filter(
    (item) =>
      item.status === 'pending' &&
      (item.expiresAt === undefined || Date.parse(item.expiresAt) > Date.parse(now)),
  );
  if (valid.length === 0) {
    return {
      resolvedActionRequestId: null,
      decision: { kind: 'denied', reason: '没有仍待确认的有效动作。' },
    };
  }

  if (decision.candidateIndex !== undefined) {
    const matches = valid.filter((item) => item.candidateIndex === decision.candidateIndex);
    if (matches.length === 1) {
      return { resolvedActionRequestId: matches[0].actionRequestId, decision };
    }
    return {
      resolvedActionRequestId: null,
      decision: { kind: 'ambiguous' },
      reason: `无法唯一定位第 ${decision.candidateIndex} 个方案。`,
    };
  }

  if (replyToActionRequestId) {
    const reply = valid.find((item) => item.actionRequestId === replyToActionRequestId);
    if (reply) return { resolvedActionRequestId: reply.actionRequestId, decision };
    return {
      resolvedActionRequestId: null,
      decision: { kind: 'denied', reason: '回复对应的动作已失效。' },
    };
  }

  if (valid.length === 1) {
    return { resolvedActionRequestId: valid[0].actionRequestId, decision };
  }
  return {
    resolvedActionRequestId: null,
    decision: { kind: 'ambiguous' },
    reason: '当前有多个待确认动作，请说明具体哪一个。',
  };
}

// 兼容常用命名。
export const parseUserConfirmation = parseConfirmationText;
export const matchDisplayedAction = resolveDisplayedAction;

export type DirectCommand =
  | { kind: 'memory.create'; text: string }
  | { kind: 'shortlist.add'; placeRef: 'current' }
  | { kind: 'progress.record'; type: 'arrive' | 'complete'; placeRef: 'current' };

/**
 * docs/07 §5.3 的直接具体指令子集。
 * 只接受对象唯一的完整命令；自由文本推断仍交给模型，但模型不能据此授权写工具。
 */
export function parseDirectCommand(text: string): DirectCommand | null {
  const raw = text.trim();
  if (!raw) return null;
  const normalized = raw.replace(/[。！!]$/u, '');

  const memoryPrefix = /^(?:请)?(?:帮我|替我)?(?:记录一下|保存一条旅行记录|记一下|记下|记录)/u.exec(raw);
  if (memoryPrefix) {
    const content = raw.slice(memoryPrefix[0].length).replace(/^\s*[：:]?\s*/u, '').trim();
    if (content) return { kind: 'memory.create', text: content };
  }

  if (/^(?:收藏|保存)这个地点$/u.test(normalized)) {
    return { kind: 'shortlist.add', placeRef: 'current' };
  }
  if (/^(?:我们)?(?:已到达|到了)这个地点$/u.test(normalized)) {
    return { kind: 'progress.record', type: 'arrive', placeRef: 'current' };
  }
  if (/^(?:这个地点)?(?:已经)?(?:逛完|完成|结束)了?$/u.test(normalized)) {
    return { kind: 'progress.record', type: 'complete', placeRef: 'current' };
  }
  return null;
}
