import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const { state } = await load('public/lib/store.js');
const { renderAgent } = await load('public/views/agent.js');

test('chat retains historical messages and exposes new and selectable conversations without deletion', () => {
  const before = { messages: state.messages, trip: state.trip, ready: state.ready, proposal: state.proposal, chatPending: state.chatPending };
  state.messages = [
    { messageId: 'user-message-1', role: 'user', text: '<script>private text</script>' },
    { messageId: 'assistant-message-1', role: 'assistant', text: '回复内容' },
  ];
  state.trip = null;
  state.ready = null;
  state.proposal = null;
  try {
    const html = renderAgent();
    assert.doesNotMatch(html, /confirm-delete-chat-message|chat-message-delete|删除这条消息/);
    assert.match(html, /data-action="new-agent-conversation"/);
    assert.match(html, /data-action="open-agent-conversations"/);
    assert.ok(html.includes('&lt;script&gt;private text&lt;/script&gt;'), 'message text remains escaped inside the bubble');
    state.chatPending = true;
    assert.match(renderAgent(), /data-action="new-agent-conversation" aria-label="开启新对话" disabled/);
  } finally {
    state.messages = before.messages;
    state.trip = before.trip;
    state.ready = before.ready;
    state.proposal = before.proposal;
    state.chatPending = before.chatPending;
  }
});


test('floating companion has no conversation management and automatic adjustment has no internal mode label',()=>{
  const before={messages:state.messages,chatPending:state.chatPending};
  state.messages=[{role:'assistant',text:'已顺延半小时',messageId:'adjusted',agentMode:'tools',companionDelegation:{status:'applied',planId:'owned'}}];state.chatPending=false;
  try {
    assert.doesNotMatch(renderAgent({compact:true}),/open-agent-conversations|new-agent-conversation|rename-agent-conversation|agent-conversation-bar/);
    assert.doesNotMatch(renderAgent(),/随行托管|随行调整 · 伴途 Agent/);
    assert.match(renderAgent(),/已自动调整后续安排/);
    assert.match(renderAgent(),/open-agent-conversations/);
  }finally{Object.assign(state,before)}
});
