import { coordinatePlaceId } from '../domain/place-id.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PlaceProvider, PlaceSearchInput, PlaceSearchResult } from '../providers/travel.js';
import type { DemoPlace } from '../demo/demo-data.js';
import type { PlaceNumberRegistry } from './place-registry.js';
import { OFFICIAL_PLACE_TAGS, officialTagIds, customTagNames, placeTags } from '../domain/place-tags.js';
import { cityNameOf } from '../domain/cities.js';

const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];
type CoordinateCrs = 'WGS84' | 'GCJ02' | 'BD09';

function inputCoordinateCrs(value: unknown): CoordinateCrs {
  // Earlier API clients did not send a CRS; preserve their historical WGS84 contract.
  if (value === undefined || value === null || value === '') return 'WGS84';
  if (value === 'WGS84' || value === 'GCJ02' || value === 'BD09') return value;
  throw new Error('请选择有效的坐标系。');
}

function toCanonicalCoordinates(lat: number, lng: number, crs: CoordinateCrs) {
  if (crs === 'WGS84') return { lat, lng };
  const source = crs === 'GCJ02' ? gcoord.GCJ02 : gcoord.BD09;
  const [canonicalLng, canonicalLat] = gcoord.transform([lng, lat], source, gcoord.WGS84);
  return { lat: canonicalLat, lng: canonicalLng };
}

interface Review { actorId: string; nickname: string; rating: number; text: string; createdAt: string }
interface PostComment {
  id: string; actorId: string; nickname: string; text: string; createdAt: string;
  parentCommentId?: string; deleted?: boolean;
}
interface PlaceRefSnapshot { placeId: string; name: string }
interface StoredPostImage { id: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; alt: string; data: string }
interface SharedJourneyMemoryPlace { name: string; visitMinutes: number | null }
interface SharedJourneyMemory {
  currentCity: string; localDate: string; elapsedMinutes: number | null; places: SharedJourneyMemoryPlace[];
}
interface Report { actorId: string; reason: string; createdAt: string }
interface DecisionLogEntry { at: string; targetId: string; targetName: string; decision: 'approved' | 'rejected'; note: string }
interface Post {
  id: string; authorId: string; nickname: string; text: string; createdAt: string;
  visibility?: 'public' | 'private';
  likedBy: string[]; comments: PostComment[]; sample: boolean; placeRef: PlaceRefSnapshot | null;
  placeRefs?: PlaceRefSnapshot[]; images?: StoredPostImage[];
  journeyMemory?: SharedJourneyMemory;
}
interface PostPageCursor { createdAt: string; id: string; query?: string }

const MAX_POST_PLACE_REFS = 12;
const MAX_POST_IMAGES = 4;
const MAX_POST_IMAGE_BYTES = 400_000;
const MAX_POST_IMAGES_BYTES = 1_200_000;

function normalizePostPlaceRefs(value: unknown, legacyValue?: unknown): PlaceRefSnapshot[] {
  const source = value === undefined ? (legacyValue ? [legacyValue] : []) : value;
  if (!Array.isArray(source)) throw new Error('关联地点格式无效。');
  if (source.length > MAX_POST_PLACE_REFS) throw new Error(`一篇帖子最多关联 ${MAX_POST_PLACE_REFS} 个地点。`);
  const seen = new Set<string>();
  const result: PlaceRefSnapshot[] = [];
  for (const candidate of source) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('关联地点格式无效。');
    const item = candidate as Record<string, unknown>;
    if (typeof item.placeId !== 'string' || !item.placeId.trim() || typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error('关联地点信息不完整。');
    }
    const placeId = item.placeId.trim().slice(0, 120);
    if (seen.has(placeId)) continue;
    seen.add(placeId);
    result.push({ placeId, name: item.name.trim().slice(0, 120) });
  }
  return result;
}

export function normalizePostImages(value: unknown): StoredPostImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_POST_IMAGES) throw new Error(`一篇帖子最多上传 ${MAX_POST_IMAGES} 张照片。`);
  let totalBytes = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('帖子照片格式无效。');
    const image = entry as Record<string, unknown>;
    const match = typeof image.dataUrl === 'string'
      ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl)
      : null;
    if (!match) throw new Error('请上传 JPG、PNG 或 WebP 照片。');
    const mimeType = match[1] as StoredPostImage['mimeType'];
    const encoded = match[2];
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded || bytes.byteLength > MAX_POST_IMAGE_BYTES) {
      throw new Error('单张照片不能超过 400 KB，请重新选择。');
    }
    const validSignature = mimeType === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!validSignature) throw new Error('照片内容和文件格式不一致，请重新选择。');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_POST_IMAGES_BYTES) throw new Error('照片总大小不能超过 1.2 MB，请移除部分照片。');
    const alt = typeof image.alt === 'string' ? image.alt.trim().slice(0, 120) : '';
    return { id: randomUUID(), mimeType, alt: alt || `旅行照片 ${index + 1}`, data: encoded };
  });
}

function comparePostPageOrder(a: Pick<Post, 'createdAt' | 'id'>, b: Pick<Post, 'createdAt' | 'id'>) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

function encodePostPageCursor(post: Pick<Post, 'createdAt' | 'id'>, query = '') {
  return `p1.${Buffer.from(JSON.stringify({ createdAt: post.createdAt, id: post.id, ...(query ? { query } : {}) })).toString('base64url')}`;
}

function decodePostPageCursor(value: string): PostPageCursor {
  try {
    if (!value.startsWith('p1.')) throw new Error('invalid prefix');
    const decoded = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' || !decoded.id || (decoded.query !== undefined && typeof decoded.query !== 'string')) throw new Error('invalid payload');
    return { createdAt: decoded.createdAt, id: decoded.id, query: decoded.query as string | undefined };
  } catch {
    throw new Error('帖子分页游标无效，请刷新列表后重试。');
  }
}
export class CommunityReviewConflictError extends Error {}

interface Discovery {
  submissionVersion?: number;
  officialTagIds?: string[]; customTags?: string[];
  placeId?: string;
  id: string; authorId: string; nickname: string; name: string; cityCode: string; address: string;
  description: string; reservationHint?: string; lat: number | null; lng: number | null; createdAt: string;
  /** Stored coordinates are canonical WGS84; legacy records without this marker stay unverified. */
  coordinateCrs?: 'WGS84' | 'unknown';
  status: 'shared' | 'pending' | 'approved' | 'rejected'; evidence: string; decisionNote: string;
  reviews: Review[]; sample: boolean; reports: Report[];
}
const requiredText = (value: unknown, label: string, max: number) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error(`${label}需填写 1–${max} 个字。`);
  return text;
};

export function sharedJourneyMemory(value: unknown): SharedJourneyMemory | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旅行记忆格式无效。');
  const input = value as Record<string, unknown>;
  const currentCity = typeof input.currentCity === 'string' ? input.currentCity.trim().slice(0, 60) : '';
  const localDate = requiredText(input.localDate, '旅行日期', 10);
  const dateTime = Date.parse(`${localDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isFinite(dateTime) || new Date(dateTime).toISOString().slice(0, 10) !== localDate) {
    throw new Error('旅行日期格式无效。');
  }
  let elapsedMinutes: number | null;
  if (input.elapsedMinutes === null) elapsedMinutes = null;
  else if (Number.isSafeInteger(input.elapsedMinutes) && Number(input.elapsedMinutes) >= 0 && Number(input.elapsedMinutes) <= 100_000) elapsedMinutes = Number(input.elapsedMinutes);
  else throw new Error('旅行用时格式无效。');
  if (!Array.isArray(input.places) || input.places.length < 1 || input.places.length > 40) throw new Error('旅行地点数量无效。');
  const places = input.places.map((value): SharedJourneyMemoryPlace => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旅行地点格式无效。');
    const place = value as Record<string, unknown>;
    const name = requiredText(place.name, '地点名称', 120);
    let visitMinutes: number | null;
    if (place.visitMinutes === null) visitMinutes = null;
    else if (Number.isSafeInteger(place.visitMinutes) && Number(place.visitMinutes) >= 0 && Number(place.visitMinutes) <= 100_000) visitMinutes = Number(place.visitMinutes);
    else throw new Error('地点停留时间格式无效。');
    return { name, visitMinutes };
  });
  return { currentCity, localDate, elapsedMinutes, places };
}

interface DecodedPlanShare {
  name: string;
  cityLabel: string;
  cityCode: string;
  localDate?: string;
  stopCount: number;
  stops: Array<{ name: string; lat: number; lng: number; cityCode?: string }>;
  version: number;
}

export function decodePlanShareCode(value: unknown): DecodedPlanShare {
  const code = requiredText(value, '方案码', 60_000);
  const joined = code.split(/\s+|-/).filter(Boolean).join('');
  if (joined.slice(0, 3).toUpperCase() !== 'BT1' || joined.length < 6) throw new Error('方案码格式无效。');
  const body = joined.slice(3, -2);
  const suppliedChecksum = joined.slice(-2);
  let checksum = 0;
  for (const char of body) checksum += char.charCodeAt(0);
  const expectedChecksum = (checksum % 1296).toString(36).toUpperCase().padStart(2, '0');
  if (suppliedChecksum !== expectedChecksum || !/^[A-Za-z0-9+/]+$/.test(body)) throw new Error('方案码校验失败。');

  let payload: unknown;
  try {
    const bytes = Buffer.from(body, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== body) throw new Error('invalid base64');
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('方案码内容无法解析。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('方案码内容无效。');
  const data = payload as Record<string, unknown>;
  if (data.v !== 1 && data.v !== 2 && data.v !== 3) throw new Error('方案码版本无效。');
  if (typeof data.n !== 'string' || !data.n.trim() || data.n.length > 60 || !/^\d{6}$/.test(String(data.c)) || typeof data.cn !== 'string' || data.cn.length > 20) {
    throw new Error('方案码缺少有效的名称或城市信息。');
  }

  const readStops = (value: unknown, allowEmpty = false) => {
    if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error('方案码至少需要一个有效地点。');
    const stops: DecodedPlanShare['stops'] = [];
    for (const stop of value) {
      if (!stop || typeof stop !== 'object' || Array.isArray(stop)) throw new Error('方案码中的地点信息无效。');
      const item = stop as Record<string, unknown>;
      if (typeof item.n !== 'string' || !item.n.trim() || item.n.length > 120 ||
        typeof item.la !== 'number' || !Number.isFinite(item.la) || Math.abs(item.la) > 90 ||
        typeof item.ln !== 'number' || !Number.isFinite(item.ln) || Math.abs(item.ln) > 180 ||
        (item.crs !== undefined && item.crs !== 'GCJ02' && item.crs !== 'WGS84') ||
        (item.cc !== undefined && (typeof item.cc !== 'string' || !/^\d{6}$/.test(item.cc))) ||
        (item.a !== undefined && (typeof item.a !== 'number' || !Number.isInteger(item.a) || item.a < 0 || item.a > 2879)) ||
        (item.m !== undefined && (typeof item.m !== 'number' || !Number.isFinite(item.m) || item.m < 1 || item.m > 1440))) {
        throw new Error('方案码中的地点信息无效。');
      }
      stops.push({ name: item.n, lat: item.la, lng: item.ln, ...(typeof item.cc === 'string' && item.cc !== '000000' ? { cityCode: item.cc } : {}) });
    }
    return stops;
  };

  const stops: DecodedPlanShare['stops'] = [];
  let stopCount = 0;
  let localDate: string | undefined;
  const readLocalDate = (value: unknown) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new Error('方案码中的出行日期无效。');
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
      throw new Error('方案码中的出行日期无效。');
    }
    return value;
  };
  if (data.v === 1 || (data.v === 3 && !Array.isArray(data.days))) {
    stops.push(...readStops(data.s));
    stopCount = stops.length;
    if (stopCount > 200) throw new Error('方案最多分享 200 个地点。');
    localDate = readLocalDate(data.d);
  } else {
    if (!Array.isArray(data.days) || !data.days.length) throw new Error('多日方案码至少需要一天。');
    if (data.days.length > 31) throw new Error('方案最多分享 31 天。');
    for (const day of data.days) {
      if (!day || typeof day !== 'object' || Array.isArray(day)) throw new Error('多日方案码中的日期安排无效。');
      const dayStops = readStops((day as Record<string, unknown>).s, true);
      stops.push(...dayStops);
      stopCount += dayStops.length;
      if (stopCount > 200) throw new Error('方案最多分享 200 个地点。');
    }
    if (!stopCount) throw new Error('方案码至少需要一个有效地点。');
    localDate = readLocalDate(data.d);
  }
  const placeCities = [...new Set(stops.map(stop => stop.cityCode).filter((code): code is string => Boolean(code)))];
  const cityCode = placeCities.length === 1 ? placeCities[0] : String(data.c);
  const cityLabel = placeCities.length > 1 ? '多地'
    : placeCities.length === 1 && cityCode !== String(data.c)
      ? (cityNameOf(cityCode) || '城市待核实')
      : data.cn;
  return { name: data.n, cityCode, cityLabel, ...(localDate ? { localDate } : {}), stopCount, stops, version: Number(data.v) };
}
/** 展示昵称：优先用当次输入，否则回退到账号昵称（由路由传入），都不存在时仍要求填写。 */
const displayNickname = (input: Record<string, unknown>, fallback: unknown) => {
  const provided = typeof input.nickname === 'string' ? input.nickname.trim() : '';
  return provided || (typeof fallback === 'string' ? fallback.trim() : '');
};

/** 样例内容种子：全部经由 publish/review/submit/decide/publishPost 等常规校验路径写入。 */
export interface SamplePlaceSeed {
  authorId: string; input: Record<string, unknown>; minutesAgo: number;
  reviews?: { actorId: string; input: Record<string, unknown>; minutesAgo: number }[];
  submit?: { input: Record<string, unknown> } | null;
  decision?: { decision: 'approved' | 'rejected'; note: string } | null;
}
export interface SamplePostSeed {
  authorId: string; nickname: string; text: string; minutesAgo: number;
  likedBy?: string[];
  comments?: { actorId: string; nickname: string; text: string; minutesAgo: number }[];
  placeRef?: PlaceRefSnapshot | null;
}

interface PlanShare { id: string; shareCode?: string; authorId: string; nickname: string; code: string; name: string; cityLabel: string; cityCode: string; localDate?: string; stopCount: number; createdAt: string }

function shortPlanShareCode(id: string) {
  const token = id.replace(/^share_/, '').replace(/[^a-f0-9]/gi, '').slice(0, 10).toUpperCase();
  return `BT-${token}`;
}

function normalizedPlanCode(value: string) {
  return value.replace(/[\s-]/g, '').toUpperCase();
}
/** 官方目录地点的用户评价：按地点 ID 归档，与社区分享的评价（挂在分享 ID 下）并存。 */
interface PlaceReview { actorId: string; nickname: string; rating: number; text: string; createdAt: string }

export class CommunityService {
  private discoveries: Discovery[] = [];
  private posts: Post[] = [];
  private contributions: Record<string, Record<string, string[]>> = {};
  /** 按用户按地点的私有备注（每个用户每个地点一条）。 */
  private placeNotes: Record<string, Record<string, string>> = {};
  private samplesClearedFlag = false;
  private decisions: DecisionLogEntry[] = [];
  private planShares: PlanShare[] = [];
  private placeReviewMap: Record<string, PlaceReview[]> = {};
  private retiredPlaceIds = new Set<string>();
  private registry: PlaceNumberRegistry | null = null;
  constructor(private readonly now = () => new Date().toISOString(), registry?: PlaceNumberRegistry) {
    this.registry = registry ?? null;
  }
  private promoteReviews(item: Discovery) {
    if (item.status !== 'approved' || !item.placeId || !item.reviews.length) return;
    const saved = this.placeReviewMap[item.placeId] ?? (this.placeReviewMap[item.placeId] = []);
    for (const review of item.reviews) {
      const existingIndex = saved.findIndex(existing => existing.actorId === review.actorId);
      if (existingIndex < 0) saved.push({ ...review });
      else if (Date.parse(review.createdAt) > Date.parse(saved[existingIndex].createdAt)) saved[existingIndex] = { ...review };
    }
    item.reviews = [];
  }
  approvedPlaces(input?: PlaceSearchInput, actorId = ''): DemoPlace[] {
    return this.discoveries.filter(item => {
      if (item.status !== 'approved') return false;
      if (!input) return true;
      // 用户标签只参与本人搜索，平台标签仍对所有人可见。
      const labels = placeTags({ ...item, customTags: this.myTags(item.placeId ?? item.id, actorId) }).map(tag => tag.label).join(' ');
      const text = `${item.name} ${item.address} ${item.description} ${labels}`;
      // 空城市代码＝不过滤（目录“全部城市”视图）。
      const cityOk = !input.cityCode || item.cityCode === input.cityCode;
      return cityOk
        && (!input.query || text.toLowerCase().includes(input.query.toLowerCase()))
        && (!input.category || (item.officialTagIds || []).includes(input.category));
    }).map(item => ({
      placeId:item.placeId ?? item.id, name:item.name, provider:'community_reviewed',
      // 收录前后的个人标签只返回给添加标签的账号。
      customTags:this.myTags(item.placeId ?? item.id, actorId),
      placeNo:this.registry?.numberOf(item.placeId ?? item.id),
      category:item.officialTagIds?.find(id => ['landmark','culture','food','rest'].includes(id)) || 'unknown',
      cityCode:item.cityCode, address:item.address,
      description:item.description, reservationHint:item.reservationHint, createdAt:item.createdAt,
      officialTagIds:[...(item.officialTagIds || [])],
      coordinates:item.lat !== null && item.lng !== null && item.coordinateCrs === 'WGS84' ? {lat:item.lat, lng:item.lng, source:'community'} : null,
      facilityCodes:[], evidenceIds:[], suggestedDurationMinutes:null, openingIntervals:[],
    }));
  }
  serialize() { return JSON.stringify({ posts: this.posts, discoveries: this.discoveries, contributions: this.contributions, placeNotes: this.placeNotes, samplesCleared: this.samplesClearedFlag, decisions: this.decisions, planShares: this.planShares, placeReviews: this.placeReviewMap, retiredPlaceIds: [...this.retiredPlaceIds] }); }
  loadSerialized(value: string) {
    const data = JSON.parse(value);
    this.posts = Array.isArray(data) ? [] : data.posts || [];
    this.discoveries = Array.isArray(data) ? data : data.discoveries;
    this.contributions = Array.isArray(data) ? {} : data.contributions || {};
    this.placeNotes = data.placeNotes || {};
    this.samplesClearedFlag = !Array.isArray(data) && data.samplesCleared === true;
    this.decisions = !Array.isArray(data) && Array.isArray(data.decisions) ? data.decisions : [];
    this.planShares = !Array.isArray(data) && Array.isArray(data.planShares) ? data.planShares : [];
    this.placeReviewMap = !Array.isArray(data) && data.placeReviews && typeof data.placeReviews === 'object' ? data.placeReviews : {};
    this.retiredPlaceIds = new Set(!Array.isArray(data) && Array.isArray(data.retiredPlaceIds)
      ? data.retiredPlaceIds.filter((id: unknown): id is string => typeof id === 'string')
      : []);
    // 旧落盘数据没有点赞/评论/样例字段；恢复时补默认值，避免历史库读崩。
    for (const post of this.posts) {
      post.likedBy = Array.isArray(post.likedBy) ? post.likedBy.filter((id) => typeof id === 'string') : [];
      post.comments = Array.isArray(post.comments) ? post.comments : [];
      for (const comment of post.comments) {
        if (typeof comment.parentCommentId !== 'string') delete comment.parentCommentId;
        if (comment.deleted !== true) delete comment.deleted;
      }
      post.sample = post.sample === true;
      // 历史帖子沿用公开状态；已记录但不识别的值按私密恢复，避免意外公开。
      post.visibility = post.visibility === undefined || post.visibility === 'public' ? 'public' : 'private';
      try { post.placeRefs = normalizePostPlaceRefs(post.placeRefs, post.placeRef); }
      catch { post.placeRefs = []; }
      post.placeRef = post.placeRefs[0] ?? null;
      let imageBytes = 0;
      post.images = (Array.isArray(post.images) ? post.images.slice(0, MAX_POST_IMAGES) : []).filter((image): image is StoredPostImage => {
        if (!image || typeof image.id !== 'string' || !image.id ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) ||
          typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return false;
        const bytes = Buffer.from(image.data, 'base64');
        if (!bytes.length || bytes.toString('base64') !== image.data || bytes.byteLength > MAX_POST_IMAGE_BYTES ||
          imageBytes + bytes.byteLength > MAX_POST_IMAGES_BYTES) return false;
        imageBytes += bytes.byteLength;
        return true;
      });
      try {
        const journeyMemory = sharedJourneyMemory(post.journeyMemory);
        if (journeyMemory) post.journeyMemory = journeyMemory;
        else delete post.journeyMemory;
      } catch { delete post.journeyMemory; }
    }
    for (const item of this.discoveries) {
      item.coordinateCrs = item.coordinateCrs === 'WGS84' ? 'WGS84' : 'unknown';
      item.sample = item.sample === true;
      item.reports = Array.isArray(item.reports) ? item.reports : [];
      item.reviews = Array.isArray(item.reviews) ? item.reviews : [];
      this.promoteReviews(item);
    }
  }
  myTags(id: string, actorId: string) {
    if (!actorId) return [];
    const own = this.discoveries.find(item => item.authorId === actorId && (item.id === id || item.placeId === id));
    return [...new Set([...(own?.customTags || []), ...(this.contributions[id]?.[actorId] || [])])];
  }
  hasMatchingTag(query: string, actorId = '') {
    const privateIds = new Set(this.discoveries.filter(item => item.status !== 'approved')
      .flatMap(item => [item.id, ...(item.placeId ? [item.placeId] : [])]));
    const visibleIds = new Set(this.discoveries.filter(item => item.status === 'approved')
      .flatMap(item => [item.id, ...(item.placeId ? [item.placeId] : [])]));
    // Official catalog tags may be attached to any official place ID; exclude only IDs
    // that belong to an unapproved community share so hidden recommendations stay private.
    return [...new Set([...visibleIds, ...Object.keys(this.contributions).filter(id => !privateIds.has(id))])]
      .some(id => this.myTags(id, actorId).some(tag => tag.toLowerCase().includes(query.toLowerCase())));
  }
  myNote(id: string, actorId: string) {
    if (!actorId) return '';
    return this.placeNotes[id]?.[actorId] || '';
  }
  saveNote(id: string, actorId: string, value: unknown) {
    const note = typeof value === 'string' ? value.trim().slice(0, 500) : '';
    this.placeNotes[id] ??= {}; this.placeNotes[id][actorId] = note; return { note };
  }
  saveTags(id: string, actorId: string, value: unknown) {
    const tags = customTagNames(value);
    const own = this.discoveries.find(item => item.id === id && item.authorId === actorId);
    if (own) own.customTags = [];
    this.contributions[id] ??= {}; this.contributions[id][actorId] = tags; return { customTags: tags };
  }
  private find(id: string) {
    const item = this.discoveries.find((place) => place.id === id);
    if (!item) throw new Error('找不到这个社区地点。');
    return item;
  }
  canView(id: string, actorId: string) {
    const item = this.find(id);
    return item.status === 'approved' || item.authorId === actorId;
  }
  private findPost(id: string, actorId: string) {
    const post = this.posts.find((item) => item.id === id && this.canReadPost(item, actorId));
    if (!post) throw new Error('找不到这条帖子。');
    return post;
  }
  private canReadPost(post: Post, actorId: string) {
    return post.visibility !== 'private' || post.authorId === actorId;
  }
  canReadPostSnapshot(id: string, actorId: string) {
    const post = this.posts.find(item => item.id === id);
    // 原帖撤回后的公开快照仍可保留；当前私密帖不能透过旧快照访问。
    return !post || this.canReadPost(post, actorId);
  }
  postDetail(id: string, actorId: string) {
    const post = this.posts.find((item) => item.id === id);
    return post && this.canReadPost(post, actorId) ? this.postView(post, actorId) : null;
  }
  postImage(postId: string, imageId: string, actorId = '') {
    const post = this.posts.find(item => item.id === postId && this.canReadPost(item, actorId));
    const image = post?.images?.find(item => item.id === imageId);
    return image ? { mimeType: image.mimeType, data: Buffer.from(image.data, 'base64') } : null;
  }
  private view(item: Discovery, actorId: string) {
    const { authorId, reviews, reports, ...publicFields } = item;
    // Do not leak the submitter's raw tag field: custom tags are private per actor
    // and are exposed only through the actor-scoped `tags` value below.
    delete publicFields.customTags;
    const visibleReviews = item.status === 'approved' && item.placeId
      ? this.placeReviewMap[item.placeId] ?? reviews
      : reviews;
    return { ...publicFields, placeNo: item.status === 'approved' ? this.registry?.numberOf(item.placeId ?? item.id) : undefined,
      coordinateNeedsVerification: item.lat !== null && item.lng !== null && item.coordinateCrs !== 'WGS84',
      tags: placeTags({ ...item, customTags: this.myTags(item.placeId ?? item.id, actorId) }), mine: authorId === actorId,
      reported: reports.some((r) => r.actorId === actorId),
      reviewCount: visibleReviews.length, rating: visibleReviews.length ? visibleReviews.reduce((sum, r) => sum + r.rating, 0) / visibleReviews.length : null,
      reviews: visibleReviews.map(({ actorId: reviewerId, ...review }) => ({ ...review, mine: reviewerId === actorId })) };
  }
  private postView(post: Post, actorId: string) {
    const { authorId, likedBy, comments, images, placeRef, placeRefs, ...publicFields } = post;
    const linkedPlaces = placeRefs ?? (placeRef ? [placeRef] : []);
    return { ...publicFields, visibility: post.visibility || 'public', mine: authorId === actorId,
      placeRef: linkedPlaces[0] ?? null, placeRefs: linkedPlaces,
      images: (images || []).map(({ id, mimeType, alt }) => ({ id, mimeType, alt })),
      likes: likedBy.length, liked: likedBy.includes(actorId),
      commentCount: comments.length,
      comments: comments.map(({ actorId: commentId, ...comment }) => ({ ...comment, mine: commentId === actorId })) };
  }

  // —— 旅行帖子 ——

  private orderedPosts() {
    return [...this.posts].sort(comparePostPageOrder);
  }
  listPosts(actorId: string, query = '') {
    const search = this.postSearchQuery(query);
    return [...this.posts].reverse().filter(post => post.visibility !== 'private' &&
      (!search || `${post.text} ${post.nickname}`.toLowerCase().includes(search))).map(post => this.postView(post, actorId));
  }
  private postSearchQuery(value: unknown) {
    if (typeof value !== 'string' || value.length > 10000) throw new Error('帖子搜索内容需为不超过 10000 字的文字。');
    return value.trim().toLowerCase();
  }
  listPostPage(actorId: string, cursor: string | null, limit: number, query = '') {
    const search = this.postSearchQuery(query);
    const boundary = cursor ? decodePostPageCursor(cursor) : null;
    if (boundary && (boundary.query || '') !== search) throw new Error('帖子搜索条件已变化，请重新搜索后再加载更多。');
    const candidates = this.orderedPosts().filter(post => post.visibility !== 'private' &&
      (!search || `${post.text} ${post.nickname}`.toLowerCase().includes(search)) && (!boundary || comparePostPageOrder(post, boundary) > 0));
    const page = candidates.slice(0, limit + 1);
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    return {
      items: page.map(post => this.postView(post, actorId)),
      nextCursor: hasMore && page.length ? encodePostPageCursor(page[page.length - 1], search) : null,
    };
  }
  publishPost(actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    if (input.visibility !== undefined && input.visibility !== 'public' && input.visibility !== 'private') throw new Error('请选择公开或仅自己可见。');
    let placeRefs: PlaceRefSnapshot[];
    if (input.placeRefs !== undefined && input.placeRefs !== null) {
      placeRefs = normalizePostPlaceRefs(input.placeRefs);
    } else {
      try { placeRefs = normalizePostPlaceRefs(undefined, input.placeRef); }
      catch { placeRefs = []; }
    }
    const images = normalizePostImages(input.images);
    const journeyMemory = sharedJourneyMemory(input.journeyMemory);
    const post: Post = { id: `post_${randomUUID()}`, authorId: actorId, nickname: requiredText(displayNickname(input, fallbackNickname), '昵称', 30),
      visibility: input.visibility === 'private' ? 'private' : 'public',
      text: requiredText(input.text, '帖子内容', 10000), createdAt: this.now(), likedBy: [], comments: [], sample: false,
      placeRef: placeRefs[0] ?? null, placeRefs, images,
      ...(journeyMemory ? { journeyMemory } : {}) };
    this.posts.push(post); return this.postView(post, actorId);
  }
  removePost(actorId: string, id: string) {
    const post = this.posts.find(item => item.id === id);
    if (!post || post.authorId !== actorId) throw new Error('只能撤回自己发布的帖子。');
    this.posts = this.posts.filter(item => item.id !== id); return {removed: true};
  }
  updatePostVisibility(actorId: string, id: string, visibility: unknown) {
    const post = this.findPost(id, actorId);
    if (post.authorId !== actorId) throw new Error('只能修改自己帖子的可见范围。');
    if (visibility !== 'public' && visibility !== 'private') throw new Error('请选择公开或仅自己可见。');
    post.visibility = visibility;
    return this.postView(post, actorId);
  }
  likePost(actorId: string, id: string) {
    const post = this.findPost(id, actorId);
    post.likedBy = post.likedBy.includes(actorId) ? post.likedBy.filter(id => id !== actorId) : [...post.likedBy, actorId];
    return { liked: post.likedBy.includes(actorId), likes: post.likedBy.length };
  }
  addComment(actorId: string, id: string, input: Record<string, unknown>, fallbackNickname = '') {
    const post = this.findPost(id, actorId);
    const rawParentId = input.parentCommentId;
    if (rawParentId !== undefined && rawParentId !== null && typeof rawParentId !== 'string') {
      throw new Error('回复对象无效。');
    }
    const parentCommentId = typeof rawParentId === 'string' ? rawParentId.trim() : '';
    if (parentCommentId) {
      const parent = post.comments.find(item => item.id === parentCommentId);
      if (!parent) throw new Error('找不到要回复的评论。');
      if (parent.deleted) throw new Error('这条评论已删除，无法回复。');
    }
    const comment: PostComment = { id: `comment_${randomUUID()}`, actorId,
      nickname: requiredText(displayNickname(input, fallbackNickname), '昵称', 30), text: requiredText(input.text, '评论', 1000), createdAt: this.now(),
      ...(parentCommentId ? { parentCommentId } : {}) };
    post.comments.push(comment); return this.postView(post, actorId);
  }
  removeComment(actorId: string, postId: string, commentId: string) {
    const post = this.findPost(postId, actorId);
    const comment = post.comments.find(item => item.id === commentId);
    if (!comment || comment.actorId !== actorId) throw new Error('只能删除自己的评论。');
    if (post.comments.some(item => item.parentCommentId === commentId)) {
      // 保留楼中回复；只隐藏原评论正文，避免删除别人的回复或留下无上下文的楼层。
      comment.deleted = true;
      comment.nickname = '已删除';
      comment.text = '';
    } else {
      post.comments = post.comments.filter(item => item.id !== commentId);
    }
    return this.postView(post, actorId);
  }

  // —— 我的发布 ——

  mine(actorId: string) {
    return {
      posts: [...this.posts].reverse().filter(post => post.authorId === actorId).map(post => this.postView(post, actorId)),
      places: [...this.discoveries].reverse().map(item => this.view(item, actorId)).filter(item => item.mine),
      planShares: this.listPlanShares(actorId).filter(share => share.mine),
    };
  }

  /** 帖子快照（收藏用）；帖子不存在时返回 null。 */
  postSnapshot(id: string, actorId = '') {
    const post = this.posts.find(item => item.id === id);
    if (!post || !this.canReadPost(post, actorId)) return null;
    const [firstLine = '', ...remainingLines] = post.text.split(/\r?\n/);
    const body = [...(firstLine.length > 60 ? [firstLine.slice(60)] : []), ...remainingLines].join('\n');
    return { postId: post.id, nickname: post.nickname, title: firstLine.slice(0, 60), body, createdAt: post.createdAt, source: 'active' as const };
  }

  // —— 行程方案分享（方案码） ——

  listPlanShares(actorId: string, query = '') {
    const search = query.trim();
    const codeSearch = normalizedPlanCode(search);
    return [...this.planShares].reverse().map(({ authorId, ...share }) => ({
      ...share,
      shareCode: /^BT-[A-F0-9]{10}$/.test(String(share.shareCode || '')) ? share.shareCode! : shortPlanShareCode(share.id),
      mine: authorId === actorId,
    })).filter(share => {
      if (!search) return true;
      if (search.toLowerCase() === share.id.toLowerCase() ||
        codeSearch === normalizedPlanCode(share.shareCode) || codeSearch === normalizedPlanCode(share.code)) return true;
      if (/^BT(?:1)?[-\s]/i.test(search)) return false;
      const text = `${share.name} ${share.nickname}`.toLocaleLowerCase();
      return text.includes(search.toLocaleLowerCase());
    });
  }
  publishPlanShare(actorId: string, input: Record<string, unknown>, resolvedCity?: { cityCode: string; cityLabel: string }) {
  const code = requiredText(input.code, '方案码', 60_000);
    const decoded = decodePlanShareCode(code);
    const name = requiredText(input.name, '方案名称', 60);
    const cityLabel = requiredText(resolvedCity?.cityLabel ?? input.cityLabel, '城市', 20);
    const cityCode = requiredText(resolvedCity?.cityCode ?? input.cityCode, '城市代码', 6);
    const submittedDate = input.localDate === undefined || input.localDate === null || input.localDate === ''
      ? undefined
      : requiredText(input.localDate, '出行日期', 10);
    if (name !== decoded.name || (!resolvedCity && (cityLabel !== decoded.cityLabel || cityCode !== decoded.cityCode)) ||
      submittedDate !== decoded.localDate || input.stopCount !== decoded.stopCount) {
      throw new Error('分享信息与方案码内容不一致，请重新生成后再发布。');
    }
    let id = '';
    let shareCode = '';
    do {
      id = `share_${randomUUID()}`;
      shareCode = shortPlanShareCode(id);
    } while (this.planShares.some(item => shortPlanShareCode(item.id) === shareCode || item.shareCode === shareCode));
    const share: PlanShare = { id, shareCode, authorId: actorId,
      nickname: requiredText(input.nickname, '昵称', 30),
      code, name, cityLabel, cityCode,
      ...(decoded.localDate ? { localDate: decoded.localDate } : {}),
      stopCount: decoded.stopCount,
      createdAt: this.now() };
    if (this.planShares.some(item => item.authorId === actorId && item.code === code)) throw new Error('这个方案码你已经分享过了。');
    this.planShares.push(share);
    return share;
  }
  removePlanShare(actorId: string, id: string) {
    const share = this.planShares.find(item => item.id === id);
    if (!share || share.authorId !== actorId) throw new Error('只能撤回自己分享的方案。');
    this.planShares = this.planShares.filter(item => item.id !== id);
    return { removed: true };
  }

  // —— 地点发现 ——

  list(actorId: string, query = '', tag = '', opts: { city?: string; sort?: string } = {}) {
    const items = [...this.discoveries].filter(item => item.status === 'approved').reverse().map(item => this.view(item, actorId))
      .filter(item => (!opts.city || item.cityCode === opts.city)
        && (!tag || item.tags.some(t => t.source === 'official' && t.id === tag))
        && `${item.name} ${item.address} ${item.description} ${item.tags.map(t => t.label).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    const byNewest = (a: ReturnType<CommunityService['view']>, b: ReturnType<CommunityService['view']>) => b.createdAt.localeCompare(a.createdAt);
    if (opts.sort === 'rating') items.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.reviewCount - a.reviewCount || byNewest(a, b));
    else if (opts.sort === 'reviews') items.sort((a, b) => b.reviewCount - a.reviewCount || byNewest(a, b));
    else items.sort(byNewest);
    return items;
  }
  detail(id: string, actorId: string) { return this.view(this.find(id), actorId); }
  ownDiscoveries(actorId: string) {
    return this.discoveries.filter(item => item.authorId === actorId).slice().reverse().map(item => this.view(item, actorId));
  }
  remove(id: string, actorId: string) {
    const item = this.find(id);
    if (item.authorId !== actorId) throw new Error('只有发布者可以撤回自己的分享。');
    if (item.status === 'approved' && item.placeId) {
      // 收录地点撤回后退役其坐标 ID，防止同坐标的新分享继承旧评价或用户标签。
      this.retiredPlaceIds.add(item.placeId);
      delete this.placeReviewMap[item.placeId];
      delete this.contributions[item.placeId];
    }
    this.discoveries = this.discoveries.filter((item) => item.id !== id);
    delete this.contributions[id];
    return { removed: true };
  }
  private prepareDiscovery(actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    const cityCode = requiredText(input.cityCode, '城市代码', 6);
    if (!/^\d{6}$/.test(cityCode)) throw new Error('请选择有效的城市。');
    const name = requiredText(input.name, '地点名称', 80);
    // 每个地点独一无二：同城同名且仍在分享/审核中的拒绝重复；已退回的允许修正后重新分享。
    if (this.discoveries.some(item => item.cityCode === cityCode && item.name.trim() === name.trim() && item.status !== 'rejected')) {
      throw new Error('社区里已有同名的地点分享（可能在审核中），不能重复分享。');
    }
    const rawLat = input.lat === undefined || input.lat === null || input.lat === '' ? null : Number(input.lat);
    const rawLng = input.lng === undefined || input.lng === null || input.lng === '' ? null : Number(input.lng);
    if ((rawLat === null) !== (rawLng === null) || (rawLat !== null && (!Number.isFinite(rawLat) || Math.abs(rawLat) > 90)) || (rawLng !== null && (!Number.isFinite(rawLng) || Math.abs(rawLng) > 180))) throw new Error('经纬度需同时填写，且在有效范围内。');
    const crs = inputCoordinateCrs(input.coordinateCrs);
    const canonical = rawLat !== null && rawLng !== null ? toCanonicalCoordinates(rawLat, rawLng, crs) : null;
    const item: Discovery = { id: `community_${randomUUID()}`, authorId: actorId,
      officialTagIds: officialTagIds(input.officialTagIds), customTags: customTagNames(input.customTags),
      nickname: requiredText(displayNickname(input, fallbackNickname), '昵称', 30), name, cityCode,
      address: requiredText(input.address, '位置说明', 200), description: requiredText(input.description, '发现与体验', 2000),
      reservationHint: typeof input.reservationHint === 'string' && input.reservationHint.trim() ? input.reservationHint.trim().slice(0, 200) : undefined,
      lat: canonical?.lat ?? null, lng: canonical?.lng ?? null, coordinateCrs: 'WGS84', createdAt: this.now(), status: 'shared', evidence: '', decisionNote: '', reviews: [], sample: false, reports: [] };
    return item;
  }
  previewPublish(actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    return this.view(this.prepareDiscovery(actorId, input, fallbackNickname), actorId);
  }
  publish(actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    const item = this.prepareDiscovery(actorId, input, fallbackNickname);
    this.discoveries.push(item); return this.view(item, actorId);
  }
  review(id: string, actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    const item = this.find(id);
    if (item.authorId === actorId) throw new Error('不能给自己发布的地点评分。');
    if (item.status !== 'approved') throw new Error('该地点尚未通过审核，暂时不能公开评价。');
    if (item.status === 'approved' && item.placeId) {
      this.reviewPlace(item.placeId, actorId, input, fallbackNickname);
      return this.view(item, actorId);
    }
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('评分需在 1–5 星之间。');
    const review: Review = { actorId, nickname: requiredText(displayNickname(input, fallbackNickname), '昵称', 30), rating,
      text: requiredText(input.text, '评价', 1000), createdAt: this.now() };
    item.reviews = item.reviews.filter((r) => r.actorId !== actorId);
    item.reviews.push(review); return this.view(item, actorId);
  }
  /** 官方目录地点（14 位坐标 ID）的用户评价：每个身份保留一份，再次提交即更新。 */
  reviewPlace(placeId: string, actorId: string, input: Record<string, unknown>, fallbackNickname = '') {
    if (this.discoveries.some(item => item.placeId === placeId && item.authorId === actorId)) {
      throw new Error('不能评价自己分享并收录的地点。');
    }
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('评分需在 1–5 星之间。');
    const review: PlaceReview = { actorId, nickname: requiredText(displayNickname(input, fallbackNickname), '昵称', 30), rating,
      text: requiredText(input.text, '评价', 1000), createdAt: this.now() };
    const list = this.placeReviewMap[placeId] ?? (this.placeReviewMap[placeId] = []);
    const index = list.findIndex(item => item.actorId === actorId);
    if (index >= 0) list[index] = review; else list.push(review);
    return { ...review };
  }
  placeUserReviews(placeId: string) {
    return (this.placeReviewMap[placeId] ?? []).map(({ actorId, ...rest }) => rest);
  }
  ownPlaceReview(placeId: string, actorId: string) {
    const review = (this.placeReviewMap[placeId] ?? []).find(item => item.actorId === actorId);
    if (!review) return undefined;
    const { actorId: _actorId, ...publicReview } = review;
    return publicReview;
  }
  has(id: string) { return this.discoveries.some((place) => place.id === id); }
  private prepareSubmission(id: string, actorId: string, input: Record<string, unknown>) {
    const item = this.find(id);
    if (item.authorId !== actorId) throw new Error('只有发布者能提交该地点。');
    const needsReverification = item.lat !== null && item.lng !== null && item.coordinateCrs !== 'WGS84';
    if (item.status === 'pending' || (item.status === 'approved' && !needsReverification)) throw new Error('该地点已提交或已收录，无需重复提交。');
    const hasLat = input.lat !== undefined && input.lat !== null && input.lat !== '';
    const hasLng = input.lng !== undefined && input.lng !== null && input.lng !== '';
    if (hasLat !== hasLng) throw new Error('经纬度需同时填写，且在有效范围内。');
    if (needsReverification && (!hasLat || !hasLng)) throw new Error('这条旧地点的坐标系未知，请重新核对并填写经纬度后再提交。');
    const crs = inputCoordinateCrs(input.coordinateCrs);
    const rawLat = hasLat ? Number(input.lat) : item.lat;
    const rawLng = hasLng ? Number(input.lng) : item.lng;
    if (rawLat === null || rawLng === null || !Number.isFinite(rawLat) || !Number.isFinite(rawLng) || Math.abs(rawLat) > 90 || Math.abs(rawLng) > 180) throw new Error('申请收录需要有效的经纬度。');
    const canonical = hasLat && hasLng
      ? toCanonicalCoordinates(rawLat, rawLng, crs)
      : { lat: rawLat, lng: rawLng };
    const evidence = requiredText(input.evidence, '核实依据（交通、开放时间、公开资料等）', 2000);
    return { item, canonical, evidence };
  }
  previewSubmission(id: string, actorId: string, input: Record<string, unknown>) {
    const { item, canonical, evidence } = this.prepareSubmission(id, actorId, input);
    return this.view({ ...item, ...canonical, evidence, coordinateCrs: 'WGS84', status: 'pending', decisionNote: '' }, actorId);
  }
  submit(id: string, actorId: string, input: Record<string, unknown>) {
    const { item, canonical, evidence } = this.prepareSubmission(id, actorId, input);
    item.lat = canonical.lat; item.lng = canonical.lng; item.coordinateCrs = 'WGS84'; item.evidence = evidence;
    item.status = 'pending'; item.decisionNote = '';
    item.submissionVersion = (item.submissionVersion || 0) + 1;
    return this.view(item, actorId);
  }
  decide(id: string, input: Record<string, unknown>) {
    const item = this.find(id);
    if (input.expectedSubmissionVersion !== undefined) {
      if (!Number.isSafeInteger(input.expectedSubmissionVersion) || Number(input.expectedSubmissionVersion) < 0) throw new Error('申请版本无效，请重新核对。');
      if (input.expectedSubmissionVersion !== (item.submissionVersion || 0) || item.status !== 'pending') {
        throw new CommunityReviewConflictError('申请资料或状态已变化，请刷新审核队列后重新核对。');
      }
    }
    if (item.status !== 'pending') throw new Error('只有待审核地点可以处理。');
    if (!['approved', 'rejected'].includes(String(input.decision))) throw new Error('请选择通过或退回。');
    const note = requiredText(input.note, '审核说明', 1000);
    let assignedPlaceId: string | undefined;
    if (input.decision === 'approved' && !item.placeId) {
      const lat = Number(item.lat); const lng = Number(item.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const used = new Set([
          ...this.retiredPlaceIds,
          ...this.discoveries.map(d => d.placeId).filter((value): value is string => Boolean(value)),
        ]);
        for (let serial = 0; serial <= 99; serial += 1) {
          const candidate = coordinatePlaceId(lng, lat, serial);
          if (!used.has(candidate) && !this.registry?.numberOf(candidate)) { assignedPlaceId = candidate; break; }
        }
        if (!assignedPlaceId) throw new Error('该坐标附近的地点编号已用尽，暂时无法收录。');
      }
    }
    item.status = input.decision as 'approved' | 'rejected'; item.decisionNote = note;
    // 平台收录分配 14 位坐标地点 ID；内部递增收录号保留兼容，注册表不可用不影响地点生效。
    if (item.status === 'approved') {
      if (assignedPlaceId) item.placeId = assignedPlaceId;
      this.registry?.ensure(item.placeId ?? item.id);
      this.promoteReviews(item);
    }
    this.decisions.push({ at: this.now(), targetId: item.id, targetName: item.name, decision: item.status, note });
    if (this.decisions.length > 200) this.decisions = this.decisions.slice(-200);
    return this.view(item, '');
  }
  report(id: string, actorId: string, input: Record<string, unknown>) {
    const item = this.find(id);
    if (item.authorId === actorId) throw new Error('不能举报自己发布的内容。');
    if (item.status !== 'approved') throw new Error('该地点尚未公开，暂时不能举报。');
    const reason = requiredText(input.reason, '举报理由', 200);
    const existing = item.reports.find((r) => r.actorId === actorId);
    if (existing) { existing.reason = reason; existing.createdAt = this.now(); }
    else item.reports.push({ actorId, reason, createdAt: this.now() });
    return { reported: true };
  }
  /** 审核台视图：调用方（路由）负责校验审核员凭证。 */
  moderation() {
    const withReports = (item: Discovery) => ({
      id: item.id, name: item.name, nickname: item.nickname, cityCode: item.cityCode,
      status: item.status, address: item.address, description: item.description,
      evidence: item.evidence, decisionNote: item.decisionNote, createdAt: item.createdAt,
      lat: item.lat, lng: item.lng, coordinateCrs: item.coordinateCrs || 'unknown',
      submissionVersion: item.submissionVersion || 0,
      reports: item.reports.map(({ actorId: _actorId, ...report }) => report),
    });
    return {
      pending: [...this.discoveries].reverse().filter((item) => item.status === 'pending').map(withReports),
      reported: [...this.discoveries].reverse().filter((item) => item.reports.length > 0).map(withReports),
      log: [...this.decisions].reverse(),
    };
  }

  // —— 样例内容 ——

  hasSamples() { return this.posts.some(post => post.sample) || this.discoveries.some(item => item.sample); }
  samplesCleared() { return this.samplesClearedFlag; }
  clearSamples() {
    const removedIds = this.discoveries.filter(item => item.sample).map(item => item.id);
    this.posts = this.posts.filter(post => !post.sample);
    this.discoveries = this.discoveries.filter(item => !item.sample);
    for (const id of removedIds) delete this.contributions[id];
    this.samplesClearedFlag = true;
    return { removed: true };
  }
  seedSamples(seed: { posts: SamplePostSeed[]; places: SamplePlaceSeed[] }) {
    if (this.hasSamples() || this.samplesClearedFlag) return { seeded: false };
    const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
    for (const place of seed.places) {
      const created = this.publish(place.authorId, place.input);
      const item = this.find(created.id);
      item.sample = true;
      if (Number.isFinite(place.minutesAgo)) item.createdAt = iso(place.minutesAgo);
      for (const review of place.reviews ?? []) {
        this.review(created.id, review.actorId, review.input);
        const stored = item.reviews[item.reviews.length - 1];
        if (stored && Number.isFinite(review.minutesAgo)) stored.createdAt = iso(review.minutesAgo);
      }
      if (place.submit) this.submit(created.id, place.authorId, place.submit.input);
      if (place.decision) this.decide(created.id, place.decision);
    }
    for (const post of seed.posts) {
      const created = this.publishPost(post.authorId, { nickname: post.nickname, text: post.text, placeRef: post.placeRef });
      const stored = this.findPost(created.id, post.authorId);
      stored.sample = true;
      if (Number.isFinite(post.minutesAgo)) stored.createdAt = iso(post.minutesAgo);
      stored.likedBy = [...(post.likedBy ?? [])];
      for (const comment of post.comments ?? []) {
        this.addComment(comment.actorId, stored.id, { nickname: comment.nickname, text: comment.text });
        const storedComment = stored.comments[stored.comments.length - 1];
        if (storedComment && Number.isFinite(comment.minutesAgo)) storedComment.createdAt = iso(comment.minutesAgo);
      }
    }
    return { seeded: true };
  }
}

/** 收录地点供页面与 Agent 共同检索；开放时间／无障碍设施仍不推断为已核实。 */
export function communityPlaceProvider(base: PlaceProvider, community: CommunityService, registry?: PlaceNumberRegistry, emptyQueryFallback?: PlaceProvider): PlaceProvider {
  return { providerName: base.providerName,
    async search(input) {
      const actorId = input.actorId || '';
      const { actorId: _actorId, ...directoryInput } = input;
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 50)));
      const query = input.query?.trim().toLowerCase();
      const tagQuery = Boolean(query && (OFFICIAL_PLACE_TAGS.some(tag => tag.label.includes(query)) || community.hasMatchingTag(query, actorId)));
      const filtersTags = Boolean(input.tag || tagQuery);
      const searchInput = { ...directoryInput, offset: 0, query: tagQuery ? undefined : input.query };
      const usesLocalCatalog = base.providerName.startsWith('amap') && !searchInput.center && !searchInput.query?.trim() && !searchInput.category?.trim();
      const source = usesLocalCatalog ? emptyQueryFallback ?? base : base;
      const decorate = (place: DemoPlace) => ({ ...place, customTags: [...new Set([...(place.customTags || []), ...community.myTags(place.placeId, actorId)])], placeNo: registry?.numberOf(place.placeId) });
      const matchesTags = (place: DemoPlace) =>
        (!input.tag || placeTags(place).some(tag => tag.source === 'official' && tag.id === input.tag)) &&
        (!tagQuery || `${place.name} ${placeTags(place).map(tag => tag.label).join(' ')}`.toLowerCase().includes(query!));
      const own = community.approvedPlaces(input, actorId).map(decorate).filter(matchesTags);
      let sourceError: PlaceSearchResult['error'];
      let sourcePlaces: DemoPlace[] = [];
      if (!filtersTags) {
        const ownPage = offset < own.length ? own.slice(offset, offset + limit) : [];
        const sourceOffset = Math.max(0, offset - own.length);
        const needsLookahead = ownPage.length === limit && offset + limit >= own.length;
        const sourceLimit = needsLookahead ? 1 : Math.max(0, limit - ownPage.length);
        let sourceHasMore = false;
        if (sourceLimit > 0) {
          const result = await source.search({ ...searchInput, offset: sourceOffset, limit: sourceLimit });
          sourcePlaces = result.places.map(decorate);
          sourceError = result.error;
          sourceHasMore = (result.nextCursor !== undefined && result.nextCursor !== null) ||
            result.places.length > sourceLimit || (needsLookahead && result.places.length > 0);
        }
        const page = [...ownPage, ...sourcePlaces].slice(0, limit + 1);
        const hasMore = offset + ownPage.length < own.length || sourceHasMore;
        const places = page.slice(0, limit);
        return { places, empty: places.length === 0, nextCursor: hasMore ? offset + places.length : null, ...(sourceError ? { error: sourceError } : {}) };
      }

      // Tags are applied after provider search. Scan source pages until the requested
      // slice plus one lookahead match is available, instead of paginating raw POIs.
      const sourceStart = Math.max(0, offset - own.length);
      const sourceEnd = Math.max(0, offset + limit + 1 - own.length);
      let sourceOffset = 0;
      const matchingSource: DemoPlace[] = [];
      while (matchingSource.length < sourceEnd) {
        const result = await source.search({ ...searchInput, offset: sourceOffset, limit: 50 });
        sourceError = result.error;
        matchingSource.push(...result.places.map(decorate).filter(matchesTags));
        const nextOffset = result.nextCursor ?? sourceOffset + result.places.length;
        if (nextOffset <= sourceOffset || (!result.places.length && !result.nextCursor)) break;
        sourceOffset = nextOffset;
        if (result.nextCursor === null) break;
      }
      sourcePlaces = matchingSource.slice(sourceStart, sourceEnd);
      const ownPage = own.slice(offset, offset + limit + 1);
      const page = [...ownPage, ...sourcePlaces].slice(0, limit + 1);
      const hasMore = page.length > limit;
      const places = page.slice(0, limit);
      // Preserve an upstream failure even when community matches are available.
      // Consumers that need a complete catalog lookup (such as duplicate checks
      // before sharing) must not mistake partial/fuzzy results for verification.
      return { places, empty: places.length === 0, nextCursor: hasMore ? offset + places.length : null, ...(sourceError ? { error: sourceError } : {}) };
    },
    async detail(id, mode) {
      const own = community.approvedPlaces().find((place) => place.placeId === id);
      if (own) return own;
      const basePlace = await base.detail(id, mode);
      if (!basePlace) return null;
      const placeNo = registry?.numberOf(id);
      return placeNo ? { ...basePlace, placeNo } : basePlace;
    },
  };
}
