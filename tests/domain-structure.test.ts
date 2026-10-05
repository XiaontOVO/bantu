/**
 * 领域层模块结构守卫。
 *
 * 领域层是"没有网络、没有数据库也应该成立"的那部分，也是安全边界所在
 * （许可怎么算、什么时候算同意）。因此这里的文件边界值得单独守住：
 * 契约集中在门面、实现按关注点分开、旧的大文件不得复活。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const DOMAIN_DIR = `${process.cwd()}/src/domain`;

const readOrNull = (path: string) =>
  readFile(path, 'utf8').then(
    (text) => text,
    () => null,
  );

test('action authorization is split by concern behind a facade', async () => {
  const modules = (await readdir(`${DOMAIN_DIR}/authorization`)).filter((n) =>
    n.endsWith('.ts'),
  );
  assert.deepEqual(
    modules.sort(),
    ['digest.ts', 'index.ts', 'service.ts', 'text.ts'],
    `authorization/ 下的模块与预期不符: ${modules.join(', ')}`,
  );

  // 门面必须存在且很薄：它的唯一职责是转发，不承载实现。
  const facade = await readFile(`${DOMAIN_DIR}/authorization.ts`, 'utf8');
  assert.ok(
    facade.includes("export * from './authorization/index.js';"),
    'authorization.ts 应转发 authorization/index.ts',
  );
  assert.ok(
    facade.split('\n').length < 20,
    `authorization.ts 有 ${facade.split('\n').length} 行，门面不应承载实现`,
  );

  const index = await readFile(`${DOMAIN_DIR}/authorization/index.ts`, 'utf8');
  for (const module of ['text', 'digest', 'service']) {
    assert.ok(index.includes(`'./${module}.js'`), `index.ts 未转发 ${module}.ts`);
  }

  // 三个关注点各自导出自己的东西，避免又挤回一个文件。
  const expectations: Array<[string, string]> = [
    ['text.ts', 'export function parseConfirmationText'],
    ['text.ts', 'export function resolveDisplayedAction'],
    ['text.ts', 'export function parseDirectCommand'],
    ['digest.ts', 'export function digestArgs'],
    ['service.ts', 'export class ActionAuthorizationService'],
  ];
  for (const [module, marker] of expectations) {
    const source = await readFile(`${DOMAIN_DIR}/authorization/${module}`, 'utf8');
    assert.ok(source.includes(marker), `${module} 缺少 ${marker}`);
  }
});

test('the domain entry still exposes the authorization surface', async () => {
  // 保留 authorization.ts 门面的意义就在这里：既有导入路径不能断。
  const entry = await readFile(`${DOMAIN_DIR}/index.ts`, 'utf8');
  assert.ok(
    entry.includes("export * from './authorization.js';"),
    'domain/index.ts 应继续转发 authorization.js',
  );

  // 具体调用方仍按老路径导入，不应被迫改到 authorization/ 内部。
  const callers = [
    'src/services/message-service.ts',
    'src/services/trip-service.ts',
    'src/agent/tools.ts',
    'src/domain/idempotency.ts',
  ];
  for (const caller of callers) {
    const source = await readFile(`${process.cwd()}/${caller}`, 'utf8');
    assert.ok(
      source.includes("from './authorization.js'") ||
        source.includes("from '../domain/authorization.js'"),
      `${caller} 应从 authorization.js（门面）导入，而不是内部路径`,
    );
    assert.equal(
      source.includes('authorization/text.js') ||
        source.includes('authorization/service.js') ||
        source.includes('authorization/digest.js'),
      false,
      `${caller} 不应直接依赖 authorization/ 的内部模块`,
    );
  }
});

test('authorization keeps a single public entry point', async () => {
  // 回归：拆目录时最容易留下"两套入口"——门面和目录各被一半调用方使用。
  // 这里确认只有门面被外部引用。
  const files = ['src/agent/tools.ts', 'src/services/trip-service.ts', 'src/domain/index.ts'];
  for (const file of files) {
    const source = await readFile(`${process.cwd()}/${file}`, 'utf8');
    assert.equal(
      /from '.*authorization\/index\.js'/.test(source),
      false,
      `${file} 应通过 authorization.js 导入，而不是 authorization/index.js`,
    );
  }
  assert.ok(await readOrNull(`${DOMAIN_DIR}/authorization.ts`), 'authorization.ts 门面必须存在');
});
