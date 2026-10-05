import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const commands = await load('public/lib/commands.js');
const state = store.state as Record<string, any>;

async function withChatEnvironment(run: (input: { value: string }) => Promise<void>): Promise<void> {
  const previous = {
    trip: state.trip,
    currentView: state.currentView,
    messages: state.messages,
    chatPending: state.chatPending,
    chatCompanionPending: state.chatCompanionPending,
    chatRetry: state.chatRetry,
    chatMessagePending: state.chatMessagePending,
    chatLastReceipt: state.chatLastReceipt,
    agentTaskProgress: state.agentTaskProgress,
    agentConversationId: state.agentConversationId,
    agentConversationOwner: state.agentConversationOwner,
    planViewDate: state.planViewDate,
    planDateSelectionRevision: state.planDateSelectionRevision,
    navigationRevision: state.navigationRevision,
    chatImages: state.chatImages,
    chatImagesBusy: state.chatImagesBusy,
    currentLocation: state.currentLocation,
    principal: state.principal,
    agentRemoteTask: state.agentRemoteTask,
    agentInterruptedTask: state.agentInterruptedTask,
    agentViewSync: state.agentViewSync,
    savedPlans: state.savedPlans,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const input = { value: '' };
  const elements: Record<string, any> = {
    chatText: input,
    pageTitle: { textContent: '' },
    pageSubtitle: { textContent: '' },
    sidebarTrip: { innerHTML: '' },
    view: { innerHTML: '' },
  };
  globalThis.document = {
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: () => [],
    activeElement: null,
  } as unknown as Document;
  state.trip = null;
  state.currentView = 'agent';
  state.messages = [];
  state.chatPending = false;
  state.chatCompanionPending = false;
  state.chatRetry = null;
  state.chatMessagePending = null; state.chatLastReceipt = null; state.agentTaskProgress = null;
  state.agentConversationId = '';
  state.chatImages = [];
  state.chatImagesBusy = false;
  state.agentViewSync = null;
  state.savedPlans = [];
  try {
    await run(input);
  } finally {
    state.trip = previous.trip;
    state.currentView = previous.currentView;
    state.messages = previous.messages;
    state.chatPending = previous.chatPending;
    state.chatCompanionPending = previous.chatCompanionPending;
    state.chatRetry = previous.chatRetry;
    state.chatMessagePending = previous.chatMessagePending;
    state.chatLastReceipt = previous.chatLastReceipt;
    state.agentTaskProgress = previous.agentTaskProgress;
    state.agentConversationId = previous.agentConversationId;
    state.agentConversationOwner = previous.agentConversationOwner;
    state.planViewDate = previous.planViewDate;
    state.planDateSelectionRevision = previous.planDateSelectionRevision;
    state.navigationRevision = previous.navigationRevision;
    state.chatImages = previous.chatImages;
    state.chatImagesBusy = previous.chatImagesBusy;
    state.currentLocation = previous.currentLocation;
    state.principal = previous.principal;
    state.agentRemoteTask = previous.agentRemoteTask;
    state.agentInterruptedTask = previous.agentInterruptedTask;
    state.agentViewSync = previous.agentViewSync;
    state.savedPlans = previous.savedPlans;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  }
}

test('reloaded chat observes a running task and retries result synchronization after network loss', async () => {
  await withChatEnvironment(async () => {
    const watcher = await load('public/lib/agent-task-status.js');
    state.principal = { principalId: 'owner' };
    state.agentConversationOwner = 'owner';
    state.agentRemoteTask = null;
    let status = 'running', failHistory = true;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/agent/task')) return new Response(JSON.stringify({ data: { id: 'task', status, refresh: [], completedSteps: 1 } }), { status: 200 });
      if (failHistory) { failHistory = false; throw new Error('网络暂时不可用'); }
      return new Response(JSON.stringify({ data: [{ role: 'assistant', text: '计划已保存', messageId: 'reply' }] }), { status: 200 });
    }) as typeof fetch;
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.chatPending, true);
    assert.equal(state.agentRemoteTask.id, 'task');
    status = 'completed';
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.chatPending, true);
    assert.equal(state.agentRemoteTask.id, 'task');
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.chatPending, false);
    assert.equal(state.agentRemoteTask, null);
    assert.equal(state.messages[0].text, '计划已保存');
    status = 'interrupted';
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.agentInterruptedTask.id, 'task');
    assert.equal(state.chatPending, false);
    status = 'completed';
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.agentInterruptedTask, null);
  });
});

test('chat restores the failed message when the user has not started a new draft', async () => {
  await withChatEnvironment(async input => {
    let rejectRequest!: (error: Error) => void;
    globalThis.fetch = (() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; })) as typeof fetch;
    const pending = commands.sendChat('帮我安排一趟轻松的旅行');
    await Promise.resolve();
    rejectRequest(new TypeError('网络暂时不可用'));
    await pending;

    assert.equal(input.value, '帮我安排一趟轻松的旅行');
    assert.equal(state.chatRetry?.text, '帮我安排一趟轻松的旅行');
    assert.match(state.chatRetry?.error, /网络暂时不可用/);
  });
});

test('photos can be sent without text and remain available after a failed request', async () => {
  await withChatEnvironment(async () => {
    const photos = [{ dataUrl: 'data:image/jpeg;base64,/9j/', alt: '旅行照片' }];
    state.chatImages = photos;
    const requests: any[] = [];
    globalThis.fetch = (async (_url, options = {}) => {
      requests.push(JSON.parse(String(options.body)));
      if (requests.length === 1) throw new Error('网络中断');
      return new Response(JSON.stringify({ data: { assistantMessage: { text: '已查看照片。' } } }), { status: 200 });
    }) as typeof fetch;
    await commands.sendChat('  ');
    assert.deepEqual(requests[0].images, photos);
    assert.match(requests[0].text, /无法确定的地点请说明/);
    assert.deepEqual(state.chatImages, photos);
    assert.equal(state.chatRetry.clientMessageId, requests[0].clientMessageId);
    await commands.retryFailedChat();
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(state.chatImages, []);
    assert.equal(state.messages.filter((message: any) => message.role === 'user').length, 1);
    assert.equal(state.chatRetry, null);
  });
});

test('empty input and photos still being compressed do not submit requests', async () => {
  await withChatEnvironment(async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('Unexpected request'); }) as typeof fetch;
    await commands.sendChat(' ');
    state.chatImages = [{ dataUrl: 'data:image/jpeg;base64,/9j/', alt: '照片' }];
    state.chatImagesBusy = true;
    await commands.sendChat(' ');
    state.chatImagesBusy = false;
    state.chatPending = true;
    await commands.sendChat('看看照片');
    assert.equal(calls, 0);
    assert.equal(state.messages.length, 0);
    assert.equal(state.chatImages.length, 1);
  });
});

test('chat preserves a newer draft typed while the previous message is waiting', async () => {
  await withChatEnvironment(async input => {
    let rejectRequest!: (error: Error) => void;
    globalThis.fetch = (() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; })) as typeof fetch;
    const pending = commands.sendChat('帮我安排一趟轻松的旅行');
    await Promise.resolve();
    input.value = '我还想补充一点';
    rejectRequest(new TypeError('网络暂时不可用'));
    await pending;

    assert.equal(input.value, '我还想补充一点');
  });
});

test('an old-account failed send cannot restore text or clear a new-account pending request', async () => {
  await withChatEnvironment(async input => {
    state.principal = { principalId: 'composer-old-owner' };
    input.value = '原账号的私人行程';
    let rejectRequest!: (error: Error) => void;
    globalThis.fetch = (() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; })) as typeof fetch;
    const pending = commands.sendChat(input.value);
    await Promise.resolve();
    state.principal = { principalId: 'composer-new-owner' };
    input.value = '新账号正在编辑';
    state.messages = [];
    state.chatRetry = null;
    state.chatPending = true;
    state.chatCompanionPending = true;
    rejectRequest(new Error('旧请求断开'));
    await pending;
    assert.equal(input.value, '新账号正在编辑');
    assert.equal(state.chatRetry, null);
    assert.equal(state.chatPending, true);
    assert.equal(state.chatCompanionPending, true);
    assert.deepEqual(state.messages, []);
  });
});

test('retry resends the same idempotency key without duplicating the user message', async () => {
  await withChatEnvironment(async input => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
      requests.push({ body: JSON.parse(String(options?.body)) });
      if (requests.length === 1) throw new TypeError('网络中断');
      return new Response(JSON.stringify({ data: { assistantMessage: { text: '已收到建议。' } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const photos = [{ dataUrl: 'data:image/jpeg;base64,/9j/', alt: '原照片' }];
    state.chatImages = photos;
    const fix = { lat: 31.2, lng: 121.43, accuracyMeters: 20, measuredAt: Date.now(), source: 'gps' };
    state.currentLocation = { coordinates: fix };
    await commands.sendChat('帮我安排一趟轻松的旅行');
    const clientMessageId = state.chatRetry?.clientMessageId;
    assert.ok(clientMessageId);
    state.chatImages = [{ dataUrl: 'data:image/jpeg;base64,/9j/', alt: '新照片' }];
    state.currentLocation = { coordinates: { ...fix, lat: 31.3 } };
    await commands.retryFailedChat();

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.clientMessageId, clientMessageId);
    assert.equal(requests[1].body.clientMessageId, clientMessageId);
    assert.deepEqual(requests[0].body.images, photos);
    assert.deepEqual(requests[1].body.images, photos);
    assert.deepEqual(requests[1].body.location, requests[0].body.location);
    assert.equal((requests[1].body.location as any).lat, 31.2);
    assert.equal(state.chatImages[0].alt, '新照片');
    assert.equal(state.messages.filter((message: any) => message.role === 'user').length, 1);
    assert.equal(state.messages.filter((message: any) => message.role === 'assistant').length, 1);
    assert.equal(state.chatRetry, null);
    assert.equal(input.value, '');
  });
});

test('a committed standalone Agent command is not marked retryable when a refresh request fails', async () => {
  await withChatEnvironment(async input => {
    state.principal = { principalId: 'sync-owner' };
    const requests: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = new URL(String(url), 'http://localhost').pathname;
      requests.push(path);
      if (path === '/api/v1/agent/chat') {
        return new Response(JSON.stringify({ data: {
          userMessage: { messageId: 'user-committed' },
          assistantMessage: { messageId: 'assistant-committed', text: '计划已保存。' },
          command: { refresh: ['plans'] },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: '刷新计划失败' } }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await commands.sendChat('帮我安排今天去武康大楼');

    assert.deepEqual(requests, ['/api/v1/agent/chat', '/api/v1/plans']);
    assert.equal(state.chatRetry, null);
    assert.equal(input.value, '');
    assert.equal(state.messages.at(-1)?.text, '计划已保存。');
    assert.deepEqual(state.agentViewSync.refresh, ['plans']);
    state.currentView = 'today';
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      requests.push(new URL(String(url), 'http://localhost').pathname);
      assert.notEqual(options?.method, 'POST', 'recovery must only read, never replay the user operation');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    await (await load('public/lib/agent-task-status.js')).refreshAgentTaskStatus();
    assert.deepEqual(requests, ['/api/v1/agent/chat', '/api/v1/plans', '/api/v1/plans']);
    assert.equal(state.agentViewSync, null);
    assert.equal(state.chatRetry, null);
    assert.equal(state.chatPending, false);
  });
});

test('view refresh waits for the shared in-flight batch and old-account retries are discarded', async () => {
  await withChatEnvironment(async () => {
    const sync = await load('public/lib/agent-view-sync.js');
    state.principal = { principalId: 'owner' };
    let resolveRead!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (() => { calls++; return new Promise<Response>(resolve => { resolveRead = resolve; }); }) as typeof fetch;
    const first = sync.syncAgentViews(['plans']);
    const second = sync.syncAgentViews(['plans']);
    assert.equal(first, second, 'callers share completion instead of prematurely claiming refresh finished');
    resolveRead(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    while (calls < 2) await new Promise(resolve => setTimeout(resolve, 0));
    resolveRead(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await first;
    assert.equal(state.agentViewSync, null);
    assert.equal(calls, 2);
    state.agentViewSync = { principal:state.principal,refresh:['plans'] };
    state.principal = { principalId: 'reader' };
    await sync.syncAgentViews();
    assert.equal(state.agentViewSync, null);
    assert.equal(calls, 2, 'previous account retry must not run under a new identity');
  });
});

test('a recovered completed task retries failed plan reads without keeping chat blocked', async () => {
  await withChatEnvironment(async () => {
    const watcher = await load('public/lib/agent-task-status.js');
    state.principal = { principalId: 'owner' };
    state.agentConversationOwner = 'owner';
    state.agentRemoteTask = { id: 'task', status: 'running' };
    state.chatPending = true;
    let failed = false;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = new URL(String(url), 'http://localhost').pathname;
      if (path === '/api/v1/agent/task') return new Response(JSON.stringify({ data: { id: 'task', status: 'completed', refresh: ['plans'] } }), { status: 200 });
      if (path === '/api/v1/plans' && !failed) { failed = true; throw new Error('计划读取临时失败'); }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.agentRemoteTask, null);
    assert.equal(state.chatPending, false);
    assert.deepEqual(state.agentViewSync.refresh, ['plans']);
    await watcher.refreshAgentTaskStatus();
    assert.equal(state.agentViewSync, null);
    assert.equal(state.chatPending, false);
  });
});

test('a confirmed reply unlocks chat before slow reads and its late cleanup cannot clear a newer request', async () => {
  await withChatEnvironment(async () => {
    state.principal = { principalId:'fast-receipt-owner' };
    let finishRead!: (response:Response)=>void, finishSecond!: (response:Response)=>void;
    let posts = 0;
    const response = (data:unknown) => new Response(JSON.stringify({data}));
    globalThis.fetch = (async (url:RequestInfo|URL) => {
      if (String(url) === '/api/v1/plans') return new Promise<Response>(resolve=>{finishRead=resolve;});
      if (++posts === 1) return response({assistantMessage:{text:'已保存第一条计划'},command:{refresh:['plans']}});
      return new Promise<Response>(resolve=>{finishSecond=resolve;});
    }) as typeof fetch;
    const first = commands.sendChat('安排明天去武康大楼');
    while (!finishRead) await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(state.messages.at(-1).text,'已保存第一条计划');
    assert.equal(state.chatPending,false,'the user can read and send while the plan list is still loading');
    assert.equal(state.chatRetry,null);
    const second = commands.sendChat('我再补充一个要求');
    assert.equal(state.chatPending,true);
    const token = state.chatMessagePending;
    finishRead(response([])); await first;
    assert.equal(state.chatPending,true,'old successful send must not unlock the newer request');
    assert.equal(state.chatMessagePending,token);
    finishSecond(response({assistantMessage:{text:'已收到补充'}})); await second;
    assert.equal(state.chatPending,false);
    assert.equal(state.messages.at(-1).text,'已收到补充');
    assert.equal(posts,2);
  });
});

test('rest delegation dispatches immediately without requiring a new GPS fix', async () => {
  await withChatEnvironment(async () => {
    state.currentLocation = null;
    let requests = 0;
    globalThis.fetch = (async (_url:RequestInfo|URL,options?:RequestInit) => {
      requests++; const body=JSON.parse(String(options?.body));
      assert.equal(body.location,undefined);
      assert.equal(body.companionRequest.action,'delegate');
      return new Response(JSON.stringify({data:{assistantMessage:{text:'已安排休息'}}}));
    }) as typeof fetch;
    const task = commands.sendChat('我累了，原地休息30分钟',{companionRequest:{action:'delegate',minutes:30}});
    assert.equal(requests,1,'GPS permission or acquisition must not precede a non-location operation');
    await task;
    assert.equal(state.messages.at(-1).text,'已安排休息');
  });
});

test('a failed read survives a separate queued successful refresh and retries only the failed resource', async () => {
  await withChatEnvironment(async () => {
    const sync=await load('public/lib/agent-view-sync.js');
    state.principal={principalId:'partial-refresh-owner'};
    let finish!: (response:Response)=>void;const paths:string[]=[];
    globalThis.fetch=(async(url:RequestInfo|URL)=>{
      paths.push(String(url));
      if(String(url)==='/api/v1/plans') return new Promise<Response>(resolve=>{finish=resolve;});
      return new Response(JSON.stringify({data:{principalId:'partial-refresh-owner',nickname:'新昵称'}}));
    }) as typeof fetch;
    const first=sync.syncAgentViews(['plans']);
    const queued=sync.syncAgentViews(['profile']);
    assert.equal(first,queued);
    finish(new Response(JSON.stringify({error:{message:'计划读取失败'}}),{status:503}));
    await queued;
    assert.deepEqual(state.agentViewSync.refresh,['plans']);
    assert.deepEqual(paths,['/api/v1/plans','/api/v1/me']);
    globalThis.fetch=(async(url:RequestInfo|URL)=>{paths.push(String(url));return new Response(JSON.stringify({data:[]}));}) as typeof fetch;
    await sync.syncAgentViews();
    assert.equal(state.agentViewSync,null);
    assert.deepEqual(paths,['/api/v1/plans','/api/v1/me','/api/v1/plans']);
  });
});

test('a new owner can refresh without waiting for the previous owner and cannot receive its profile', async () => {
  await withChatEnvironment(async () => {
    const sync=await load('public/lib/agent-view-sync.js');
    let finishOld!: (response:Response)=>void;
    state.principal={principalId:'old-reader',nickname:'旧账号'};
    globalThis.fetch=(async()=>new Promise<Response>(resolve=>{finishOld=resolve;})) as typeof fetch;
    const old=sync.syncAgentViews(['profile']);
    state.principal={principalId:'new-reader',nickname:'新账号'};
    globalThis.fetch=(async()=>new Response(JSON.stringify({data:{principalId:'new-reader',nickname:'新账号新昵称'}}))) as typeof fetch;
    await sync.syncAgentViews(['profile']);
    assert.equal(state.principal.nickname,'新账号新昵称');
    finishOld(new Response(JSON.stringify({data:{principalId:'old-reader',nickname:'旧账号回执'}})));await old;
    assert.equal(state.principal.nickname,'新账号新昵称');
    assert.equal(state.agentViewSync,null);
  });
});

test('a delayed resume from a previous conversation cannot send continue into the new conversation', async () => {
  await withChatEnvironment(async () => {
    state.agentConversationId='old-conversation';
    let finish!: (response:Response)=>void;let writes=0;
    globalThis.fetch=(async(_url:RequestInfo|URL,options?:RequestInit)=>{
      if(options?.method==='POST'){writes++;throw new Error('Unexpected stale resume');}
      return new Promise<Response>(resolve=>{finish=resolve;});
    }) as typeof fetch;
    const resume=commands.resumeAgentTask('old-task');state.agentConversationId='new-conversation';
    state.agentInterruptedTask={id:'new-task',status:'interrupted'};
    finish(new Response(JSON.stringify({data:{id:'old-task',status:'interrupted'}})));await resume;
    assert.equal(writes,0);
    assert.equal(state.agentInterruptedTask.id,'new-task');
  });
});

test('a delayed stop status cannot issue a cancellation for a different conversation', async () => {
  await withChatEnvironment(async () => {
    state.agentConversationId='old-conversation';
    let finish!: (response:Response)=>void;let writes=0;
    globalThis.fetch=(async(_url:RequestInfo|URL,options?:RequestInit)=>{
      if(options?.method==='DELETE'){writes++;throw new Error('Unexpected stale cancel');}
      return new Promise<Response>(resolve=>{finish=resolve;});
    }) as typeof fetch;
    const stop=commands.stopAgentTask();state.agentConversationId='new-conversation';
    finish(new Response(JSON.stringify({data:{id:'old-task',status:'running'}})));await stop;
    assert.equal(writes,0);
  });
});

test('an incomplete Agent receipt cannot produce a canned success and retries reuse the same message key', async () => {
  await withChatEnvironment(async input => {
    const requests:any[]=[];
    globalThis.fetch=(async(_url:RequestInfo|URL,options?:RequestInit)=>{
      requests.push(JSON.parse(String(options?.body)));
      return new Response(JSON.stringify({data:requests.length===1?{}:{assistantMessage:{text:'服务端确认：计划已保存'}}}));
    }) as typeof fetch;
    await commands.sendChat('帮我保存计划');
    assert.equal(state.chatPending,false);
    assert.equal(state.messages.filter((message:any)=>message.role==='assistant').length,0);
    assert.match(state.chatRetry.error,/回复未完整接收/);
    assert.equal(input.value,'帮我保存计划');
    await commands.retryFailedChat();
    assert.equal(requests[0].clientMessageId,requests[1].clientMessageId);
    assert.equal(state.messages.at(-1).text,'服务端确认：计划已保存');
    assert.equal(state.chatRetry,null);
  });
});

test('a delayed Agent save cannot move the user away from a newly selected date', async () => {
  await withChatEnvironment(async () => {
    state.planViewDate = '2026-10-03';
    let finish!: (response:Response)=>void;
    globalThis.fetch = (()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
    const sending = commands.sendChat('调整今天的计划');
    state.planViewDate = '2026-10-08';
    finish(new Response(JSON.stringify({data:{assistantMessage:{text:'今天的计划已调整'},command:{date:'2026-10-03',refresh:[]}}})));
    await sending;
    assert.equal(state.planViewDate,'2026-10-08','completed work must not replace a later date selection');
    assert.equal(state.messages.at(-1).text,'今天的计划已调整');
    assert.equal(state.chatPending,false);
  });
});

test('a delayed Agent save cannot change the selected date after the user navigates elsewhere', async () => {
  await withChatEnvironment(async () => {
    state.planViewDate = '2026-10-03';
    let finish!: (response:Response)=>void;
    globalThis.fetch = (()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
    const sending = commands.sendChat('安排明天的计划');
    state.navigationRevision += 1;
    finish(new Response(JSON.stringify({data:{assistantMessage:{text:'明天计划已保存'},command:{date:'2026-10-04',refresh:[]}}})));
    await sending;
    assert.equal(state.planViewDate,'2026-10-03','late background completion must preserve the current browsing context');
    assert.equal(state.messages.at(-1).text,'明天计划已保存');
    assert.equal(state.chatPending,false);
  });
});

test('reselecting the original date still supersedes a delayed Agent date change', async () => {
  await withChatEnvironment(async () => {
    const actions = await load('public/lib/actions.js');
    state.planViewDate = '2030-10-03';
    let finish!: (response:Response)=>void;
    globalThis.fetch = (()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
    const sending = commands.sendChat('安排明天的计划');
    await actions.handleAction('plan-view-date',{dataset:{date:'2030-10-08'}});
    await actions.handleAction('plan-view-date',{dataset:{date:'2030-10-03'}});
    finish(new Response(JSON.stringify({data:{assistantMessage:{text:'明天计划已保存'},command:{date:'2030-10-04',refresh:[]}}})));
    await sending;
    assert.equal(state.planViewDate,'2030-10-03','the latest explicit selection wins even if its value equals the earlier date');
  });
});

test('an Agent date change still applies when the user has kept the original browsing context', async () => {
  await withChatEnvironment(async () => {
    state.planViewDate = '2026-10-03';
    globalThis.fetch = (async()=>new Response(JSON.stringify({data:{assistantMessage:{text:'明天计划已保存'},command:{date:'2026-10-04',refresh:[]}}}))) as typeof fetch;
    await commands.sendChat('安排明天的计划');
    assert.equal(state.planViewDate,'2026-10-04');
  });
});
