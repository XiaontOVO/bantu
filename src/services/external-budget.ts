export type ExternalBudgetCategory =
  | 'model_requests'
  | 'map_requests'
  | 'weather_requests'
  | 'tool_calls'
  | string;

export interface ExternalBudgetLimits {
  [category: string]: number;
}

export interface BudgetReservation {
  reservationId: string;
  category: ExternalBudgetCategory;
  units: number;
  dateKey: string;
  status: 'reserved' | 'settled' | 'released';
  createdAt: string;
  actualUnits?: number;
}

export interface BudgetDecision {
  ok: boolean;
  code?: 'BUDGET_EXHAUSTED' | 'RESERVATION_NOT_FOUND';
  message?: string;
  retryAfterSeconds?: number;
  reservationId?: string;
}

function dateKey(now: string): string {
  return now.slice(0, 10);
}

function secondsUntilNextDay(now: string): number {
  const start = Date.parse(`${dateKey(now)}T00:00:00.000Z`);
  if (Number.isNaN(start)) return 60;
  const next = start + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - Date.parse(now)) / 1000));
}

/**
 * 外部调用预算台账。
 * 请求前预占，成功结算实际用量；无法确认实际用量时保留预占，避免重启后绕过额度。
 */
export class ExternalBudgetLedger {
  private readonly reservations = new Map<string, BudgetReservation>();

  private readonly counters = new Map<string, number>();

  constructor(
    private readonly limits: ExternalBudgetLimits = {
      model_requests: 200,
      map_requests: 1000,
      weather_requests: 1000,
      tool_calls: 1000,
    },
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private used(category: ExternalBudgetCategory, date: string): number {
    const key = `${date}:${category}`;
    const settled = this.counters.get(key) ?? 0;
    const open = [...this.reservations.values()]
      .filter(
        (reservation) =>
          reservation.category === category &&
          reservation.dateKey === date &&
          reservation.status === 'reserved',
      )
      .reduce((total, reservation) => total + reservation.units, 0);
    return settled + open;
  }

  reserve(
    category: ExternalBudgetCategory,
    units: number,
    now = this.now(),
  ): BudgetDecision {
    if (!Number.isFinite(units) || units < 0) {
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: '预占数量无效。' };
    }
    const date = dateKey(now);
    const limit = this.limits[category];
    if (limit !== undefined && this.used(category, date) + units > limit) {
      return {
        ok: false,
        code: 'BUDGET_EXHAUSTED',
        message: `外部调用额度已耗尽：${category}`,
        retryAfterSeconds: secondsUntilNextDay(now),
      };
    }
    const reservationId = `budget_${Math.random().toString(36).slice(2, 10)}`;
    this.reservations.set(reservationId, {
      reservationId,
      category,
      units,
      dateKey: date,
      status: 'reserved',
      createdAt: now,
    });
    return { ok: true, reservationId };
  }

  settle(reservationId: string, actualUnits: number, _now = this.now()): BudgetDecision {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return { ok: false, code: 'RESERVATION_NOT_FOUND', message: '预占记录不存在。' };
    }
    // 只有 reserved 可以结算：重复结算已结算/已释放的预占会把额度重复计入。
    if (reservation.status !== 'reserved') {
      return { ok: false, code: 'RESERVATION_NOT_FOUND', message: '预占记录已结算或已释放。' };
    }
    if (!Number.isFinite(actualUnits) || actualUnits < 0) actualUnits = reservation.units;
    const key = `${reservation.dateKey}:${reservation.category}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + actualUnits);
    // 已结算的行已折进 counters，删除避免台账随请求量无限增长。
    this.reservations.delete(reservationId);
    return { ok: true, reservationId };
  }

  release(reservationId: string): BudgetDecision {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return { ok: false, code: 'RESERVATION_NOT_FOUND', message: '预占记录不存在。' };
    }
    if (reservation.status !== 'reserved') {
      return { ok: false, code: 'RESERVATION_NOT_FOUND', message: '预占记录已结算或已释放。' };
    }
    this.reservations.delete(reservationId);
    return { ok: true, reservationId };
  }

  usage(category: ExternalBudgetCategory, now = this.now()): number {
    const date = dateKey(now);
    return this.used(category, date);
  }

  listReservations(): BudgetReservation[] {
    return [...this.reservations.values()];
  }
}
