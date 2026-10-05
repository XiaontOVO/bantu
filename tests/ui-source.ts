/**
 * 前端源码的统一读取入口。
 *
 * 外壳已拆成多个文件（index.html + styles.css + app.js + lib/*.js + views/*.js），
 * 断言必须按"关注的层"读取，而不是把三个文件拼在一起蒙混过关：
 *   - 骨架 → index.html
 *   - 样式 → styles.css
 *   - 行为 → public 下除 sw.js 之外的全部 JS（入口 + lib + views）
 *
 * sw.js 单独读：它是 Service Worker，与页面脚本是两回事。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const PUBLIC_DIR = `${process.cwd()}/public`;

export const readShell = () => readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
export const readStyles = () => readFile(join(PUBLIC_DIR, 'styles.css'), 'utf8');
export const readServiceWorker = () => readFile(join(PUBLIC_DIR, 'sw.js'), 'utf8');

/** public 下所有页面脚本（排除 Service Worker），按路径排序后拼接。 */
export async function readFrontendScripts(): Promise<string> {
  const entries = await readdir(PUBLIC_DIR, { recursive: true });
  const files = entries
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.js') && !entry.endsWith('sw.js'))
    .sort();
  const parts = [];
  for (const file of files) {
    const body = await readFile(join(PUBLIC_DIR, file), 'utf8');
    parts.push(`\n/* ==== ${relative(PUBLIC_DIR, join(PUBLIC_DIR, file))} ==== */\n${body}`);
  }
  return parts.join('\n');
}

/** 页面脚本的相对路径清单，用于确认模块数量与是否有人漏引。 */
export async function frontendScriptPaths(): Promise<string[]> {
  const entries = await readdir(PUBLIC_DIR, { recursive: true });
  return entries
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.js') && !entry.endsWith('sw.js'))
    .sort();
}
