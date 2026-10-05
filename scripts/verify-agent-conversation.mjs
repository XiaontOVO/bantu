// Real model through HTTP: the server supplies the actual stored conversation history.
import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';

const model = new ModelSettings('data/model-settings.json').provider;
if (!model) throw new Error('未启用真实模型。');
let calls = 0;
const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: model.providerName, modelName: model.modelName, async generateTurn(request) {
    const turn = await model.generateTurn(request);
    console.log(JSON.stringify({ call: ++calls, tools: turn.toolCalls.map(tool => tool.name) }));
    return turn;
  },
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let cookie = '', messages = 0;
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (path, body) => {
  const response = await fetch(base + path, { headers: { cookie, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value.data;
};
const say = async text => {
  const result = await api('/api/v1/agent/chat', { text, clientMessageId: `conversation-${++messages}` });
  assert.equal(result.assistantMessage.agentMode, 'tools');
  console.log(JSON.stringify({ message: messages, reply: result.assistantMessage.text }));
  return result;
};
try {
  await api('/api/v1/session/guest', {});
  await api('/api/v1/account/register', { username: 'conversation_tester', password: 'conversation-test-12345' });
  await say('新建无日期的两天方案叫“双日散步”，第一天14点武康大楼60分钟，第二天14点徐家汇书院45分钟。直接保存，不要载入日计划。');
  let plans = await api('/api/v1/plans');
  const original = structuredClone(plans.find(plan => plan.name === '双日散步'));
  assert.equal(original.days.length, 2);
  await say('把它第二天改成15点开始，时长保持不变，第一天也不动。');
  plans = await api('/api/v1/plans');
  let edited = plans.find(plan => plan.id === original.id);
  assert.deepEqual(edited.days[0], original.days[0]);
  assert.equal(edited.days[1].stops[0].startMinutes, 900);
  assert.equal(edited.days[1].stops[0].endMinutes, 945);
  const source = structuredClone(edited);
  await say('再复制一份叫“周末备份”，原方案保留。');
  plans = await api('/api/v1/plans');
  const copied = plans.find(plan => plan.name === '周末备份');
  assert.ok(copied && copied.id !== original.id);
  assert.deepEqual(plans.find(plan => plan.id === original.id), source);
  await say('只把刚才复制的那份改为三天，第三天先空着。');
  plans = await api('/api/v1/plans');
  assert.equal(plans.find(plan => plan.id === copied.id).days.length, 3);
  assert.deepEqual(plans.find(plan => plan.id === original.id), source);
  await say('撤销刚才的天数修改，恢复两天，其他内容不动。');
  plans = await api('/api/v1/plans');
  assert.deepEqual(plans.find(plan => plan.id === copied.id).days, copied.days);
  const renamed = await say('把另一份方案改名为“慢慢走”，刚才这个周末备份不动。');
  plans = await api('/api/v1/plans');
  assert.equal(plans.find(plan => plan.id === original.id).name, '慢慢走');
  assert.deepEqual(plans.find(plan => plan.id === original.id).days, source.days);
  assert.doesNotMatch(renamed.assistantMessage.text, /第二天[^\n；。]*14[:：]00/, 'reply must not repeat the superseded second-day time');
  assert.equal(plans.find(plan => plan.id === copied.id).name, '周末备份');
  assert.equal(plans.length, 2);
  assert.ok(plans.every(plan => plan.kind === 'scheme' && !plan.localDate));
  const beforeCompare = structuredClone(plans);
  const compared = await say('比较“慢慢走”和“周末备份”，告诉我每天的地点数量、游览时间和路线数据是否齐全。只比较，不修改。');
  assert.ok(compared.agent.steps.some(step => step.tool === 'plans.compare' && step.ok), compared.assistantMessage.text);
  assert.deepEqual(compared.assistantMessage.resultLinks.filter(link => link.planId).map(link => link.planId).sort(), [source.id, copied.id].sort());
  assert.deepEqual(await api('/api/v1/plans'), beforeCompare);
  console.log(JSON.stringify({ verified: true, calls, messages, scenarios: ['it-second-day', 'copy-retain-original', 'just-copied-reference', 'undo-day-count', 'other-scheme-reference'] }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
