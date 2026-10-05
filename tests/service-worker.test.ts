import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('public/sw.js', 'utf8');
function harness(fetcher: () => Promise<Response>, cache: Record<string, unknown>) {
  const listeners: Record<string, (event: any) => void> = {};
  runInNewContext(source, { self: { location: { origin: 'https://bantu.test' }, addEventListener: (kind: string, callback: any) => { listeners[kind] = callback; } },
    URL, Response, fetch: fetcher, caches: cache });
  return () => {
    const background: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.fetch({ request: new Request('https://bantu.test/app.js'),
      waitUntil: (promise: Promise<unknown>) => background.push(promise), respondWith: (promise: Promise<Response>) => { response = promise; } });
    return { response: response!, background: Promise.all(background) };
  };
}

test('online scripts remain readable when opening or writing cache storage fails', async () => {
  for (const openingFails of [false, true]) {
    const fetchEvent = harness(async () => new Response('export const ready = true;'), {
      open: async () => { if (openingFails) throw new Error('Storage unavailable'); return { put: async () => { throw new Error('Quota exceeded'); } }; },
      match: async () => undefined,
    });
    const event = fetchEvent();
    assert.equal(await (await event.response).text(), 'export const ready = true;');
    await event.background;
  }
});

test('slow cache writes do not delay delivery or consume the online response body', async () => {
  let finish: () => void = () => {};
  let cached: Response | undefined;
  const storage = new Promise<void>(resolve => { finish = resolve; });
  const fetchEvent = harness(async () => new Response('current script'), {
    open: async () => ({ put: async (_request: Request, response: Response) => { cached = response; await storage; } }),
  });
  const event = fetchEvent();
  try {
    assert.equal(await (await event.response).text(), 'current script');
  } finally { finish(); }
  await event.background;
  assert.equal(await cached!.text(), 'current script');
});

test('network failures use the saved script without substituting an HTML page', async () => {
  const fetchEvent = harness(async () => { throw new Error('Offline'); }, {
    match: async (request: Request) => { assert.equal(request.url, 'https://bantu.test/app.js'); return new Response('saved script'); },
  });
  const event = fetchEvent();
  assert.equal(await (await event.response).text(), 'saved script');
  await event.background;
});

test('unavailable network and cache produce a controlled error response', async () => {
  const fetchEvent = harness(async () => { throw new Error('Offline'); }, { match: async () => { throw new Error('Storage unavailable'); } });
  const event = fetchEvent();
  assert.equal((await event.response).type, 'error');
  await event.background;
});
