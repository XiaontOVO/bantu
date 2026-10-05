import { state } from './store.js';
import { loadPlans } from './plan-library.js';
import { loadAllMemories } from './loaders.js';
import { navigate } from './render.js';
import {rememberCompanion} from './companion.js';

export async function openPersonalAgentResult(view, id) {
  if (!['home','plan', 'memories'].includes(view) || !id) throw new Error('结果入口无效。');
  const principal = state.principal;
  const revision=state.navigationRevision;
  if (view === 'plan'||view==='home') await loadPlans(); else await loadAllMemories();
  if (state.principal !== principal || state.navigationRevision!==revision) return;
  const exists = view === 'plan'||view==='home'
    ? state.savedPlans.some(plan => plan.id === id && plan.kind === (view==='home'?'plan':'scheme'))
    : state.memories.some(memory => memory.memoryId === id);
  if (!exists) throw new Error('这条内容已删除或不属于当前账号。');
  if(view==='home') {
    rememberCompanion(id);state.agentDockOpen=false;state.agentResultTarget=null;
    await navigate('home',{preserveScroll:true});
    if(state.principal===principal&&state.currentView==='home')document.getElementById('homeCompanion')?.scrollIntoView({block:'start',behavior:'instant'});
    return;
  }
  state.agentResultTarget = { view, id, scrolled: false };
  navigate(view, { preserveScroll: true });
}
