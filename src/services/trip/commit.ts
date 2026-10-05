/**
 * 记录落库：把一次计划变更写成新版本。
 *
 * 这是**所有写入口的唯一收尾路径**——手动编辑、应用提案、撤销、执行事实都走这里，
 * 因此版本号单调、快照归一化、变更可追溯这三条不变量只需要在一处维护。
 */
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import type { PlanVersion } from '../../domain/versioning.js';
import type { MutationView, TripRecord } from './contracts.js';
import type { TripState } from './state.js';

export function commitPlanSnapshot(
  state: TripState,
  record: TripRecord,
  version: PlanVersion,
  mutation: MutationView,
): TripRecord {
  record.snapshot = normalizeTripSnapshot(structuredClone(version.snapshot));
  record.revision = version.revision;
  // 生命周期以快照为准（例如 start 会把 draft 改成 active）；快照缺字段时保留原值。
  record.lifecycle = record.snapshot.lifecycle ?? record.lifecycle;
  record.updatedAt = version.createdAt;
  record.versions.push(structuredClone(version));
  // 快照只保留最近 5 个：revision 号仍单调递增，当前版本与进度事实不受影响。
  record.versions = record.versions.slice(-5);
  record.mutations.push(mutation);
  state.trips.set(record.tripId, record);
  return record;
}
