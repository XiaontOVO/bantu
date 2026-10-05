import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { modelTurn } from '../src/providers/model.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('readiness and persisted replies distinguish rules from tools, including model outages', async () => {
  for (const mode of ['missing', 'scripted', 'tools', 'outage']) {
    let calls = 0;
    const server = createHttpServer({ seedDemo: false, ...(mode === 'missing' ? {} : { modelProvider: {
      providerName: mode === 'scripted' ? 'scripted' : 'test-online', modelName: 'test', async generateTurn() {
        calls++;
        if (mode === 'outage') throw new Error('model unavailable');
        return modelTurn([], '没有进行中的计划。');
      },
    } }) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const expected = ['missing', 'scripted'].includes(mode) ? 'rules' : 'tools';
      const ready = await (await fetch(base + '/api/v1/ready')).json() as any;
      assert.equal(ready.data.checks.agentMode, expected);
      const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
      const cookie = session.headers.get('set-cookie')!.split(';')[0];
      const response = await (await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '看看今天有什么行程', clientMessageId: 'mode-check' }) })).json() as any;
      assert.equal(response.data.assistantMessage.agentMode, expected);
      const history = await (await fetch(base + '/api/v1/agent/chat', { headers: { cookie } })).json() as any;
      assert.equal(history.data.find((message: any) => message.role === 'assistant').agentMode, expected);
      assert.equal(calls, expected === 'rules' ? 0 : 1);
      if (mode === 'outage') assert.match(response.data.assistantMessage.text, /中断/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('chat does not present fixed-command handling as a language-model agent', async () => {
  const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href);
  const { state } = await load('public/lib/store.js');
  const { renderAgent } = await load('public/views/agent.js');
  const previous = { ready: state.ready, messages: state.messages, proposal: state.proposal };
  try {
    state.proposal = null;
    state.ready = { checks: { agentMode: 'rules' } };
    state.messages = [];
    assert.match(renderAgent(), /语言模型未启用/);
    assert.match(renderAgent(), /当前只能处理固定指令/);
    state.ready = { checks: { agentMode: 'tools' } };
    state.messages = [{ role: 'assistant', text: '之前的规则回复', agentMode: 'rules' }];
    assert.doesNotMatch(renderAgent(), /语言模型未启用/);
    assert.match(renderAgent(), /固定指令处理/);
  } finally { Object.assign(state, previous); }
});
