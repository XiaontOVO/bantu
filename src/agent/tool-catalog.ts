/**
 * 工具目录门面。
 *
 * 目录已按"改哪一类工具"拆到 `catalog/` 下（trip／planning／places），
 * 这里保留原路径转发，调用方（`services/agent-service.ts`）不必改。
 *
 * 新增工具请改 `catalog/` 里的对应模块，**不要**把工具定义搬回本文件。
 */
export * from './catalog/index.js';
