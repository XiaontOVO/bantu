import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (file: string): Promise<any> => import(pathToFileURL(resolve(file)).href);

test('a slow old trip response cannot replace the newly selected trip', async () => {
  const { state } = await load('public/lib/store.js');
  const { loadTrip } = await load('public/lib/loaders.js');
  const originalFetch = globalThis.fetch;
  const originalState = { ...state };
  let release!: (value: Response) => void;
  const response = (id: string) => new Response(JSON.stringify({ data: { trip: { tripId: id }, latestProposalId: null } }));
  globalThis.fetch = async (url) => String(url).endsWith('/old')
    ? new Promise<Response>(done => { release = done; }) : response('new');
  try {
    const old = loadTrip('old');
    await loadTrip('new');
    release(response('old'));
    await old;
    assert.equal(state.trip.trip.tripId, 'new');
  } finally { globalThis.fetch = originalFetch; Object.assign(state, originalState); }
});

test('deleting a trip invalidates pending detail and list reads', async () => {
  const { state } = await load('public/lib/store.js');
  const { invalidateTripLoads, loadTrip, loadTrips } = await load('public/lib/loaders.js');
  const originalFetch = globalThis.fetch;
  const originalState = { ...state };
  let releaseTrip!: (value: Response) => void;
  let releaseList!: (value: Response) => void;
  globalThis.fetch = async (input) => String(input).startsWith('/api/v1/trips?')
    ? new Promise<Response>(done => { releaseList = done; })
    : new Promise<Response>(done => { releaseTrip = done; });
  try {
    state.trip = null;
    state.trips = [];
    const detailRequest = loadTrip('deleted-trip');
    const listRequest = loadTrips();
    invalidateTripLoads();
    releaseTrip(new Response(JSON.stringify({ data: { trip: { tripId: 'deleted-trip' }, latestProposalId: null } })));
    releaseList(new Response(JSON.stringify({ data: [{ tripId: 'deleted-trip' }], meta: { nextCursor: null } })));
    await Promise.all([detailRequest, listRequest]);
    assert.equal(state.trip, null);
    assert.deepEqual(state.trips, []);
  } finally { globalThis.fetch = originalFetch; Object.assign(state, originalState); }
});

test('messages arriving after a trip switch do not overwrite the new conversation', async () => {
  const { state } = await load('public/lib/store.js');
  const { loadMessages } = await load('public/lib/loaders.js');
  const originalFetch = globalThis.fetch;
  const originalState = { ...state };
  let release!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(done => { release = done; });
  try {
    state.trip = { trip: { tripId: 'old' } };
    const pending = loadMessages();
    state.trip = { trip: { tripId: 'new' } };
    state.messages = [{ role: 'user', text: 'new conversation' }];
    release(new Response(JSON.stringify({ data: [{ role: 'assistant', text: 'old conversation' }] })));
    await pending;
    assert.equal(state.messages[0].text, 'new conversation');
  } finally { globalThis.fetch = originalFetch; Object.assign(state, originalState); }
});

test('a history response does not overwrite messages sent while that history request was pending', async () => {
  const { state } = await load('public/lib/store.js');
  const { loadMessages } = await load('public/lib/loaders.js');
  const originalFetch = globalThis.fetch;
  const originalState = { ...state };
  let release!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(done => { release = done; });
  try {
    state.trip = { trip: { tripId: 'trip_pending_history' } };
    state.messages = [];
    state.chatPending = false;
    const pending = loadMessages();
    state.messages.push({ role: 'user', text: 'new question' }, { role: 'assistant', text: 'new answer' });
    release(new Response(JSON.stringify({ data: [{ role: 'user', text: 'old question' }], meta: { nextCursor: null } })));
    await pending;
    assert.deepEqual(state.messages.map((message: any) => message.text), ['new question', 'new answer']);
  } finally { globalThis.fetch = originalFetch; Object.assign(state, originalState); }
});

test('trip chat opens at the newest page and prepends older messages without losing its scroll position', async () => {
  const { state } = await load('public/lib/store.js');
  const { loadMessages, loadOlderMessages } = await load('public/lib/loaders.js');
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalState = { ...state };
  const chatList = { scrollTop: 120, scrollHeight: 800 };
  const requested: string[] = [];
  globalThis.document = { getElementById: (id: string) => id === 'chatList' ? chatList : null } as unknown as Document;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const data = requested.length === 1
      ? [{ role: 'assistant', text: 'latest reply' }, { role: 'user', text: 'latest question' }]
      : [{ role: 'user', text: 'older question' }, { role: 'assistant', text: 'older reply' }];
    const nextCursor = requested.length === 1 ? 'message-latest-boundary' : 'message-older-boundary';
    return new Response(JSON.stringify({ data, meta: { nextCursor } }));
  };
  try {
    state.trip = { trip: { tripId: 'trip_chat' } };
    state.chatPending = false;
    await loadMessages();
    assert.match(requested[0], /\/messages\?limit=20$/);
    assert.deepEqual(state.messages.map((message: any) => message.text), ['latest reply', 'latest question']);
    assert.equal(state.messagesCursor, 'message-latest-boundary');

    await loadOlderMessages();
    assert.match(requested[1], /before=message-latest-boundary$/);
    assert.deepEqual(state.messages.map((message: any) => message.text), [
      'older question', 'older reply', 'latest reply', 'latest question',
    ]);
    assert.equal(state.messagesCursor, 'message-older-boundary');
    assert.deepEqual(state.chatScrollRestore, { top: 120, height: 800 });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    Object.assign(state, originalState);
  }
});
