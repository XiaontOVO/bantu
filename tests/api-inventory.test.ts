import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHttpServer } from '../src/server/http-server.js';

function resolvePath(path: string): string {
  return path
    .replace(':tripId', 'trip_missing')
    .replace(':operationId', 'op_missing')
    .replace(':proposalId', 'proposal_missing')
    .replace(':actionRequestId', 'action_missing')
    .replace(':placeId', 'place_missing')
    .replace(':memoryId', 'memory_missing')
    .replace(':messageId', 'message_missing')
    .replace(':planId', 'plan_missing');
}

test('every documented endpoint resolves to an HTTP handler instead of the 404 fallback', async () => {
  const docs = await readFile(`${process.cwd()}/docs/工程设计与接口契约.md`, 'utf8');
  const endpoints = [...docs.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) (\/[^ |]+) \|/gm)].map(
    (match) => ({ method: match[1], path: match[2] }),
  );
  assert.ok(endpoints.length >= 50);

  const server = createHttpServer({
    seedDemo: false,
    now: () => '2026-09-20T13:00:00+08:00',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl}/api/v1${resolvePath(endpoint.path)}`, {
        method: endpoint.method,
        headers: { 'content-type': 'application/json' },
        body:
          endpoint.method === 'GET' || endpoint.method === 'DELETE'
            ? undefined
            : JSON.stringify({}),
      });
      const text = await response.text();
      assert.equal(
        text.includes('没有匹配的接口'),
        false,
        `missing handler for ${endpoint.method} ${endpoint.path}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
