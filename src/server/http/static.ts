/**
 * 静态外壳与本地图片资源的响应。
 *
 * 目录按模块位置解析，而不是 process.cwd()：从别的目录启动服务时
 * 仍然能找到 public/，不会静默把所有资源变成 404。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sendError } from './respond.js';

/** 固定入口：路径与 MIME 一一对应（HTML 有别名，清单和图标不在下面的扩展名白名单里）。 */
const FIXED_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/manifest.webmanifest': {
    file: 'manifest.webmanifest',
    type: 'application/manifest+json; charset=utf-8',
  },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

/**
 * 可直接按路径取的文件类型。
 *
 * 这里刻意用**扩展名白名单 + 目录前缀**而不是逐文件登记：
 * 前端拆成多个模块后，新增一个 lib/ 或 views/ 下的文件不应该还要改服务端。
 */
const SERVABLE_EXTENSIONS: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * public/ 的位置。
 *
 * 同一个文件在源码和编译产物里的相对深度不同：
 *   src/server/http/static.ts  → ../../../public
 *   dist/src/server/http/static.js → ../../../../public
 * 再加上「从别的目录启动服务」的情况，逐个探测比写死一个更可靠。
 */
const PUBLIC_DIR = (() => {
  const candidates = [
    fileURLToPath(new URL('../../../public/', import.meta.url)),
    fileURLToPath(new URL('../../../../public/', import.meta.url)),
    join(process.cwd(), 'public'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0];
})();

/** 把请求路径解析成 public/ 下的文件；越界或不支持的扩展名返回 null。 */
function resolveFile(path: string): { file: string; type: string } | null {
  const fixed = FIXED_FILES[path];
  if (fixed) return fixed;

  const type = SERVABLE_EXTENSIONS[extname(path).toLowerCase()];
  if (!type) return null;

  // 防目录穿越：解码后规范化，必须仍落在 public/ 内。
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  if (!relative || relative.startsWith('..') || relative.includes(`..${sep}`)) return null;

  return { file: relative, type };
}

export function isStaticPath(path: string): boolean {
  return resolveFile(path) !== null;
}

/**
 * HTML 外壳的内容安全策略。
 *
 * 必须走响应头而不是 <meta>：frame-ancestors 在 meta 中会被浏览器忽略，
 * 且每次加载都在控制台报错。img-src 放行高德瓦片域名，否则地图底图被自家 CSP 拦截。
 */
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.is.autonavi.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'";

export async function serveStatic(response: ServerResponse, path: string): Promise<void> {
  const entry = resolveFile(path);
  if (!entry) {
    sendError(response, 404, 'RESOURCE_NOT_FOUND', '静态资源未找到。');
    return;
  }
  try {
    const content = await readFile(join(PUBLIC_DIR, entry.file));
    response.writeHead(200, {
      'content-type': entry.type,
      // 外壳一律不缓存：改完立刻生效比省这点带宽重要（曾因旧副本白屏排查很久）。
      'cache-control': 'no-store',
      ...(entry.type.startsWith('text/html') ? { 'content-security-policy': HTML_CSP } : {}),
    });
    response.end(content);
  } catch {
    sendError(response, 404, 'RESOURCE_NOT_FOUND', '静态资源未找到。');
  }
}
