// Returning to the same dialogue is a new selection. In-flight reads belong
// to the selection that started them, even if its owner and ID match again.
let selectionEpoch = 0;
export const agentConversationSelectionEpoch = () => selectionEpoch;
export function invalidateAgentConversationSelection() { selectionEpoch += 1; }
