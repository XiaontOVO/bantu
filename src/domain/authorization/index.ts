/**
 * 动作许可的模块汇总。
 *
 * 对外仍通过 `domain/authorization.ts` 这个门面导入，
 * 因此外部调用方不需要知道内部怎么分文件。
 */
export * from './text.js';
export * from './digest.js';
export * from './service.js';
