/**
 * 局域网开放的邀请码门禁。
 *
 * 服务绑定非回环地址（HOST=0.0.0.0 等）时自动启用：每次启动生成随机邀请码，
 * 访客在 /access-gate 输入一次即可获得最长 30 天 Cookie；重新开放后须重新输入。
 * 可用 BANTU_ACCESS_CODE 固定邀请码（部署场景）；本机回环访问默认放行。
 * 健康检查豁免：启动脚本靠它探活，且不泄漏任何业务数据。
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies, readJson } from './request.js';
import { sendError } from './respond.js';

export const ACCESS_COOKIE = 'bantu_access';
const ACCESS_MAX_AGE = 60 * 60 * 24 * 30; // 30 天，避免访客频繁重输。
const MAX_GATE_BODY_BYTES = 64 * 1024;

const LISTEN_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 去掉易混淆字符（0/O/1/I/L）的字母表；8 位约 4 万亿组合，局域网内不可穷举。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface AccessGateOptions {
  /** 监听地址；默认取 HOST 环境变量，再默认回环。 */
  host?: string | null;
  /** 固定邀请码；未提供时启用状态下每次生成随机码。 */
  code?: string | null;
  /** 局域网开放入口使用随机码，即使部署环境已有固定码。 */
  randomCode?: boolean;
  /** 本机回环来源是否免门禁；默认 true。测试传 false 以覆盖重定向与验证路径。 */
  bypassLoopback?: boolean;
}

export interface AccessGate {
  readonly enabled: boolean;
  /** 启用时的邀请码明文；只在启动日志与本机记录文件中出现，不下发到客户端。 */
  readonly code: string | null;
  /** 返回 true 表示门禁已处理该请求（响应已发出），false 表示放行进入后续路由。 */
  intercept(request: IncomingMessage, response: ServerResponse, method: string, path: string): Promise<boolean>;
}

function digest(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function generateCode(): string {
  let code = '';
  for (let index = 0; index < 8; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function normalizeCode(value: unknown): string {
  // 输入法/自动填充可能夹入空格或连字符；统一去掉并转大写再比对。
  return typeof value === 'string' ? value.replace(/[\s-]+/g, '').toUpperCase() : '';
}

function safeEqual(provided: string, expected: string): boolean {
  const actualBytes = Buffer.from(provided), expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function redirect(response: ServerResponse, location: string, cookie?: string): void {
  response.writeHead(303, { location, ...(cookie ? { 'set-cookie': cookie } : {}) });
  response.end();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

function gatePage(error: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>伴途 · 局域网测试</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f2f4f8;color:#1c2330}
.card{width:100%;max-width:360px;background:#fff;border:1px solid #e3e7ee;border-radius:16px;padding:28px 24px;text-align:center}
h1{font-size:20px;margin:10px 0 6px}
p{font-size:13px;color:#7a8394;line-height:1.6;margin-bottom:18px}
label{display:block;margin-bottom:8px;text-align:left;font-size:13px;font-weight:600}
input{width:100%;font-size:22px;letter-spacing:6px;text-align:center;text-transform:uppercase;
padding:12px;border:1px solid #d6dbe3;border-radius:10px;outline:none;background:#fff;color:inherit}
input:focus{border-color:#355cff}
button{width:100%;margin-top:14px;padding:12px;font-size:16px;color:#fff;background:#355cff;border:none;border-radius:10px;cursor:pointer}
button:active{opacity:.85}
.hint{font-size:11px;margin:16px 0 0}
.error{margin-top:12px;font-size:13px;color:#e5484d}
@media(prefers-color-scheme:dark){
body{background:#12161d;color:#e8ecf3}
.card{background:#1b212b;border-color:#2a323f}
input{background:#12161d;border-color:#3a4453}
}</style></head><body><div class="card">
<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#355cff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10c0 5-6 10-6 10S6 15 6 10a6 6 0 1 1 12 0Z"/><circle cx="12" cy="10" r="2"/></svg><h1>伴途 · 邀请测试</h1>
<p>连接同一 Wi-Fi 或局域网，<br>输入本次邀请码，开始体验伴途。</p>
<form method="post" action="/access-gate">
<label for="accessCode">本次邀请码</label>
<input id="accessCode" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="输入邀请码" required autofocus>
<button type="submit">进入伴途</button>
</form>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
<p class="hint">重新开放测试后，请使用新的邀请码。</p>
</div></body></html>`;
}

function sendGatePage(response: ServerResponse, status: number, error: string): void {
  const body = gatePage(error);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_GATE_BODY_BYTES) return '';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const bypassLoopback = options.bypassLoopback ?? true;
  const host = (options.host ?? process.env.HOST ?? '127.0.0.1').toLowerCase();
  const loopbackListen = LISTEN_LOOPBACK_HOSTS.has(host);
  const randomCode = options.randomCode ?? (process.env.BANTU_RANDOM_ACCESS_CODE === 'true');
  const fixedCode = randomCode ? '' : normalizeCode(options.code || process.env.BANTU_ACCESS_CODE);
  const enabled = Boolean(fixedCode) || !loopbackListen;
  const code = enabled ? fixedCode || generateCode() : null;
  const expected = code ? digest(code) : null;
  // 通行凭证属于本次开放；重启后即使使用同一固定码，也不能沿用旧 Cookie。
  const passToken = expected ? randomBytes(32).toString('hex') : null;

  const isAuthorized = (request: IncomingMessage): boolean =>
    Boolean(passToken) && safeEqual(parseCookies(request)[ACCESS_COOKIE] ?? '', passToken!);

  const handleSubmission = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const contentType = String(request.headers['content-type'] ?? '');
    const wantsJson = contentType.includes('application/json');
    let provided = '';
    if (wantsJson) {
      const body = await readJson(request);
      provided = normalizeCode(body.code);
    } else {
      provided = normalizeCode(new URLSearchParams(await readBodyText(request)).get('code'));
    }

    if (expected && safeEqual(digest(provided), expected)) {
      redirect(response, '/', `${ACCESS_COOKIE}=${passToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE}`);
      return;
    }
    if (wantsJson) {
      sendError(response, 401, 'ACCESS_CODE_INVALID', '邀请码不正确。');
    } else {
      sendGatePage(response, 401, '邀请码不正确，请重新输入。');
    }
  };

  return {
    enabled,
    code,
    async intercept(request, response, method, path) {
      if (!enabled || !expected) return false;
      if (bypassLoopback && LOOPBACK_REMOTES.has(request.socket.remoteAddress ?? '')) return false;
      // 启动脚本与本机探活依赖健康检查；它只暴露 status/service，不含业务数据。
      if (path === '/api/v1/health') return false;

      if (path === '/access-gate') {
        if (method === 'POST') {
          await handleSubmission(request, response);
          return true;
        }
        if (method === 'GET') {
          if (isAuthorized(request)) redirect(response, '/');
          else sendGatePage(response, 200, '');
          return true;
        }
        sendError(response, 405, 'INVALID_INPUT', '不支持的请求方法。');
        return true;
      }

      if (isAuthorized(request)) return false;

      if (path.startsWith('/api/')) {
        sendError(response, 401, 'ACCESS_CODE_REQUIRED', '局域网访问需要邀请码；请先用浏览器打开首页输入邀请码。');
      } else {
        redirect(response, '/access-gate');
      }
      return true;
    },
  };
}
