import { state } from './store.js';
import { companionTarget } from './day-plan-selection.js';
import { resolveStopPlace } from './components.js';
import { navigate } from './render.js';
import { openPlaceScene, selectSceneHotspot } from './place-scene.js';
import { toast } from './ui.js';
import { planDraftChanged } from './plan-draft-guard.js';

/** A page hint, never a permission token or proof of physical arrival. */
export function currentAgentViewContext() {
  if (state.agentContextExcludedRevision === state.navigationRevision) return null;
  const context = { view: state.currentView, navigationRevision: state.navigationRevision || 0 };
  if (state.currentView === 'scene' && state.scenePlaceId) {
    context.placeId = state.scenePlaceId;
    if (state.sceneData?.placeId === state.scenePlaceId &&
        state.sceneData.hotspots.some(item => item.id === state.sceneSelectedHotspotId)) context.hotspotId = state.sceneSelectedHotspotId;
  } else if (state.currentView === 'place' && state.placeDetailId) context.placeId = state.placeDetailId;
  if (state.currentView === 'achievements' && state.achievementsOwner === state.principal?.principalId &&
      state.achievements?.cards.some(card => card.placeId === state.achievementSelected)) context.placeId = state.achievementSelected;
  if (state.currentView === 'post-detail' && state.postDetailId) context.postId = state.postDetailId;
  if (state.currentView === 'map') {
    context.mapFrom = state.mapFrom || (state.currentLocation?.coordinates ? 'my-location' : '');
    context.mapTo = state.mapTo || '';
    context.routeMode = state.routeMode || '';
  }
  if (['home', 'today', 'scene', 'map', 'plan'].includes(state.currentView)) {
    const target = companionTarget(state.savedPlans || [], state.companionPlanId);
    const selectedDate = state.planViewDate;
    const selectedPlan = ['today', 'map'].includes(state.currentView) && selectedDate
      ? (state.savedPlans || []).find(plan => plan.kind === 'plan' && plan.localDate === selectedDate) : null;
    const draftPlan = state.currentView === 'plan' && state.planDraft?.editId
      ? (state.savedPlans || []).find(plan => plan.id === state.planDraft.editId) : null;
    const plan = draftPlan || selectedPlan || target.plan;
    if (plan) {
      context.planId = plan.id;
      context.expectedRevision = plan.revision || 0;
      if (target.plan?.id === plan.id && target.next) {
        context.stopId = target.next.stopId;
        if (!context.placeId && ['home', 'today'].includes(state.currentView)) context.placeId = resolveStopPlace(target.next)?.placeId;
      }
    }
  }
  return context;
}

export async function applyAgentUiActions(actions, sentContext, owner) {
  if (!Array.isArray(actions) || !actions.length || !sentContext) return;
  if (state.principal?.principalId !== owner || state.navigationRevision !== sentContext.navigationRevision) return;
  for (const action of actions.slice(0, 5)) {
    if (state.principal?.principalId !== owner) return;
    if (action.type === 'highlight' && action.placeId === sentContext.placeId) {
      if (state.currentView !== 'scene') {
        if (planDraftChanged()) { toast('当前有未保存的计划草稿，请先保存或放弃后再切页。'); break; }
        if (currentAgentViewContext()?.placeId !== action.placeId) break;
        state.agentDockOpen = false;
        await openPlaceScene(action.placeId);
      }
      if (state.currentView === 'scene' && state.scenePlaceId === action.placeId &&
          state.sceneData?.hotspots?.some(item => item.id === action.hotspotId)) {
        state.agentDockOpen = false;
        selectSceneHotspot(action.hotspotId);
      }
      break;
    }
    if (action.type !== 'navigate' || !['home', 'places', 'place', 'scene', 'today', 'plan', 'map', 'agent', 'memories'].includes(action.view)) continue;
    if (planDraftChanged()) { toast('当前有未保存的计划草稿，请先保存或放弃后再切页。'); break; }
    if (action.view === 'scene' && action.placeId === sentContext.placeId) {
      state.agentDockOpen = false;
      await openPlaceScene(action.placeId);
      break;
    } else if (action.view === 'place' && action.placeId === sentContext.placeId) {
      state.agentDockOpen = false;
      state.placeDetailId = action.placeId; navigate('place'); break;
    } else if (!['scene', 'place'].includes(action.view)) { state.agentDockOpen = false; navigate(action.view); break; }
  }
}
