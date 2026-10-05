import { state } from './store.js';

export function focusAgentResultCard() {
  const target = state.agentResultTarget;
  if (!target || target.view !== state.currentView) return;
  const attr = target.view === 'plan' ? 'plan' : 'memory';
  const control = Array.from(document.querySelectorAll(`[data-${attr}]`)).find(element => element.dataset[attr] === target.id);
  const card = control?.closest('article');
  if (!card) return;
  card.tabIndex = -1;
  if (!target.scrolled) {
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: target.view === 'memories' ? 'start' : 'center', behavior: 'instant' });
    target.scrolled = true;
  }
}
