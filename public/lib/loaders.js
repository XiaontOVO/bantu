import { rememberTrip } from './trip-selection.js';
/**
 * 数据加载：把服务端状态取回并写进 `state`。
 *
 * 这一层**不负责重绘**——调用方决定何时 `render()`。
 * 这样"取数据"和"画面更新"不会互相纠缠，也便于测试单次请求。
 */
import { state, tripId, usesSavedDayPlans } from './store.js';
import { api } from './api.js';
import { ensureStandalonePlansFromTrip } from './plan-library.js';
import { loadPostFeed } from './post-feed.js';
import { agentConversationSelectionEpoch, invalidateAgentConversationSelection } from './agent-conversation-selection.js';

let communityLoadSequence = 0;
let communityPageKey = null;
let planShareLoadSequence = 0;
let planShareMorePromise = null;
let planShareSearchController = null;
let messageLoadSequence = 0;
let olderMessageLoadSequence = 0;

function fetchPlanSharePage(query = '', cursor = '', signal) {
  const search = String(query || '').trim();
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const cursorQuery = params.toString();
  const suffix = cursorQuery ? `?${cursorQuery}` : '';
  if (encodeURIComponent(search).length > 1000) {
    return api(`/api/v1/community/plan-shares/search${suffix}`, {
      method: 'POST', body: JSON.stringify({ query: search }), signal,
    }, true);
  }
  if (search) params.set('query', search);
  const queryString = params.toString();
  return api(`/api/v1/community/plan-shares${queryString ? `?${queryString}` : ''}`, { signal }, true);
}

export async function loadCommunity(more = false) {
  const sequence = ++communityLoadSequence;
  const query = state.communityQuery || '';
  const tag = state.communityTag || '';
  const city = state.communityCity || '';
  const sort = state.communitySort || '';
  const pageKey = JSON.stringify([query, tag, city, sort]);
  // 游标只对产生它的筛选条件有效。筛选变化后即使旧的“加载更多”按钮
  // 还在屏幕上，也退回重新加载第一页，避免把旧游标套到新查询上。
  if (more && communityPageKey !== pageKey) more = false;
  if (!state.officialTags) {
    // 标签只是筛选增强项；标签服务短暂不可用时，帖子和地点目录仍应可用。
    try {
      const tags = await api('/api/v1/place-tags');
      if (sequence !== communityLoadSequence) return;
      state.officialTags = tags;
    } catch {
      if (sequence !== communityLoadSequence) return;
      state.officialTags = [];
    }
  }
  if (!more) {
    const planShareSequence = ++planShareLoadSequence;
    const planShareQuery = state.planShareQuery || '';
    const [postsResult, mineResult, sharesResult] = await Promise.allSettled([
      loadPostFeed(),
      api('/api/v1/community/mine', {}, true),
      fetchPlanSharePage(planShareQuery),
    ]);
    // 帖子是社区主内容，失败时保留原有的整体错误态；方案分享和“我的”是
    // 可选子板块，短暂失败不应把已经能读到的帖子一起挡住。
    if (postsResult.status === 'rejected') throw postsResult.reason;
    if (sequence !== communityLoadSequence || planShareSequence !== planShareLoadSequence) return;
    if (mineResult.status === 'fulfilled') {
      state.communityMine = mineResult.value.data || { posts: [], places: [], planShares: [] };
    }
    if (sharesResult.status === 'fulfilled') {
      state.planShares = sharesResult.value.data || [];
      state.planShareCursor = sharesResult.value.meta?.nextCursor ?? null;
    }
  }
  const cursorValue = more ? state.communityCursor : null;
  const cursor = cursorValue ? `&cursor=${encodeURIComponent(cursorValue)}` : '';
  const page = await api(`/api/v1/community/places?limit=20&query=${encodeURIComponent(query)}${cursor}&tag=${encodeURIComponent(tag)}&city=${encodeURIComponent(city)}&sort=${encodeURIComponent(sort)}`, {}, true);
  if (sequence !== communityLoadSequence) return;
  if (more && state.communityCursor !== cursorValue) return;
  state.community = more ? [...(state.community || []), ...page.data] : page.data;
  state.communityCursor = page.meta?.nextCursor;
  communityPageKey = pageKey;
}

export async function searchPlanShares(query = '') {
  const search = String(query || '').trim();
  planShareSearchController?.abort();
  const controller = new AbortController(); planShareSearchController = controller;
  const owner = state.principal?.principalId;
  const sequence = ++planShareLoadSequence;
  planShareMorePromise = null;
  state.planShareLoadingMore = false;
  state.planShareSearching = true;
  state.planShareQuery = search;
  try {
    const page = await fetchPlanSharePage(search, '', controller.signal);
    if (sequence !== planShareLoadSequence || owner !== state.principal?.principalId) return;
    state.planShares = page.data || [];
    state.planShareCursor = page.meta?.nextCursor ?? null;
  } catch (error) {
    if (sequence !== planShareLoadSequence || owner !== state.principal?.principalId || controller.signal.aborted) return;
    throw error;
  } finally {
    if (sequence === planShareLoadSequence) state.planShareSearching = false;
  }
}

export async function loadPostDetail(postId) {
  if (!postId) throw new Error('帖子链接无效。');
  const post = await api(`/api/v1/community/posts/${encodeURIComponent(postId)}`);
  if (state.postDetailId === postId) state.postDetail = post;
  return post;
}

export async function loadMorePlanShares() {
  if (!state.planShareCursor || planShareMorePromise) return planShareMorePromise;
  const cursor = state.planShareCursor;
  const sequence = planShareLoadSequence;
  const request = (async () => {
    const page = await fetchPlanSharePage(state.planShareQuery || '', cursor);
    if (sequence !== planShareLoadSequence || state.planShareCursor !== cursor) return;
    const existing = new Set((state.planShares || []).map(share => share.id));
    state.planShares = [...(state.planShares || []), ...page.data.filter(share => !existing.has(share.id))];
    state.planShareCursor = page.meta?.nextCursor ?? null;
  })();
  planShareMorePromise = request;
  state.planShareLoadingMore = true;
  try { await request; }
  finally {
    if (planShareMorePromise === request) {
      planShareMorePromise = null;
      state.planShareLoadingMore = false;
    }
  }
}

    let tripsLoadSequence = 0;
    let tripLoadSequence = 0;

    /** Drop in-flight trip reads after a lifecycle change such as deleting the current trip. */
    export function invalidateTripLoads() {
      tripsLoadSequence += 1;
      tripLoadSequence += 1;
    }

    export async function loadTrips() {
      const sequence = ++tripsLoadSequence;
      const trips = [];
      let cursor = '';
      let pageCount = 0;
      do {
        const suffix = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
        const page = await api(`/api/v1/trips${suffix}`, {}, true);
        trips.push(...page.data);
        cursor = page.meta?.nextCursor || '';
        pageCount += 1;
      } while (cursor && pageCount < 100);
      if (sequence === tripsLoadSequence) state.trips = trips;
      return trips;
    }

    export async function loadTrip(id) {
      const sequence = ++tripLoadSequence;
      const current = await api(`/api/v1/trips/${id}`);
      const pending = current.latestProposalId
        ? await api(`/api/v1/trips/${id}/proposals/${current.latestProposalId}`) : null;
      if (sequence !== tripLoadSequence) return;
      state.trip = current;
      rememberTrip(current.trip.tripId);
      state.clockReceivedAt = performance.now();
      state.proposal = pending?.proposal || null;
      state.actionRequests = pending?.actionRequests || [];
      if (!((current.snapshot?.executionEvents || []).length)) {
        try {
          await ensureStandalonePlansFromTrip(current);
        } catch { /* Keep legacy Trip data accessible if migration cannot be saved right now. */ }
      }
    }

    let placesLoadSequence = 0;
    let placesRequest = null;
    let placesPageKey = null;
    let placeTagsRequest = null;
    let placeTagsOwner;
    function loadPlaceTags() {
      if (state.officialTags) return Promise.resolve();
      const owner = state.principal?.principalId;
      if (placeTagsRequest && placeTagsOwner === owner) return placeTagsRequest;
      const request = api('/api/v1/place-tags').then(tags => {
        if (owner === state.principal?.principalId) state.officialTags = tags;
      }).catch(() => {
        if (owner === state.principal?.principalId) state.officialTags ||= [];
      }).finally(() => { if (placeTagsRequest === request) placeTagsRequest = null; });
      placeTagsRequest = request;
      placeTagsOwner = owner;
      return request;
    }

    export function loadPlaces(more = false) {
      const owner = state.principal?.principalId;
      const keyword = String(state.placeQuery || '').trim();
      const query = `?query=${encodeURIComponent(keyword)}&tag=${encodeURIComponent(state.placeCategory === '全部' ? '' : state.placeCategory || '')}&cityCode=${encodeURIComponent(state.placeCity || '')}&limit=${keyword ? 24 : 50}`;
      const key = JSON.stringify([owner, query]);
      if (more && (placesPageKey !== key || state.placesCursor == null)) return Promise.resolve();
      if (placesRequest?.key === key && placesRequest.more === more) return placesRequest.promise;
      placesRequest?.controller.abort();
      const sequence = ++placesLoadSequence;
      const controller = new AbortController();
      const cursor = more ? state.placesCursor : null;
      const isCurrent = () => sequence === placesLoadSequence && owner === state.principal?.principalId;
      state.placesLoadingMore = more;
      state.placeMoreError = '';
      if (!more) state.placesCursor = null;
      const tags = loadPlaceTags();
      const promise = (async () => {
        try {
          const suffix = cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
          const page = await api(`/api/v1/places${query}${suffix}`, { signal: controller.signal }, true);
          if (!isCurrent()) return;
          const incoming = page.data || [];
          const ids = new Set(more ? state.places.map(place => place.placeId) : []);
          state.places = [...(more ? state.places : []), ...incoming.filter(place => {
            if (ids.has(place.placeId)) return false; ids.add(place.placeId); return true;
          })];
          state.placesCursor = page.meta?.nextCursor ?? null;
          placesPageKey = key;
          await tags;
        } catch (error) {
          if (!isCurrent() || controller.signal.aborted) return;
          if (more) state.placeMoreError = error?.message || '更多地点加载失败，请重试。';
          throw error;
        } finally {
          if (isCurrent()) state.placesLoadingMore = false;
          if (placesRequest?.promise === promise) placesRequest = null;
        }
      })();
      placesRequest = { key, more, controller, promise };
      return promise;
    }

    export const loadMorePlaces = () => loadPlaces(true);

    let placeCommunitySequence = 0;
    export async function loadPlaceCommunity() {
      const sequence = ++placeCommunitySequence, owner = state.principal?.principalId;
      const mine = await api('/api/v1/community/mine');
      if (sequence === placeCommunitySequence && owner === state.principal?.principalId) state.communityMine = mine || { posts: [], places: [], planShares: [] };
    }

    // 全量地点目录：不受地点页搜索/筛选影响，专供计划编辑器的「添加地点」选择器。
    let catalogLoadSequence = 0;
    export async function loadPlaceCatalog() {
      const sequence = ++catalogLoadSequence;
      const places = [];
      let cursor = '';
      let pageCount = 0;
      do {
        const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const page = await api(`/api/v1/places?limit=50${suffix}`, {}, true);
        if (sequence !== catalogLoadSequence) return;
        places.push(...(page.data || []));
        cursor = page.meta?.nextCursor || '';
        pageCount += 1;
      } while (cursor && pageCount < 100);
      state.placeCatalog = places;
    }

    let memoryLoadSequence = 0;
    let memoryMorePromise = null;
    export async function loadMemories(more = false) {
      if (!tripId()) return;
      if (more && memoryMorePromise) return memoryMorePromise;
      const sequence = ++memoryLoadSequence;
      const target = tripId();
      const cursor = more && state.memoryCursor ? `?cursor=${encodeURIComponent(state.memoryCursor)}` : '';
      if (!more) memoryMorePromise = null;
      const request = (async () => {
        const page = await api(`/api/v1/trips/${target}/memories${cursor}`, {}, true);
        if (sequence !== memoryLoadSequence || tripId() !== target) return;
        state.memories = more ? [...state.memories, ...page.data] : page.data;
        state.memoryCursor = page.meta?.nextCursor;
        state.memoriesScope = target;
      })();
      if (more) memoryMorePromise = request;
      try { await request; }
      finally { if (memoryMorePromise === request) memoryMorePromise = null; }
    }

    /** “我的”旅行记忆跨旅行汇总；记录保留 tripId，编辑时仍可回到正确来源。 */
    export async function loadAllMemories() {
      const sequence = ++memoryLoadSequence;
      // 记忆列表本身不应被旧 Trip 接口拖住。日计划模式下，即使历史旅行
      // 接口暂时不可用，也要先保证独立笔记可以读取。
      try { await loadTrips(); } catch { /* 历史 Trip 记忆是可选来源 */ }
      if (sequence !== memoryLoadSequence) return;
      const trips = [...(state.trips || [])];
      const results = await Promise.allSettled(trips.map(async trip => {
        const id = trip.trip?.tripId || trip.tripId;
        if (!id) return [];
        const memories = [];
        let cursor = '';
        let pageCount = 0;
        do {
          const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
          const page = await api(`/api/v1/trips/${encodeURIComponent(id)}/memories${suffix}`, {}, true);
          memories.push(...page.data);
          cursor = page.meta?.nextCursor || '';
          pageCount += 1;
        } while (cursor && pageCount < 100);
        return memories;
      }));
      const pages = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      // 日计划模式下，个人随手记忆不再挂在 Trip 下。历史 Trip 记忆仍要保留，
      // 但刷新/跨页加载时不能只写入旧 Trip 结果，否则独立笔记会被覆盖成空列表。
      let personal = [];
      if (usesSavedDayPlans()) {
        let cursor = '';
        let pageCount = 0;
        do {
          const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
          const page = await api(`/api/v1/memories${suffix}`, {}, true);
          personal.push(...(page.data || []));
          cursor = page.meta?.nextCursor || '';
          pageCount += 1;
        } while (cursor && pageCount < 100);
      }
      if (sequence !== memoryLoadSequence) return;
      state.memories = [...pages.flat(), ...personal]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      state.memoryCursor = null;
      state.memoriesScope = usesSavedDayPlans()
        ? `all+personal:${state.principal?.username || state.principal?.kind || 'guest'}`
        : 'all';
    }

    export async function loadReady() {
      state.ready = await api('/api/v1/ready');
    }

  export async function loadMessages() {
    if (!tripId()) return;
    const target = tripId();
    const messageCount = state.messages.length;
    const sequence = ++messageLoadSequence;
    ++olderMessageLoadSequence;
    state.messagesCursor = null;
    state.messagesLoadingOlder = false;
    state.chatScrollRestore = null;
    const page = await api(`/api/v1/trips/${target}/messages?limit=20`, {}, true);
    if (sequence !== messageLoadSequence || tripId() !== target) return;
    state.messagesCursor = page.meta?.nextCursor || null;
    if (state.chatPending || state.messages.length !== messageCount) return;
    state.messages = (page.data || []).map((message) => ({
      ...(message.messageId ? { messageId: message.messageId } : {}),
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
      ...(message.images?.length ? { images: message.images } : {}),
    }));
  }

  export async function loadOlderMessages() {
    const target = tripId();
    const cursor = state.messagesCursor;
    if (!target || !cursor || state.messagesLoadingOlder) return;
    const sequence = ++olderMessageLoadSequence;
    const list = typeof document === 'undefined' ? null : document.getElementById('chatList');
    const previousScroll = list ? { top: list.scrollTop, height: list.scrollHeight } : null;
    state.messagesLoadingOlder = true;
    try {
      const page = await api(`/api/v1/trips/${target}/messages?limit=20&before=${encodeURIComponent(cursor)}`, {}, true);
    if (sequence !== olderMessageLoadSequence || tripId() !== target || state.messagesCursor !== cursor) return;
    const older = (page.data || []).map((message) => ({
      ...(message.messageId ? { messageId: message.messageId } : {}),
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
      }));
      state.messages = [...older, ...state.messages];
      state.messagesCursor = page.meta?.nextCursor || null;
      state.chatScrollRestore = previousScroll;
    } finally {
      if (sequence === olderMessageLoadSequence) state.messagesLoadingOlder = false;
    }
  }

  /** 无旅行的通用对话历史（伴途不绑定行程也能聊）。 */
  export async function loadGeneralMessages() {
    if (!usesSavedDayPlans()) return;
    const owner = state.principal?.principalId || '';
    if (state.agentConversationOwner !== owner) {
      invalidateAgentConversationSelection();
      state.agentConversationOwner = owner;
      try { state.agentConversationId = sessionStorage.getItem(`bantu:agent-conversation:${owner}`) || ''; } catch { state.agentConversationId = ''; }
      state.agentConversations = [];
      state.agentConversationError = '';
      state.chatMessagePending = null; state.chatLastReceipt = null; state.agentTaskProgress = null;
    }
    const conversationId = state.agentConversationId || '';
    const selection = agentConversationSelectionEpoch();
    const sequence = ++messageLoadSequence;
    const messageCount = state.messages.length;
    ++olderMessageLoadSequence;
    state.messagesCursor = null;
    state.messagesLoadingOlder = false;
    state.chatScrollRestore = null;
    const [messages, conversations] = await Promise.all([
      api(`/api/v1/agent/chat${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`).catch(error => { if (error.status === 404) return null; throw error; }),
      state.principal ? api('/api/v1/agent/conversations').catch(() => null) : Promise.resolve(null),
    ]);
    if (sequence !== messageLoadSequence || selection !== agentConversationSelectionEpoch() || owner !== (state.principal?.principalId || '') || conversationId !== (state.agentConversationId || '') || state.accountContextChanged || !usesSavedDayPlans() || state.chatPending || state.messages.length !== messageCount) return;
    if (Array.isArray(conversations)) state.agentConversations = conversations;
    if (messages === null) {
      const next = conversations?.[0];
      if (!next) throw new Error('对话已删除，请重新打开对话列表。');
      invalidateAgentConversationSelection();
      state.agentConversationId = next.conversationId;
      state.chatImages = []; state.chatRetry = null; state.agentInterruptedTask = null; state.agentRemoteTask = null;
      try { sessionStorage.setItem(`bantu:agent-conversation:${owner}`, next.conversationId); } catch { /* Selection remains in memory. */ }
      return loadGeneralMessages();
    }
    state.messages = messages.map((message) => ({
      ...(message.resultLinks?.length ? { resultLinks: message.resultLinks } : {}),
      ...(message.agentMode ? { agentMode: message.agentMode } : {}),
      ...(message.companionAdjustment ? { companionAdjustment: message.companionAdjustment } : {}),
      ...(message.companionDelegation ? { companionDelegation: message.companionDelegation } : {}),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
      ...(message.images?.length ? { images: message.images } : {}),
    }));
    state.agentConversationError = '';
  }
