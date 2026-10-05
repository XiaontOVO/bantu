import { state } from './store.js';
import { dateKeyInTimeZone } from './format.js';

export function placeAddTargetDate() {
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  return state.planViewDate && state.planViewDate >= today ? state.planViewDate : today;
}

/** A dated scheme remains a reusable scheme, not an open daily editor. */
export function dayPlanDraftForDate(date) {
  const draft = state.planDraft;
  if (!draft) return null;
  const source = (state.savedPlans || []).find(plan => plan.id === draft.editId && plan.kind === 'plan');
  return (draft.dailyPlanDate || source?.localDate) === date ? draft : null;
}
