/**
 * 服务层模块结构守卫。
 *
 * 拆分 TripService 的价值在于契约与实现分离、功能分区可以各自长大，
 * 因此这里断言：
 * 1. 契约集中在 trip/contracts.ts，且是**纯类型**模块（不含运行时逻辑）；
 * 2. trip-service.ts 仍然对外暴露同一套契约（老 import 路径不能断）；
 * 3. trip-service.ts 不再自己声明这些契约，避免两处定义漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const TRIP_DIR = `${process.cwd()}/src/services/trip`;
const SERVICE = `${process.cwd()}/src/services/trip-service.ts`;

test('trip contracts live in a types-only module', async () => {
  const contracts = await readFile(`${TRIP_DIR}/contracts.ts`, 'utf8');

  // 必须真的声明了对外契约，而不是空壳。
  for (const name of [
    'ServiceError',
    'ServiceResult',
    'Principal',
    'Session',
    'TripRecord',
    'TripView',
    'ProposalView',
    'CreateTripInput',
    'PatchTripInput',
    'ApplyProposalCommand',
    'UndoCommand',
    'ExecutionCommand',
    'SpendCommand',
  ]) {
    assert.ok(
      new RegExp(`export (interface|type) ${name}\\b`).test(contracts),
      `contracts.ts 缺少 ${name}`,
    );
  }

  // 纯类型模块：不应出现可执行语句，否则 http/agent 层引用契约时会连带拉进实现。
  assert.equal(/^function /m.test(contracts), false, 'contracts.ts 不应包含函数实现');
  assert.equal(/^export function /m.test(contracts), false, 'contracts.ts 不应导出函数');
  assert.equal(/^class /m.test(contracts), false, 'contracts.ts 不应包含类');
  assert.equal(/^export class /m.test(contracts), false, 'contracts.ts 不应导出类');
  // 所有 import 都必须是 type-only
  for (const match of contracts.matchAll(/^import (?!type )/gm)) {
    assert.fail(`contracts.ts 存在值导入：${match[0]}`);
  }
});

test('trip-service.ts re-exports the contracts so existing imports keep working', async () => {
  const service = await readFile(SERVICE, 'utf8');
  assert.ok(
    service.includes("export * from './trip/contracts.js';"),
    'trip-service.ts 必须转发契约，否则 services/trip-service.js 的旧导入会断',
  );

  // 契约不应在入口文件里重复声明。
  for (const name of ['ServiceError', 'TripView', 'ProposalView', 'TripRecord']) {
    assert.equal(
      new RegExp(`^export (interface|type) ${name}\\b`, 'm').test(service),
      false,
      `${name} 仍在 trip-service.ts 里重复声明`,
    );
  }
});

test('trip service is built from focused modules sharing one state object', async () => {
  const service = await readFile(SERVICE, 'utf8');

  // 功能分区通过 TripState 工作，而不是各自持有私有 Map。
  assert.ok(service.includes("from './trip/state.js'"), 'trip-service.ts 应使用 TripState');
  assert.ok(
    service.includes('this.state = {'),
    '构造函数应把共享状态收进 state 对象',
  );

  // 门面必须引用它实际委托的模块。
  // （access／commit／helpers 是 trip/ 内部构件，只在分区模块之间使用，
  //   门面不再直接调用它们——这是拆分完成后的正确形态，不应要求门面引用。）
  for (const module of [
    'contracts',
    'state',
    'identity',
    'trips',
    'proposals',
    'apply',
    'execution',
    'memories',
    'controls',
    'persistence',
  ]) {
    assert.ok(
      new RegExp(`from '\\./trip/${module}\\.js'`).test(service),
      `trip-service.ts 未引用 trip/${module}.ts`,
    );
  }

  // 身份逻辑已外迁：入口文件不该再直接做 token 哈希，而应委托给 trip/identity.ts。
  // （loadSerialized 里的 principals.set 是反序列化，属于另一件事，不算违反。）
  assert.equal(service.includes('hashToken('), false, 'hashToken 应只在 trip/identity.ts 使用');
  assert.ok(
    service.includes('return createAnonymousSession(this.state'),
    'createAnonymousSession 应委托给 trip/identity.ts',
  );
  assert.ok(
    service.includes('return activePrincipal(this.state'),
    'activePrincipal 应委托给 trip/identity.ts',
  );

  // 已外迁分区的核心逻辑不应再出现在入口文件里。
  for (const leaked of [
    'applyExecutionEvent(',
    'applyExecutionCorrection(',
    'recordSpendEvent(',
    'recordWalkingEvent(',
    'createMemoryNote(',
    'generateRecapDraft(',
    'createInitialVersion(',
    'emptyFreshSnapshot(',
    'startTrip(record.snapshot)',
    'applyProposal as applyProposalDomain',
    'assertCanApply(',
    'undoLastPlanApply(',
    'evaluateCandidate(',
    'checkConstraint(',
    'commitPlanSnapshot(this.state',
  ]) {
    assert.equal(service.includes(leaked), false, `${leaked} 应只在 trip/ 对应模块里`);
  }

  // 提案生成与许可应用是两个不同关注点，不应挤回同一个模块。
  const proposals = await readFile(`${TRIP_DIR}/proposals.ts`, 'utf8');
  const apply = await readFile(`${TRIP_DIR}/apply.ts`, 'utf8');
  assert.ok(proposals.includes('export function createProposal'), 'proposals.ts 负责生成提案');
  assert.equal(
    proposals.includes('assertCanApply('),
    false,
    '许可校验属于 apply.ts，不应回到 proposals.ts',
  );
  assert.ok(apply.includes('export function applyProposal'), 'apply.ts 负责应用与撤销');
  assert.ok(apply.includes('export function undo'), 'apply.ts 负责应用与撤销');
  assert.equal(
    apply.includes('export function createProposal'),
    false,
    '提案生成属于 proposals.ts，不应出现在 apply.ts',
  );
});

test('every trip module is actually wired in, and none is orphaned', async () => {
  const files = (await readdir(TRIP_DIR)).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 11, `trip/ 模块数偏少：${files.length}`);

  // 汇总 src/ 下所有文件内容，逐个模块确认"有人引用它"。
  // 这能抓到"写了模块却忘了接上"——门面引用不到的构件也必须在别的分区里被用到。
  const sources = await readdir(`${process.cwd()}/src`, { recursive: true });
  const contents = [];
  for (const entry of sources) {
    const path = `${process.cwd()}/src/${entry}`;
    if (!path.endsWith('.ts')) continue;
    contents.push(await readFile(path, 'utf8'));
  }
  const all = contents.join('\n');

  for (const file of files) {
    const module = file.replace(/\.ts$/, '');
    if (module === 'state' || module === 'contracts') continue; // 类型模块由门面引入
    // 分区之间用 './x.js'，门面与其它层用 'trip/x.js'，两种都算被引用。
    const referenced =
      all.includes(`trip/${module}.js`) || all.includes(`'./${module}.js'`);
    assert.ok(referenced, `trip/${module}.ts 没有被任何文件引用（写了模块但没接上）`);
  }
});

test('trip-service.ts keeps shrinking rather than regrowing', async () => {
  const service = await readFile(SERVICE, 'utf8');
  const lines = service.split('\n').length;
  // 拆分前 1548 行；11 个分区模块全部外迁后 306 行。
  // 这里只剩门面：构造函数、状态持有与一行委托。任何明显增长都意味着逻辑又写回来了。
  // One additional line is a public facade delegate for invalidating memories sourced from deleted chat messages.
  assert.ok(lines < 331, `trip-service.ts 有 ${lines} 行，应只做门面`);
});
