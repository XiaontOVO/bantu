import type {
  BudgetLimitConstraint,
  BudgetSetting,
  CostEstimate,
  PlanCheck,
  PlannedCharge,
  SpendEvent,
} from './types.js';

export interface CostRange {
  lowerMinor: number;
  upperMinor: number | null;
  certainty: 'known' | 'bounded' | 'unknown';
  currency: string;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 将 CostEstimate 统一为全团费用。
 * - party: 已经是全团金额；
 * - per_person: 需要 participantCount；
 * - per_vehicle: 首版没有车辆数时不能擅自乘人数，保持原值并标 bounded/unknown。
 */
export function normalizeCostEstimate(
  estimate: CostEstimate,
  participantCount?: number | null,
): CostRange {
  const lower = finiteNonNegative(estimate.lowerMinor);
  const upper = finiteNonNegative(estimate.upperMinor);
  if (lower === null) {
    return { lowerMinor: 0, upperMinor: null, certainty: 'unknown', currency: estimate.currency };
  }

  if (estimate.basis === 'per_person') {
    const count = participantCount ?? estimate.participantCount;
    if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) {
      return {
        lowerMinor: lower,
        upperMinor: null,
        certainty: 'unknown',
        currency: estimate.currency,
      };
    }
    return {
      lowerMinor: lower * count,
      upperMinor: upper === null ? null : upper * count,
      certainty: upper === null ? 'bounded' : estimate.certainty,
      currency: estimate.currency,
    };
  }

  // party / per_vehicle: 当前结构只能确认全团下界；缺少车辆数时未知。
  if (estimate.certainty === 'known' && upper !== null) {
    return {
      lowerMinor: lower,
      upperMinor: upper,
      certainty: 'known',
      currency: estimate.currency,
    };
  }
  return {
    lowerMinor: lower,
    upperMinor: upper,
    certainty: upper === null ? 'unknown' : estimate.certainty,
    currency: estimate.currency,
  };
}

export interface PlannedChargeRange {
  lowerMinor: number;
  upperMinor: number | null;
  certainty: 'known' | 'bounded' | 'unknown';
  chargeIdsIncluded: string[];
  paidWithoutCurrentLink: string[];
}

/**
 * 计算扣除最新完整声明中已付款项目后的剩余费用。
 * 只有最新完整累计声明明确包含该项目且 paymentStatus=paid 时才扣除。
 */
export function remainingPlannedChargeRange(
  charges: readonly PlannedCharge[],
  spendEvent: SpendEvent | null | undefined,
  participantCount?: number | null,
): PlannedChargeRange {
  let lower = 0;
  let upper = 0;
  let hasUnknown = false;
  const included: string[] = [];
  const paidWithoutCurrentLink: string[] = [];

  if (spendEvent && !spendEvent.completenessConfirmed) {
    hasUnknown = true;
  }

  for (const charge of charges) {
    const normalized = normalizeCostEstimate(charge.costEstimate, participantCount);
    const quantity =
      Number.isFinite(charge.quantity) && charge.quantity > 0 ? charge.quantity : 1;
    const linkedToCurrentSpend = Boolean(
      spendEvent?.completenessConfirmed &&
        spendEvent.includedChargeIds.includes(charge.chargeId) &&
        spendEvent.currency === charge.costEstimate.currency,
    );

    if (linkedToCurrentSpend && charge.paymentStatus === 'paid') {
      included.push(charge.chargeId);
      continue;
    }

    if (charge.paymentStatus === 'paid' && !linkedToCurrentSpend) {
      // docs/03 §4.4：已付款项目无法判定是否已经包含在当前累计声明中时，
      // 不能重复计入，也不能假定未付，因此硬预算为 unknown。
      hasUnknown = true;
      paidWithoutCurrentLink.push(charge.chargeId);
    }
    if (charge.paymentStatus === 'unknown') {
      hasUnknown = true;
    }
    if (normalized.upperMinor === null || normalized.certainty === 'unknown') {
      hasUnknown = true;
    }

    lower += normalized.lowerMinor * quantity;
    upper += (normalized.upperMinor ?? 0) * quantity;
  }

  if (hasUnknown) {
    return {
      lowerMinor: lower,
      upperMinor: null,
      certainty: 'unknown',
      chargeIdsIncluded: included,
      paidWithoutCurrentLink,
    };
  }
  return {
    lowerMinor: lower,
    upperMinor: upper,
    certainty: 'known',
    chargeIdsIncluded: included,
    paidWithoutCurrentLink,
  };
}

export interface BudgetEvaluation {
  status: 'pass' | 'fail' | 'unknown';
  reasonCode?: string;
  limitMinor: number;
  spentMinor: number | null;
  remainingLowerMinor: number;
  remainingUpperMinor: number | null;
  totalUpperMinor: number | null;
  currency: string;
}

export interface EvaluateBudgetOptions {
  constraint?: BudgetLimitConstraint;
  budget?: BudgetSetting | null;
  charges?: readonly PlannedCharge[];
  spendEvent?: SpendEvent | null;
  participantCount?: number | null;
}

function checkBudgetFromValues(
  limitMinor: number,
  currency: string,
  spentMinor: number | null,
  spendComplete: boolean,
  remaining: PlannedChargeRange,
): BudgetEvaluation {
  if (!spendComplete || spentMinor === null) {
    return {
      status: 'unknown',
      reasonCode: 'spend_completeness_unknown',
      limitMinor,
      spentMinor,
      remainingLowerMinor: remaining.lowerMinor,
      remainingUpperMinor: remaining.upperMinor,
      totalUpperMinor: null,
      currency,
    };
  }

  if (remaining.certainty === 'unknown' || remaining.upperMinor === null) {
    return {
      status: 'unknown',
      reasonCode: 'remaining_cost_unknown',
      limitMinor,
      spentMinor,
      remainingLowerMinor: remaining.lowerMinor,
      remainingUpperMinor: remaining.upperMinor,
      totalUpperMinor: null,
      currency,
    };
  }

  const totalUpper = spentMinor + remaining.upperMinor;
  if (totalUpper > limitMinor) {
    return {
      status: 'fail',
      reasonCode: 'budget_exceeded',
      limitMinor,
      spentMinor,
      remainingLowerMinor: remaining.lowerMinor,
      remainingUpperMinor: remaining.upperMinor,
      totalUpperMinor: totalUpper,
      currency,
    };
  }

  return {
    status: 'pass',
    limitMinor,
    spentMinor,
    remainingLowerMinor: remaining.lowerMinor,
    remainingUpperMinor: remaining.upperMinor,
    totalUpperMinor: totalUpper,
    currency,
  };
}

/** docs/03 §4.3/§4.4 的硬预算检查。 */
export function evaluateBudget(options: EvaluateBudgetOptions): BudgetEvaluation {
  const constraint = options.constraint;
  const setting = options.budget;
  const limitMinor = constraint?.payload.limitMinor ?? setting?.limitMinor;
  const currency = constraint?.payload.currency ?? setting?.currency ?? 'CNY';

  if (limitMinor === null || limitMinor === undefined || !Number.isFinite(limitMinor)) {
    return {
      status: 'unknown',
      reasonCode: 'budget_limit_unknown',
      limitMinor: 0,
      spentMinor: null,
      remainingLowerMinor: 0,
      remainingUpperMinor: null,
      totalUpperMinor: null,
      currency,
    };
  }

  const spendEvent = options.spendEvent;
  const spentMinor =
    spendEvent && spendEvent.currency === currency ? spendEvent.amountMinor : null;
  const spendComplete = Boolean(spendEvent?.completenessConfirmed);
  const remaining = remainingPlannedChargeRange(
    options.charges ?? [],
    spendEvent,
    options.participantCount,
  );
  return checkBudgetFromValues(limitMinor, currency, spentMinor, spendComplete, remaining);
}

/** 把 BudgetEvaluation 转成统一 PlanCheck。 */
export function budgetEvaluationToCheck(
  constraint: BudgetLimitConstraint,
  evaluation: BudgetEvaluation,
): PlanCheck {
  return {
    constraintId: constraint.constraintId,
    status: evaluation.status,
    reasonCode: evaluation.reasonCode,
    affectedStopIds: [],
  };
}
