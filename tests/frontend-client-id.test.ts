import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { newClientId } = await import(pathToFileURL(join(process.cwd(), 'public/lib/client-id.js')).href);
const { createImportedStopIdFactory } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-code.js')).href);

test('局域网 HTTP 缺少 randomUUID 时仍可重复生成操作及独立到访标识', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
    const ids = Array.from({ length: 64 }, () => newClientId());
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
    const first = createImportedStopIdFactory(), next = createImportedStopIdFactory();
    assert.notEqual(first(0).stopId, first(1).stopId);
    assert.notEqual(first(0).stopId, next(0).stopId, '重复导入同一地点仍是独立到访');
    assert.equal(first(0).stopId, first(0).stopId, '同一导入批次的节点引用保持稳定');
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else Reflect.deleteProperty(globalThis, 'crypto'); }
});
