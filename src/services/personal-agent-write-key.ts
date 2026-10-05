/** JSON object property order is immaterial; array order remains meaningful. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function agentWriteKey(name: string, args: unknown): string {
  return JSON.stringify([name, canonical(args)]);
}
export function canonicalStoredWriteKey(key: string): string {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string') return agentWriteKey(parsed[0], parsed[1]);
  } catch { /* Preserve unknown legacy keys without inventing matches. */ }
  return key;
}

/** These operations set a desired state; an intervening inverse operation invalidates old receipts. */
export function reapplyDesiredState(tool: string): boolean {
  return ['favorites.set', 'community.post_favorite', 'community.post_like', 'places.edit_tags', 'attachments.clear', 'account.nickname'].includes(tool);
}
