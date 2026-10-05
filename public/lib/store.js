/**
 * 前端状态与 DOM 取用。
 *
 * 只有一个可变的 `state` 对象，所有视图从它读、所有动作写它——
 * 这样"当前在哪个视图／哪趟旅行／有没有待确认提案"不会散落在各处。
 *
 * 注意：`state.principal` 目前只表示"是否已建立过会话"，服务端才是权威。
 */

export const state = {
  smartCompanion:null, smartCompanionStatus:'',
  achievements: null, achievementsOwner: '', achievementSelected: '', achievementFilter: 'all',
  principal: null, trips: [], trip: null, places: [], placesCursor: null, placesLoadingMore: false, placeMoreError: '', memories: [], memoriesScope: '',
  proposal: null, actionRequests: [], messages: [], currentView: 'home', navigationRevision: 0,
  scenePlaceId: '', sceneData: null, sceneSelectedHotspotId: '', sceneNarration: null, sceneStoryOpen: true, sceneFullscreenActive: false,
  sceneEntryPending: null, sceneEntryError: null,
  sceneReturnView: 'place', sceneVisited: [], sceneQuiet: false, scenePromptCount: 0,
  sceneLastPromptAt: 0, sceneSessionKey: '', sceneTimingCue: null, sceneTimingDismissedKey: '',
  sceneDepartureCue: null, sceneDepartureDismissedKey: '', agentDockOpen: false,
  agentContextExcludedRevision: -1,
  messagesCursor: null, messagesLoadingOlder: false, chatScrollRestore: null,
  agentConversationId: '', agentConversationOwner: '', agentConversations: [], agentConversationLoading: false, agentConversationError: '',
  chatCompanionPending: false,
  chatMessagePending: null,
  chatLastReceipt: null, agentTaskProgress: null,
  chatImages: [], chatImagesBusy: false,
  agentRemoteTask: null,
  agentInterruptedTask: null,
  agentResultTarget: null,
  agentViewSync: null,
  compareSelection: new Set(),
  lastMutation: null, ready: null, busy: false, chatRetry: null, placeQuery: '', placeCategory: '全部', postQuery: '', placeCity: '310100',
  communitySort: 'newest', communityCity: '', communityMine: null, communityPostFilter: 'all', planShareMineFilter: 'all', favoritePostDetails: {}, commentDrafts: {},
  postDetailId: '', postDetail: null, postReturnView: '', postReturnScrollY: 0,
  postSearching:false, postLoadingMore:false, postSearchError:'', postMoreError:'', postReturnAnchor:null, postFeedRestore:null,
  editingCommunityNickname: false,
  sessionRecoveryNotice: false,
  startupError: '',
  accountContextChanged: false,
  moderation: { authorized: false, queue: null, loading: false, error: '' },
  planShares: [], planShareCursor: null, planShareLoadingMore: false, planShareSearching: false, planShareQuery: '', geoLabel: '', geoAppbarText: '', postFavorites: [], stopModes: {}, placeDetailId: '', placeReturnView: '', placeReturnScrollY: 0,
  planHistory: [], planHistoryId: '', planHistoryDetail: null, planHistoryCursor: '', planHistoryLoading: false, planHistoryError: '',
  placeCatalog: [], placeCatalogStatus: '',
  placeDetailResource: null,
  myPlaceNotes: {},
  savedPlans: [], planDraft: null, planSharePreview: null, planViewDate: '', planDateSelectionRevision: 0, mountedDate: '', pendingMountedDate: '',
  companionPlanId: '', companionOwner: '', companionDepartureFallback: null, stopTransportPending: null,
  companionContext: null, companionLoading: false, companionQueryStage: '', companionError: '', companionFinishedPlan: null,
  companionNotice: '',
  journeyReviewPending: null,
  mapRouteView: 'endpoints',
  routeMode: 'walking', routeModeSelected: false,
  currentLocation: null, mapFrom: '', mapTo: '', mapCustomFrom: null, mapCustomTo: null, mapCity: '',
  homeFootprintOpen: false, footprintWeekStart: '',
  loadStatus: {},
  placeAdvanced: { facilities: [], cost: '', duration: '', rating: '' },
};

/** 按 id 取元素；调用点都在已知元素存在之后，取不到时返回 null 由调用方决定。 */
export const $ = (id) => document.getElementById(id);

export const tripId = () => state.trip?.trip?.tripId;
export const tripRevision = () => state.trip?.trip?.revision ?? 0;

/** 日计划是默认工作方式；旅行记录不能切换或限制页面功能。 */
export const usesSavedDayPlans = () => true;
