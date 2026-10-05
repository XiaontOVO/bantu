/**
 * 动作表守卫。
 *
 * 界面里所有可点击元素都靠 `data-action` 走统一委托。在 if 链时代，
 * 动作名拼错只会"点了没反应"——没有报错、没有日志、测试也发现不了。
 * 改成动作表之后，这个不变量变成可校验的：界面里出现的每个 data-action
 * 都必须能在 ACTIONS 里找到处理函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFrontendScripts, readShell } from './ui-source.js';

/** 从 `data-action="x"` / `data-action="' + x + '"` 里抽出动作名。 */
function actionsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/data-action="([^"$]+)"/g)) {
    const value = match[1].trim();
    if (value && !value.includes('(') && !value.includes('+')) found.add(value);
  }
  for (const match of source.matchAll(/planDateChip\(\s*date,\s*\{[^}]*\baction:\s*'([a-z-]+)'/gs)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/transportPickerHtml\([^,]+,\s*\{\s*action:\s*'([a-z-]+)'/g)) {
    found.add(match[1]);
  }
  return found;
}

/**
 * 从动作表对象字面量里抽出**顶层**键名。
 *
 * 只看恰好 6 空格缩进的行：处理函数体里的嵌套对象（`method:`／`body:` 之类）
 * 缩进更深，按"任意含冒号的行"提取会把它们误当成动作名。
 */
function handledActions(appSource: string): Set<string> {
  const body = /const ACTIONS = \{([\s\S]*?)\n    \};/.exec(appSource)?.[1];
  assert.ok(body, 'lib/actions.js 里找不到 ACTIONS 动作表');
  const keys = new Set<string>();
  for (const line of body.split('\n')) {
    const quoted = /^ {6}'([a-z-]+)':/.exec(line);
    if (quoted) {
      keys.add(quoted[1]);
      continue;
    }
    const bare = /^ {6}([a-zA-Z][\w-]*):/.exec(line);
    if (bare) keys.add(bare[1]);
  }
  return keys;
}

test('every data-action in the UI has a handler', async () => {
  const app = await readFile(`${process.cwd()}/public/lib/actions.js`, 'utf8');
  const handled = handledActions(app);
  assert.ok(handled.size >= 25, `动作表只有 ${handled.size} 项，疑似被搬空`);

  // 界面里的动作来源：静态骨架、视图模板、共用片段，以及 app.js 自己弹的面板。
  const html = await readShell();
  const scripts = await readFrontendScripts();
  const used = new Set([...actionsIn(html), ...actionsIn(scripts)]);
  // Date chips share a template that receives its action name from the caller.
  for (const action of ['mount-plan-date', 'plan-view-date']) {
    if (scripts.includes(`action: '${action}'`)) used.add(action);
  }

  const missing = [...used].filter((action) => !handled.has(action)).sort();
  assert.deepEqual(missing, [], `这些 data-action 没有处理函数（点了会没反应）: ${missing.join(', ')}`);
});

test('the action table has no dead entries', async () => {
  const app = await readFile(`${process.cwd()}/public/lib/actions.js`, 'utf8');
  const handled = handledActions(app);
  const html = await readShell();
  const scripts = await readFrontendScripts();
  const used = new Set([...actionsIn(html), ...actionsIn(scripts)]);

  // Date chips share a template that receives its action name from the caller.
  for (const action of ['mount-plan-date', 'plan-view-date']) {
    if (scripts.includes(`action: '${action}'`)) used.add(action);
  }

  // 反向检查：动作表里不该留着界面上已经没有的条目。
  // 少数动作由别处动态拼出（例如删除确认按钮带 data-trip），断言用的是精确匹配，
  // 这里只报告真正的孤儿，避免误伤。
  const dead = [...handled].filter((action) => !used.has(action)).sort();
  assert.deepEqual(dead, [], `动作表里存在界面上用不到的条目: ${dead.join(', ')}`);
});

test('handleAction is a table lookup, not a branch chain', async () => {
  const app = await readFile(`${process.cwd()}/public/lib/actions.js`, 'utf8');
  const body = /async function handleAction\(action, el\) \{([\s\S]*?)\n    \}/.exec(app)?.[1];
  assert.ok(body, '找不到 handleAction');
  assert.ok(body.includes('ACTIONS[action]'), 'handleAction 应查动作表');
  assert.equal(
    /if \(action === /.test(body),
    false,
    'handleAction 不应退回 if 链（新增动作会再次变成"在链里找位置"）',
  );
});
