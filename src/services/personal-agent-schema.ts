/** Validate the complete tool payload before any handler may mutate state. */
export function validatePersonalTool(schema: Record<string, unknown>, value: unknown, path = 'arguments'): void {
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) throw new Error(`${path}: 不在允许的取值范围内`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: 必须是对象`);
    const object = value as Record<string, unknown>;
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required || []) as string[]) if (!(key in object)) throw new Error(`${path}.${key}: 缺少必填参数`);
    for (const [key, child] of Object.entries(object)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key}: 不支持的参数`);
      } else validatePersonalTool(properties[key], child, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: 必须是数组`);
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path}: 数量超出范围`);
    if (schema.items) value.forEach((item, i) => validatePersonalTool(schema.items as Record<string, unknown>, item, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path}: 必须是文本`);
    if (value.length > Number(schema.maxLength ?? 20000)) throw new Error(`${path}: 文本过长`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) throw new Error(`${path}: 数值无效`);
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${path}: 数值超出范围`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path}: 必须是布尔值`);
}
