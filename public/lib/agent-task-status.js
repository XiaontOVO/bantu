import { state, usesSavedDayPlans } from './store.js';
import { api } from './api.js';
import { render } from './render.js';
import { loadGeneralMessages } from './loaders.js';
import { syncAgentViews } from './agent-view-sync.js';
import { agentConversationSelectionEpoch } from './agent-conversation-selection.js';

const checks = new Set();
const taskViews = new WeakMap();
export async function refreshAgentTaskStatus() {
  if (!state.principal || state.accountContextChanged || !usesSavedDayPlans()) return;
  const principal = state.principal, conversationId = state.agentConversationId;
  const pending = state.chatMessagePending;
  const receipt = state.chatLastReceipt, selection = agentConversationSelectionEpoch();
  if (state.currentView !== 'agent' && !state.agentDockOpen && !pending && !state.agentRemoteTask && !state.agentViewSync) return;
  if (state.chatPending && !pending && !state.agentRemoteTask) return;
  // A request belonging to an old dialogue must not block polling the new one.
  if ([...checks].some(check => check.principal === principal && check.conversationId === conversationId && check.pending === pending && check.receipt === receipt && check.selection === selection)) return;
  const check = {principal,conversationId,pending,receipt,selection}; checks.add(check);
  const isCurrent = () => state.principal === principal && state.agentConversationId === conversationId && !state.accountContextChanged && state.chatMessagePending === pending && state.chatLastReceipt === receipt && agentConversationSelectionEpoch() === selection;
  try {
    if (!pending && state.agentViewSync && await syncAgentViews()) { if (isCurrent()) render(); }
    if (!isCurrent()) return;
    if (state.currentView !== 'agent' && !state.agentDockOpen && !pending && !state.agentRemoteTask) return;
    const task = await api('/api/v1/agent/task' + (conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''));
    if (!isCurrent()) return;
    if (pending) {
      if (pending.owner !== principal.principalId || pending.conversationId !== (conversationId || '')) return;
      const previous = state.agentTaskProgress;
      // During a local POST this endpoint reports progress only. The POST owns
      // its receipt, history and pending flag, even after the task has finished.
      // Ignore a previous completed task before this request starts on the server.
      if (task && (task.status === 'running' || (previous?.pending === pending && previous.id === task.id))) {
        state.agentTaskProgress = {...task,pending};
        if (previous?.pending !== pending || previous.id !== task.id || previous.status !== task.status || previous.completedSteps !== task.completedSteps || previous.cancelRequested !== task.cancelRequested) render();
      }
      return;
    }
    if (state.chatPending && !state.agentRemoteTask) return;
    const previous = state.agentRemoteTask;
    if (task?.status === 'running') {
      taskViews.set(task, previous?.id === task.id && taskViews.get(previous) || {date:state.planViewDate,navigation:state.navigationRevision,dateSelection:state.planDateSelectionRevision || 0});
      state.agentRemoteTask = task;
      state.chatPending = true;
      if (!previous || previous.completedSteps !== task.completedSteps || previous.cancelRequested !== task.cancelRequested) render();
    } else if (previous) {
      state.chatPending = false;
      const observed = taskViews.get(previous);
      if (task?.date && observed && state.planViewDate === observed.date && state.navigationRevision === observed.navigation && (state.planDateSelectionRevision || 0) === observed.dateSelection) state.planViewDate = task.date;
      await loadGeneralMessages();
      if (!isCurrent()) return;
      await syncAgentViews(task?.refresh || []);
      if (!isCurrent()) return;
      state.agentRemoteTask = null;
      render();
    }
    const interrupted = task?.status === 'interrupted' ? task : null;
    if (state.agentInterruptedTask?.id !== interrupted?.id) { state.agentInterruptedTask = interrupted; render(); }
  } catch { if (isCurrent() && !pending && state.agentRemoteTask) state.chatPending = true; /* Retry failed result synchronization. */ }
  finally { checks.delete(check); }
}
