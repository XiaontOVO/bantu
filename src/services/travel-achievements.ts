import type { PlanLibraryService } from './plan-library.js';
import { achievementTier, achievementMilestones, ACHIEVEMENT_TIERS } from '../../public/lib/achievement-rules.js';

/** 从当前有效的实际事实投射；不另存累加计数，纠正/删除记录后不会残留错误奖励。 */
export function travelAchievements(plans: PlanLibraryService, actorId: string) {
  const visits = plans.completedVisits(actorId);
  const grouped = new Map<string, typeof visits>();
  for (const visit of visits) {
    const group = grouped.get(visit.placeId) || [];
    group.push(visit); grouped.set(visit.placeId, group);
  }
  const cards = [...grouped.entries()].map(([placeId, records]) => {
    const count = records.length, tier = achievementTier(count)!;
    const nextTier = ACHIEVEMENT_TIERS.find(item => item.threshold > count) || null;
    const latest = records[0];
    return { placeId, name: latest.name, cityCode: latest.cityCode, count, tier, nextTier,
      progress: nextTier ? (count - tier.threshold) / (nextTier.threshold - tier.threshold) : 1,
      firstVisit: records.at(-1)!, latestVisit: latest, visits: records };
  }).sort((a, b) => (Date.parse(b.latestVisit.completedAt || b.latestVisit.localDate) || 0) - (Date.parse(a.latestVisit.completedAt || a.latestVisit.localDate) || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  const summary = { placeCount: cards.length, visitCount: visits.length, revisitCount: cards.filter(card => card.count > 1).length,
    shiningCount: cards.filter(card => card.tier.level > 1).length };
  return { summary, cards, tiers: ACHIEVEMENT_TIERS, milestones: achievementMilestones(summary) };
}
