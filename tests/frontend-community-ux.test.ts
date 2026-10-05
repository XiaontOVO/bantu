import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const state = store.state as Record<string, any>;
const format = await load('public/lib/format.js');
const communityView = await load('public/views/community.js');
const placeView = await load('public/views/place.js');
const shareView = await load('public/views/plan-shares.js');
const actions = await load('public/lib/actions.js');
const renderer = await load('public/lib/render.js');

test('community post and comment timestamps use one local-time formatter', () => {
  const previous = {
    principal: state.principal,
    currentView: state.currentView,
    communityPosts: state.communityPosts,
    communityMine: state.communityMine,
    postDetailId: state.postDetailId,
    postDetail: state.postDetail,
    postFavorites: state.postFavorites,
  };
  const instant = '2026-09-20T09:35:00+08:00';
  const expected = format.clockText(instant);
  const post = {
    id: 'time-post', text: '标题\n正文', nickname: '旅人', createdAt: instant,
    comments: [{ id: 'c1', nickname: '同行者', text: '评论', createdAt: instant, mine: false }],
    commentCount: 1, likes: 0, liked: false, mine: false,
  };
  try {
    state.principal = { kind: 'account', nickname: '旅人' };
    state.currentView = 'community';
    state.communityPosts = [post];
    state.communityMine = { posts: [post], places: [] };
    state.postFavorites = [];
    const feed = communityView.renderCommunity();
    assert.ok(feed.includes(expected), 'feed card time is formatted in local time');
    assert.ok(!feed.includes(instant), 'raw timestamp with source offset is not shown');

    state.postDetailId = 'time-post';
    state.postDetail = post;
    const detail = communityView.renderPostDetail();
    assert.ok(detail.includes(expected), 'post detail and comment time use the same local formatter');
    assert.match(detail, /<input(?=[^>]*\bdata-comment-draft\b)(?=[^>]*\bdata-post="time-post")[^>]*>/,
      'comment draft input is associated with this post independent of attribute order');
    assert.ok(detail.includes('data-comment-form'), 'comment entry is a submit-capable form');
    assert.ok(detail.includes('type="submit"'), 'comment form has a submit button for Enter');
  } finally {
    Object.assign(state, previous);
  }
});

test('guests can read public posts and post details while write controls remain present', () => {
  const previous = {
    principal: state.principal,
    currentView: state.currentView,
    communityPosts: state.communityPosts,
    communityMine: state.communityMine,
    postDetailId: state.postDetailId,
    postDetail: state.postDetail,
    postFavorites: state.postFavorites,
  };
  const post = {
    id: 'guest-readable-post', text: '公开标题\n公开正文', nickname: '旅人',
    createdAt: '2026-09-20T09:35:00+08:00', comments: [], commentCount: 0,
    likes: 0, liked: false, mine: false,
  };
  try {
    state.principal = { kind: 'guest' };
    state.currentView = 'community';
    state.communityPosts = [post];
    state.communityMine = { posts: [], places: [] };
    state.postFavorites = [];
    assert.match(communityView.renderCommunity(), /guest-readable-post|公开标题/);
    state.postDetailId = post.id;
    state.postDetail = post;
    const detail = communityView.renderPostDetail();
    assert.match(detail, /公开正文/);
    assert.match(detail, /data-action="submit-comment"/);
    assert.doesNotMatch(detail, /commentNick_|评论昵称|post-comment-nickname/);
    assert.equal((detail.match(/<input\b/g) || []).length, 1, 'guest composer only asks for comment content');

    // The server uses anonymous; old browser state may still carry a guest nickname.
    // Check both the main composer and replies rather than only an empty thread.
    const thread = {
      ...post,
      comments: [
        { id: 'floor-1', nickname: '楼主', text: '第一层评论', mine: false },
        { id: 'reply-1', nickname: '同行者', text: '已有回复', parentCommentId: 'floor-1', mine: false },
      ],
      commentCount: 2,
    };
    for (const principal of [null, { kind: 'anonymous' }, { kind: 'anonymous', nickname: '旧游客昵称' }, { kind: 'guest', nickname: '旧游客昵称' }]) {
      state.principal = principal;
      state.postDetail = thread;
      for (const html of [communityView.renderPostDetail(), communityView.postComments(thread, 'feed')]) {
        assert.doesNotMatch(html, /commentNick_|评论昵称|post-comment-nickname|旧游客昵称/);
        const forms = [...html.matchAll(/<form\b[^>]*\bdata-comment-form\b[^>]*>([\s\S]*?)<\/form>/g)];
        assert.equal(forms.length, 3, 'main comment and both replies remain available');
        for (const [, form] of forms) {
          assert.equal((form.match(/<input\b/g) || []).length, 1, 'every guest comment or reply only asks for content');
          assert.match(form, /data-comment-draft/);
        }
      }
    }
  } finally {
    Object.assign(state, previous);
  }
});

test('post detail rerenders preserve a typed comment draft while post data loads', () => {
  const previous = {
    principal: state.principal, currentView: state.currentView, trip: state.trip, savedPlans: state.savedPlans,
    postDetailId: state.postDetailId, postDetail: state.postDetail, loadStatus: state.loadStatus,
    commentDrafts: state.commentDrafts, document: globalThis.document, window: globalThis.window,
  };
  let draftInput: any = null;
  const nodes: Record<string, any> = {
    pageTitle: { textContent: '' }, pageSubtitle: { textContent: '' }, sidebarTrip: { innerHTML: '' },
  };
  const view = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(html: string) {
      this._html = html;
      draftInput = html.includes('data-comment-draft') ? { dataset: { post: 'draft-post' }, value: '' } : null;
    },
  };
  nodes.view = view;
  state.principal = { kind: 'account', nickname: '旅人' };
  state.currentView = 'post-detail';
  state.trip = null;
  state.savedPlans = [];
  state.postDetailId = 'draft-post';
  state.postDetail = { id: 'draft-post', text: '标题', nickname: '旅人', createdAt: '2026-09-20T00:00:00Z', comments: [], commentCount: 0, likes: 0, liked: false };
  state.loadStatus = {};
  state.commentDrafts = {};
  globalThis.document = {
    getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: (selector: string) => selector === '[data-comment-draft]' && draftInput ? [draftInput] : [],
    activeElement: null,
  } as unknown as Document;
  globalThis.window = { scrollTo: () => {} } as unknown as Window & typeof globalThis;

  try {
    renderer.render();
    assert.ok(draftInput);
    draftInput!.value = '还没发出的评论';
    // 模拟帖子详情请求完成，引发同一页面重新渲染。
    state.postDetail = { ...state.postDetail, comments: [{ id: 'loaded', nickname: '朋友', text: '刚加载的评论' }], commentCount: 1 };
    renderer.render();
    assert.equal(draftInput?.value, '还没发出的评论');
  } finally {
    Object.assign(state, previous);
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});

test('plan share withdrawal first opens a confirmation sheet', async () => {
  const previous = {
    principal: state.principal, planShares: state.planShares, fetch: globalThis.fetch,
    document: globalThis.document,
  };
  let requested = false;
  const title = { id: '', textContent: '撤回这份方案分享？' };
  const sheet = {
    innerHTML: '', scrollTop: 0, tabIndex: 0,
    querySelectorAll: () => [], querySelector: () => title, setAttribute: () => {}, removeAttribute: () => {}, focus: () => {},
  };
  const backdrop = { hidden: true };
  globalThis.document = {
    getElementById: (id: string) => id === 'sheet' ? sheet : id === 'sheetBackdrop' ? backdrop : null,
    querySelectorAll: () => [], activeElement: null, body: { style: { overflow: '' } },
  } as unknown as Document;
  globalThis.fetch = async () => { requested = true; throw new Error('withdraw must wait for confirmation'); };
  state.principal = { kind: 'account', nickname: '旅人' };
  state.planShares = [{ id: 'share-1', name: '周末路线', code: 'invalid', mine: true, stopCount: 2, cityLabel: '上海', localDate: '2026-09-20', nickname: '旅人', createdAt: '2026-09-19T00:00:00Z' }];

  try {
    const html = shareView.renderPlanShares();
    assert.ok(html.includes('data-action="ask-withdraw-plan-share" data-share="share-1"'));
    await actions.handleAction('ask-withdraw-plan-share', { dataset: { share: 'share-1' } });
    assert.ok(sheet.innerHTML.includes('confirm-withdraw-plan-share'));
    assert.ok(sheet.innerHTML.includes('data-share="share-1"'));
    assert.ok(sheet.innerHTML.includes('撤回后，其他旅人将无法再查看或导入'));
    assert.equal(requested, false, 'opening confirmation does not send the delete request');
  } finally {
    Object.assign(state, previous);
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
  }
});

test('place photos open in the app viewer and ignore external image/source links', () => {
  const previous = { places: state.places, placeDetailId: state.placeDetailId, trip: state.trip, community: state.community, savedPlans: state.savedPlans };
  state.trip = null;
  state.community = [];
  state.savedPlans = [];
  state.placeDetailId = 'photo-place';
  state.places = [{
    placeId: 'photo-place', name: '照片地点', category: 'landmark', address: '上海', description: '',
    facilityCodes: [], openingIntervals: [], tags: [], reviews: [],
    photos: [
      { src: '/images/places/cover.jpg', sourceUrl: 'https://example.com/source', caption: '封面照片', alt: '地点实拍' },
      { src: 'https://images.example.com/remote.jpg', caption: '远程照片', alt: '不应显示的网络图片' },
    ],
  }];
  try {
    const html = placeView.renderPlace();
    assert.ok(html.includes('class="place-photo-link" data-action="zoom-place-photo" data-image-src="/images/places/cover.jpg"'));
    assert.ok(!html.includes('href="/images/places/cover.jpg"'), 'ordinary photo activation must not leave the application');
    assert.equal((html.match(/class="place-photo-link"/g) || []).length, 1, 'only local photos appear in the gallery');
    assert.ok(!html.includes('https://example.com/source'));
    assert.ok(!html.includes('https://images.example.com/remote.jpg'));
    assert.ok(html.includes('查看大图'));
  } finally {
    Object.assign(state, previous);
  }
});

test('feed headings allow long unbroken titles to wrap inside narrow cards', async () => {
  const css = await readFile(join(process.cwd(), 'public/styles.css'), 'utf8');
  assert.match(css, /\.post-open-heading strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.post-open-heading strong\s*\{[^}]*min-width:\s*0/s);
});
