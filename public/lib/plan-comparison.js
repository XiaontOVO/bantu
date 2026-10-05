/** 对比选择是临时界面状态，只保留当前方案库中有效的方案。 */
import { state } from './store.js';

export function selectedComparisonSchemes() {
  if (!(state.compareSelection instanceof Set)) state.compareSelection = new Set();
  const schemes = (state.savedPlans || []).filter(plan => plan.kind === 'scheme');
  const validIds = new Set(schemes.map(plan => plan.id));
  for (const id of state.compareSelection) if (!validIds.has(id)) state.compareSelection.delete(id);
  return schemes.filter(plan => state.compareSelection.has(plan.id));
}

export function comparisonButtonLabel(count) {
  return count >= 2 ? `比较已选的 ${count} 套方案` : count === 1 ? '已选 1 套方案，请再选择至少 1 套' : '选择至少 2 套方案后比较';
}
