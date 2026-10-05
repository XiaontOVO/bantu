import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { modelTurn } from '../src/providers/model.js';

test('chat HTTP validates photos and binds attachments to the retry identity', async () => {
  let calls = 0;
  const server = createHttpServer({ seedDemo: false, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request) {
      calls++;
      assert.match(JSON.stringify(request.messages), /原照片.png/);
      assert.doesNotMatch(JSON.stringify(request.messages), /iVBOR/);
      return modelTurn([], '请告诉我想写的正文。');
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const post = (images: unknown, clientMessageId: string) => fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '用照片发帖', images, clientMessageId }) });
    const invalid = await post([{ dataUrl: 'https://example.invalid/photo.png' }], 'invalid');
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const images = [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', alt: '原照片.png' }];
    const first = await post(images, 'same-upload');
    assert.equal(first.status, 200);
    const result = await first.json();
    const retry = await post(images, 'same-upload');
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json() as any).data, (result as any).data);
    assert.equal(calls, 1);
    const changed = await post([{ ...images[0], alt: '其他照片.png' }], 'same-upload');
    assert.equal(changed.status, 409);
    assert.equal(calls, 1);
    const history = await (await fetch(base + '/api/v1/agent/chat', { headers: { cookie } })).json() as any;
    const imageMessage = history.data.find((m: any) => m.images?.length);
    assert.ok(imageMessage);
    const imagePath = imageMessage.images[0].dataUrl;
    assert.match(imagePath, /^\/api\/v1\/agent\/chat\//);
    const photo = await fetch(base + imagePath, { headers: { cookie } });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    const otherSession = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const otherCookie = otherSession.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(base + imagePath, { headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await fetch(base + '/api/v1/agent/chat/' + imageMessage.messageId, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + imagePath, { headers: { cookie } })).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
