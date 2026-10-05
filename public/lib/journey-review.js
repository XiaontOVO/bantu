import {state} from './store.js';
import {loadAllMemories} from './loaders.js';
import {navigate,render} from './render.js';

/** Open the committed private record for this plan, not an unrelated memory. */
export async function openJourneyReview(planId) {
  if(!planId || state.journeyReviewPending) return;
  const principal=state.principal,revision=state.navigationRevision;
  const pending={planId,principal};state.journeyReviewPending=pending;render();
  try {
    await loadAllMemories();
    if(state.principal!==principal || state.navigationRevision!==revision)return;
    const memory=state.memories.find(item=>!item.tripId&&item.sourcePlanId===planId&&item.journey);
    if(!memory)throw new Error('这次旅行记录暂时不可用，请稍后重试。已记录的进度保持原样。');
    state.agentDockOpen=false;
    state.agentResultTarget={view:'memories',id:memory.memoryId,scrolled:false};
    await navigate('memories',{preserveScroll:true});
  } finally {
    if(state.journeyReviewPending===pending)state.journeyReviewPending=null;
    if(state.principal===principal&&state.navigationRevision===revision)render();
  }
}
