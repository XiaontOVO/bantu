/**
 * TripService 的模块级辅助：不依赖实例状态，可以单独测试。
 */

import { randomUUID } from 'node:crypto';
import { digestOpaqueToken } from '../../domain/token-hash.js';
import type { TripSnapshot } from '../../domain/types.js';
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import type { ServiceError } from './contracts.js';

export function serviceError(code: string, message: string, details?: Record<string, unknown>): ServiceError {
  return { code, message, details };
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function hashToken(token: string): string {
  return digestOpaqueToken(token);
}

export function emptyFreshSnapshot(input: {
  tripId: string;
  dataMode: 'online' | 'demo';
  timezone: string;
  localDate?: string;
  cityCode: string;
  partySize: number;
  budgetMinor?: number | null;
  budgetStrength?: 'hard' | 'soft';
}): TripSnapshot {
  return normalizeTripSnapshot({
    schemaVersion: 1,
    tripId: input.tripId,
    dataMode: input.dataMode,
    lifecycle: 'draft',
    planningStatus: 'empty',
    timezone: input.timezone,
    travelDate: input.localDate,
    dayStartMinutes: 9 * 60,
    tripSettings: {
      cityCode: input.cityCode,
      localDate: input.localDate,
      timezone: input.timezone,
      partySize: input.partySize,
      dayStartAt: '09:00',
    },
    partyNeeds: {},
    budget:
      input.budgetMinor === undefined
        ? null
        : {
            currency: 'CNY',
            limitMinor: input.budgetMinor,
            strength: input.budgetStrength ?? 'hard',
            scope: 'trip',
          },
    constraints: [],
    stops: [],
    routeLegs: [],
    plannedCharges: [],
    version: 0,
    contextSnapshotId: null,
  });
}
