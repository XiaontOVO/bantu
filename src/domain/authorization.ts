/**
 * 动作许可的对外门面。
 *
 * 实现按关注点拆在 `authorization/` 下：
 *   text.ts     中文意图解析（整句确认边界、直接命令）
 *   digest.ts   参数摘要（把许可绑定到具体参数）
 *   service.ts  一次性许可状态机
 *
 * 保留这个文件是为了让既有导入路径（含 `domain/index.ts` 的 `export *`）不被打断。
 */
export * from './authorization/index.js';
