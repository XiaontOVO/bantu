import type { BudgetSetting } from '../../domain/types.js';

export function isValidRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidPartySize(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

export function isValidBudgetMinor(value: unknown): value is number | null | undefined {
  return value === null || value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function isValidBudgetSetting(value: unknown): value is BudgetSetting | null | undefined {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  const limit = budget.limitMinor;
  return Object.hasOwn(budget, 'limitMinor') &&
    (limit === null || (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0));
}
