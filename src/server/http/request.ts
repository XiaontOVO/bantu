/**
 * 请求解析与鉴权相关的纯工具。
 * 这里只做「读到什么」和「怎么判断」，不碰业务规则。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InvalidJsonBodyError, RequestBodyTooLargeError } from './errors.js';
import { sendError } from './respond.js';

/** token → 会话绑定；由 http-server 持有并持久化。 */
export interface SessionBinding {
  actorId: string;
  sessionId: string;
}

/** 路由处理函数收到的请求视图。 */
export interface RouteRequest {
  method: string;
  path: string;
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
}

/**
 * 数组字段判型：`stops: 1` 这类输入必须在入口变成 400，
 * 否则会在领域层 normalize/constraints 的 `.map()` 处抛出 TypeError 并变成 500。
 */
export function rejectNonArrayFields(
  response: ServerResponse,
  body: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      sendError(response, 400, 'INVALID_INPUT', `${field} 必须是数组。`);
      return true;
    }
  }
  return false;
}

/**
 * 并发控制字段必须是整数。
 * 不做这一步时 `Number(undefined)` 会得到 NaN，并伪装成 REVISION_CONFLICT 之类的领域错误。
 */
export function readRevision(
  body: Record<string, unknown>,
  field = 'expectedRevision',
): number | null {
  const value = body[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new RequestBodyTooLargeError();
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidJsonBodyError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidJsonBodyError();
  }
  return parsed as Record<string, unknown>;
}

export function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie ?? '';
  const result: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(rest.join('='));
    } catch {
      // 非法百分号编码的 Cookie 不能让整个请求变成 500；按未提供该 Cookie 处理。
      continue;
    }
  }
  return result;
}

/**
 * 返回请求来源 IP。默认只信 socket 对端；只有显式配置 TRUST_PROXY_HOPS 后才读取
 * X-Forwarded-For。服务应只允许可信反向代理访问，并由代理覆盖/整理该请求头。
 */
export function clientIp(request: IncomingMessage): string {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  const trustedHops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
  if (!Number.isSafeInteger(trustedHops) || trustedHops < 1) return remoteAddress;

  const forwarded = request.headers['x-forwarded-for'];
  const addresses = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  const clientIndex = addresses.length - trustedHops;
  return clientIndex >= 0 ? addresses[clientIndex] : remoteAddress;
}

export interface Pagination {
  limit: number;
  cursor: number;
}

export function parsePagination(url: URL, defaultLimit = 20): Pagination {
  const rawLimit = Number(url.searchParams.get('limit') ?? defaultLimit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(50, Math.max(1, Math.floor(rawLimit)))
    : defaultLimit;
  const rawCursor = Number(url.searchParams.get('cursor') ?? 0);
  const cursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? Math.floor(rawCursor) : 0;
  return { limit, cursor };
}

export function paginate<T>(
  items: readonly T[],
  pagination: Pagination,
): { items: T[]; nextCursor: number | null } {
  const page = items.slice(pagination.cursor, pagination.cursor + pagination.limit);
  const next = pagination.cursor + page.length;
  return { items: page, nextCursor: next < items.length ? next : null };
}

export function setSessionCookie(response: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader(
    'set-cookie',
    `bantu_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`,
  );
}

export function clearSessionCookie(response: ServerResponse): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('set-cookie', `bantu_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

/** 支持的交通方式；未识别的值一律当作步行。 */
export function readTransportMode(value: unknown): 'walking' | 'transit' | 'driving' {
  return value === 'transit' || value === 'driving' ? value : 'walking';
}
