/**
 * 模块结构守卫。
 *
 * 拆分的价值在于边界可持续，因此这里断言：
 * 1. 每个路由模块都被真正登记到路由表（而不是写了文件却忘了接上）；
 * 2. 已迁移的端点在 http-server.ts 里不再出现（避免两处实现并存）；
 * 3. http-server.ts 只做装配，不重新长回单体。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const SERVER_DIR = `${process.cwd()}/src/server`;
const ROUTES_DIR = `${SERVER_DIR}/http/routes`;

/**
 * 已迁移的路由模块：文件里的导出名 → 该模块独占的实现标记。
 * 标记必须是只会出现在路由实现里的代码片段，不能是注释里也会出现的词。
 */
const MIGRATED: Record<string, string[]> = {
  healthRoutes: [],
  sessionRoutes: [],
  tripRoutes: ['listTrips(', 'addShortlist('],
  lifecycleRoutes: ['recordExecution(', 'cloneTrip(', 'startTrip(', 'captureContext('],
  planningRoutes: ['consumeTaskLimit('],
  placeRoutes: ["'/api/v1/places'", "'/api/v1/routes'"],
  operationRoutes: ["'/api/v1/operations'"],
  messageRoutes: ['messageService.list(', 'messageService.handle(', 'messageService.redact('],
  memoryRoutes: ['createMemory(', 'generateRecap(', 'patchMemory(', 'listShortlist('],
  proposalRoutes: ['decideAction(', 'startApply(', 'rejectProposal(', 'applyProposal('],
  demoRoutes: ['recordFeedback('],
};

test('every route module is registered in the route table', async () => {
  const server = await readFile(`${SERVER_DIR}/http-server.ts`, 'utf8');
  const registry = /const ROUTES[^=]*=\s*\[([\s\S]*?)\]/.exec(server)?.[1];
  assert.ok(registry, 'ROUTES registry not found in http-server.ts');

  const files = (await readdir(ROUTES_DIR)).filter((name) => name.endsWith('.ts'));
  assert.ok(
    files.length >= Object.keys(MIGRATED).length,
    `路由模块数量 ${files.length} 少于已登记模块数 ${Object.keys(MIGRATED).length}`,
  );

  for (const exported of Object.keys(MIGRATED)) {
    assert.ok(registry.includes(exported), `${exported} 未登记到 ROUTES`);
    assert.ok(
      new RegExp(`import \\{[^}]*\\b${exported}\\b`).test(server),
      `${exported} 未在 http-server.ts 中导入`,
    );
  }
});

test('each route module file exports a RouteHandler', async () => {
  const files = (await readdir(ROUTES_DIR)).filter((name) => name.endsWith('.ts'));
  for (const file of files) {
    const source = await readFile(`${ROUTES_DIR}/${file}`, 'utf8');
    // 「_」前缀是跨路由共享的工具模块（如 _shared.ts），不导出 RouteHandler。
    if (!file.startsWith('_')) {
      assert.match(
        source,
        /export const \w+Routes: RouteHandler/,
        `${file} 没有导出形如 xRoutes 的 RouteHandler`,
      );
    }
    // 路由模块不应该自己建服务器或读环境变量。
    assert.equal(source.includes('createServer('), false, `${file} 不应创建服务器`);
    assert.equal(source.includes('process.env'), false, `${file} 不应直接读环境变量`);
  }
});

test('migrated endpoints no longer live in http-server.ts', async () => {
  const server = await readFile(`${SERVER_DIR}/http-server.ts`, 'utf8');
  for (const [exported, markers] of Object.entries(MIGRATED)) {
    for (const marker of markers) {
      assert.equal(
        server.includes(marker),
        false,
        `${marker} 仍留在 http-server.ts，${exported} 与内联实现重复`,
      );
    }
  }
});

test('http-server.ts stays an assembly file rather than a monolith', async () => {
  const server = await readFile(`${SERVER_DIR}/http-server.ts`, 'utf8');
  const lines = server.split('\n').length;
  // 拆分前 1408 行；11 个路由模块全部外迁后 132 行。
  // 这里只留装配与收尾，任何接近 200 行的增长都意味着端点又开始写在入口文件里。
  assert.ok(lines < 200, `http-server.ts 有 ${lines} 行，应只做装配与收尾`);
  assert.ok(server.includes('createServerContext(options)'), '装配应交给 http/bootstrap.ts');
});

test('HTTP primitives are not redefined in http-server.ts', async () => {
  const server = await readFile(`${SERVER_DIR}/http-server.ts`, 'utf8');
  for (const primitive of [
    'function sendJson(',
    'function sendError(',
    'function readJson(',
    'function parseCookies(',
    'function paginate(',
    'const ERROR_STATUS',
  ]) {
    assert.equal(server.includes(primitive), false, `${primitive} 应留在 http/ 模块里`);
  }
});
