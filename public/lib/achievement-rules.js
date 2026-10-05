/** 同一套规则用于服务器统计和收藏册展示；不以定位、打开场景或浏览次数授奖。 */
export const ACHIEVEMENT_TIERS = Object.freeze([
  { level: 1, threshold: 1, name: '初遇', finish: '柔彩', description: '第一次相遇，值得收藏。' },
  { level: 2, threshold: 3, name: '重逢', finish: '珠光', description: '再见时，又发现了新的美。' },
  { level: 3, threshold: 7, name: '熟悉', finish: '流光', description: '走过多次，故事仍在继续。' },
  { level: 4, threshold: 12, name: '珍藏', finish: '星辉', description: '这座城市，有了你的熟悉角落。' },
]);

export function achievementTier(count) {
  return [...ACHIEVEMENT_TIERS].reverse().find(tier => count >= tier.threshold) || null;
}

export function achievementMilestones({ placeCount, visitCount, revisitCount }) {
  return [
    { id: 'first', name: '旅途初章', detail: '完成第一次游览', icon: 'pin', current: visitCount, target: 1 },
    { id: 'explorer', name: '城市漫游者', detail: '点亮 5 个不同地点', icon: 'map', current: placeCount, target: 5 },
    { id: 'reunion', name: '老地方，新故事', detail: '重访 3 个地点', icon: 'refresh', current: revisitCount, target: 3 },
  ].map(item => ({ ...item, unlocked: item.current >= item.target }));
}
