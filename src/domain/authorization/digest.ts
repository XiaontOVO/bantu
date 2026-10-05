/**
 * 参数摘要：把一次动作的规范参数压成短字符串。
 *
 * 用途是**把许可绑定到具体参数**——服务端在创建请求时冻结摘要，
 * 消费许可时比对；客户端仅凭一段文案无法授权另一个动作。
 * 规范化时对对象键排序，保证同一份参数得到同一摘要。
 */

/** 规范化 JSON 参数并计算摘要；服务端冻结该摘要，客户端不能仅凭文案授权。 */
export function canonicalJson(value: unknown): string {
  const replacer = (_key: string, item: unknown): unknown => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  };
  return JSON.stringify(value ?? null, replacer);
}

export function digestArgs(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
