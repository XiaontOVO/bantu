import type { ModelMessage } from '../providers/model.js';

/** Application-side 1M-token budget. It does not change a provider's native limit. */
export const AGENT_CONTEXT_TOKENS = 1_000_000;
export function estimatedContextTokens(value: unknown): number {
  // Conservatively count UTF-8 bytes, including protocol/tool overhead. No character-to-token claim.
  return Buffer.byteLength(JSON.stringify(value), 'utf8') + 32;
}
export function agentHistoryWithinBudget(history: ModelMessage[], reserved: unknown): ModelMessage[] {
  const budget = Math.max(0, AGENT_CONTEXT_TOKENS - estimatedContextTokens(reserved) - 16_384);
  let used = 0, start = history.length;
  for (let index = history.length - 1; index >= 0; index--) {
    const size = estimatedContextTokens(history[index]);
    if (used + size > budget) break;
    used += size; start = index;
  }
  // Never introduce an orphaned assistant/tool reply at the beginning of retained history.
  while (start < history.length && history[start].role !== 'user') start++;
  return history.slice(start);
}
