/**
 * Agent 层模块结构守卫。
 *
 * 与 http／服务层同样的思路：契约与实现分离、功能分区共享一个状态对象、
 * 入口文件不重新长成单体。这里额外守住"工具目录只有一处定义"——
 * 工具是模型能看到的能力边界，散成两处就会出现权限策略不一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const AGENT_DIR = `${process.cwd()}/src/agent`;
const SERVICE = `${process.cwd()}/src/services/agent-service.ts`;

test('agent contracts live in a types-only module', async () => {
  const contracts = await readFile(`${AGENT_DIR}/contracts.ts`, 'utf8');
  for (const name of [
    'AgentServiceOptions',
    'StartAgentOperationInput',
    'StartApplyOperationInput',
    'AgentOperationView',
  ]) {
    assert.ok(
      new RegExp(`export interface ${name}\\b`).test(contracts),
      `contracts.ts 缺少 ${name}`,
    );
  }
  // 纯类型模块：http 层引用契约时不应被拉进 Agent 实现。
  assert.equal(/^function /m.test(contracts), false, 'contracts.ts 不应包含函数实现');
  assert.equal(/^export function /m.test(contracts), false, 'contracts.ts 不应导出函数');
  assert.equal(/^export class /m.test(contracts), false, 'contracts.ts 不应导出类');
  for (const _ of contracts.matchAll(/^import (?!type )/gm)) {
    assert.fail('contracts.ts 存在值导入');
  }
});

test('agent-service.ts re-exports its contracts and keeps the state object', async () => {
  const service = await readFile(SERVICE, 'utf8');
  assert.ok(
    service.includes("export * from '../agent/contracts.js';"),
    'agent-service.ts 必须转发契约，否则旧导入路径会断',
  );
  // 契约不应在入口文件里重复声明。
  for (const name of ['AgentServiceOptions', 'AgentOperationView']) {
    assert.equal(
      new RegExp(`^export interface ${name}\\b`, 'm').test(service),
      false,
      `${name} 仍在 agent-service.ts 里重复声明`,
    );
  }
  // 功能分区通过 AgentState 工作。
  assert.ok(service.includes("from '../agent/state.js'"), 'agent-service.ts 应使用 AgentState');
  assert.ok(service.includes('this.state = {'), '构造函数应把共享状态收进 state 对象');
  assert.ok(
    service.includes('return startOperation(this.state'),
    'start 应委托给 agent/operations.ts',
  );
});

test('every optional dependency is wired into the agent state', async () => {
  // 回归：AgentState 的可选字段漏带时编译器不会报错（可选属性可以缺失），
  // 但运行时它们会静默变成 undefined——表现为"配了预算台账却不生效"。
  // 这条断言把"接口里有、装配时忘了"变成显式失败。
  const state = await readFile(`${AGENT_DIR}/state.ts`, 'utf8');
  const service = await readFile(SERVICE, 'utf8');

  const declared = [...state.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  for (const field of declared) {
    assert.ok(
      new RegExp(`^\\s*${field}:`, 'm').test(service),
      `AgentState.${field} 在 state.ts 里声明了，但装配时没有赋值`,
    );
  }
});

test('task orchestration is split per entry, with no orphan module', async () => {
  // start／startApply／resumeApply 是三条不同的流程（发起规划、发起应用、批准后恢复），
  // 各自成文件后租约与许可的语义才好各自讲清楚。
  const dir = `${AGENT_DIR}/operations`;
  const files = await readdir(dir);
  const modules = files.filter((name) => name.endsWith('.ts')).sort();
  assert.deepEqual(
    modules,
    ['apply.ts', 'index.ts', 'shared.ts', 'start.ts'],
    `operations/ 下的模块与预期不符: ${modules.join(', ')}`,
  );

  const sources = new Map<string, string>();
  for (const module of modules) {
    sources.set(module, await readFile(`${dir}/${module}`, 'utf8'));
  }
  const all = [...sources.values()].join('\n');

  // 每个业务模块都要被 index.ts 转发，否则等于写了没人用。
  const index = sources.get('index.ts')!;
  for (const module of ['shared', 'start', 'apply']) {
    assert.ok(index.includes(`'./${module}.js'`), `index.ts 未转发 ${module}.ts`);
    assert.ok(all.includes(`operations/${module}.js`) || index.includes(`'./${module}.js'`));
  }

  // 入口服务只认 index，不直接摸具体模块——这样再拆一个流程不用改它。
  const service = await readFile(SERVICE, 'utf8');
  assert.ok(
    service.includes("from '../agent/operations/index.js'"),
    'agent-service.ts 应通过 index 引用任务编排',
  );

  // 三个入口各自导出，避免又挤回一个文件。
  for (const [module, exported] of [
    ['start.ts', 'export async function startOperation'],
    ['apply.ts', 'export async function startApplyOperation'],
    ['apply.ts', 'export async function resumeApplyOperation'],
    ['shared.ts', 'export function viewOperation'],
  ] as const) {
    assert.ok(sources.get(module)!.includes(exported), `${module} 缺少 ${exported}`);
  }

  // 旧的单文件不应复活。
  const oldExists = await readFile(`${AGENT_DIR}/operations.ts`, 'utf8').then(
    () => true,
    () => false,
  );
  assert.equal(oldExists, false, 'agent/operations.ts 已拆成目录，不应再存在单文件');
});

test('the tool catalog is defined in exactly one place', async () => {
  // 目录按"改哪一类工具"拆到 catalog/ 下，本文件守住拆分结果：
  // 模块清单固定、三块都被登记、门面不重新长回单体。
  const dir = `${AGENT_DIR}/catalog`;
  const modules = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
  assert.deepEqual(
    modules,
    ['deps.ts', 'index.ts', 'places.ts', 'planning.ts', 'trip.ts'],
    `catalog/ 下的模块与预期不符: ${modules.join(', ')}`,
  );

  const sources = new Map<string, string>();
  for (const module of modules) {
    sources.set(module, await readFile(`${dir}/${module}`, 'utf8'));
  }

  // 每个业务模块都要被 index.ts 登记，否则等于写了没人用（孤儿模块）。
  const index = sources.get('index.ts')!;
  for (const module of ['places', 'planning', 'trip']) {
    assert.ok(index.includes(`'./${module}.js'`), `index.ts 未登记 ${module}.ts`);
  }

  // 工具定义必须真的存在，而不是空壳。
  const all = [...sources.values()].join('\n');
  const registered = [...all.matchAll(/name: '([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  assert.equal(registered.length, 13, `工具数量应为 13，实际 ${registered.length}`);
  assert.equal(
    new Set(registered).size,
    registered.length,
    `工具名重复: ${registered.join(', ')}`,
  );
  for (const tool of ['trip.read', 'plan.propose', 'plan.apply']) {
    assert.ok(registered.includes(tool), `工具目录缺少 ${tool}`);
  }

  // 权限策略与副作用必须一致：写工具一律要用户许可。
  // 这是最危险的一类漂移——搬运时把 requires_user_grant 掉了，模型就能自己改正式计划。
  const blocks = all.split('deps.gateway.register({').slice(1);
  assert.equal(blocks.length, 13, 'register 块数量与工具数量不一致');
  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('handler:'));
    const name = (head.match(/name: '([^']+)'/) ?? [])[1];
    const effect = (head.match(/effect: '([^']+)'/) ?? [])[1];
    const policy = (head.match(/permissionPolicy: '([^']+)'/) ?? [])[1];
    assert.ok(name && effect && policy, `${name ?? '未知工具'} 缺少 effect 或 permissionPolicy`);
    if (effect === 'write') {
      assert.equal(
        policy,
        'requires_user_grant',
        `${name} 是写工具，但权限策略是 ${policy}`,
      );
    }
  }

  // 许可在 handler 里消耗的只能是有明确落点的那一个：
  // 其余写工具由网关统一"先消费再执行"，失败即作废，不存在被吞掉又留活的许可。
  const handlerConsumed = blocks
    .filter((block) => block.slice(0, block.indexOf('handler:')).includes("grantConsumption: 'handler'"))
    .map((block) => (block.match(/name: '([^']+)'/) ?? [])[1]);
  assert.deepEqual(handlerConsumed, ['plan.apply'], `grantConsumption: 'handler' 出现在 ${handlerConsumed.join(', ')}`);

  // 兼容工具清单集中在工程契约，新增工具必须同时登记权限与结果。
  const doc = await readFile(`${process.cwd()}/docs/工程设计与接口契约.md`, 'utf8');
  const section = doc.slice(doc.indexOf('### 旅行兼容工具清单'), doc.indexOf('### 个人工具维护入口'));
  const documented = section
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---'))
    .flatMap((line) => line.split('|')[1].split('/'))
    .map((cell) => cell.replace(/（.*?）/g, '').trim())
    .filter((cell) => /^[a-z]+\.[a-z]+$/.test(cell));
  assert.deepEqual(
    documented.sort(),
    [...registered].sort(),
    '代码里的工具与工程契约的旅行兼容清单不一致',
  );

  // 入口文件不应再内联工具定义（两处定义会导致权限策略漂移）。
  const service = await readFile(SERVICE, 'utf8');
  assert.ok(
    service.includes('registerToolCatalog('),
    'agent-service.ts 应通过 registerToolCatalog 注册工具',
  );
  assert.equal(
    /name: '[a-z]+\.[a-z]+'/.test(service),
    false,
    'agent-service.ts 里又出现了内联工具定义',
  );

  // 旧的单文件已改为门面：只转发，不再承载定义。
  const facade = await readFile(`${AGENT_DIR}/tool-catalog.ts`, 'utf8');
  assert.equal(
    facade.includes('gateway.register('),
    false,
    'agent/tool-catalog.ts 里又出现了工具定义，应改 catalog/ 下的对应模块',
  );
  assert.ok(
    facade.split('\n').length < 20,
    `agent/tool-catalog.ts 有 ${facade.split('\n').length} 行，门面不应承载实现`,
  );
});

test('agent-service.ts keeps shrinking rather than regrowing', async () => {
  const service = await readFile(SERVICE, 'utf8');
  const lines = service.split('\n').length;
  // 拆分前 1037 行；外迁工具目录、契约、状态、任务编排与持久化后 190 行。
  // 这里只剩门面：构造函数、状态持有与一行委托。
  assert.ok(lines < 220, `agent-service.ts 有 ${lines} 行，应只做门面`);

  // 编排与持久化的核心逻辑不应再出现在入口文件里。
  for (const leaked of [
    'AgentRuntime',
    'operations.claim(',
    'operations.pause(',
    'executeBatch(',
    'JSON.stringify({',
  ]) {
    assert.equal(service.includes(leaked), false, `${leaked} 应只在 agent/ 对应模块里`);
  }
});
