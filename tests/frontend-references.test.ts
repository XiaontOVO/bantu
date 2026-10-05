/**
 * 前端模块引用守卫。
 *
 * 这条断言来自一次真实事故：把视图拆成模块时，`render.js` 的 renderers 映射引用了
 * 七个 `renderXxx` 却没有 import 它们——`const renderers = { home: renderHome, ... }`
 * 会在**模块求值阶段**就抛 ReferenceError，页面直接白屏。
 * 同时另外两个视图用了 `.map(placeCard)` / `.map(timelineItem)` 这种**裸引用**，
 * 不是 `foo(` 调用形式。
 *
 * `node --check` 查不出这类问题（语法合法），模块图测试也查不出（路径是对的），
 * 只有真正跑浏览器才会暴露。所以这里静态检查：每个模块里出现的导出名，
 * 要么自己声明，要么 import 进来。
 *
 * 第二次事故（同一个检查没拦住）：`render.js`／`commands.js`／`actions.js` 都用了
 * `store.js` 导出的 `$` 却没 import，于是 `render()` 第一行就 ReferenceError，整页白屏。
 * 检查本身有两个漏洞，都出在"名字怎么匹配"上：
 *   1. 收集导出名用的是 `\w+`，而 `\w` 不含 `$`，所以 `export const $ = …` 从来没进过候选集；
 *   2. 引用判断用的是 `\b`，但 `$` 不是词字符，`$(` 后面根本不存在词边界。
 * 现在两边都按"JS 标识符"匹配（`[\w$]+`），词边界换成 `(?![\w${])`
 * ——多排除一个 `{` 是因为模板字符串里的 `${…}` 不是对 `$` 的引用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { frontendScriptPaths } from './ui-source.js';
import ts from 'typescript';

const PUBLIC_DIR = join(process.cwd(), 'public');

/** JS 标识符（含 `$`，`\w` 不含它）。 */
const IDENT = '[\\w$]+';
/** 引用结尾：后面不能紧跟标识符字符、`$` 或模板插值的 `{`。 */
const BOUNDARY = '(?![\\w${])';

/** 去掉 import 区块、注释与 data-* 属性值：它们里面的名字不是"引用"。 */
function stripNonCode(source: string): string {
  return source
    .replace(/^import[\s\S]*?from '[^']+';\s*$/gm, '')
    // Dynamic import paths are strings; namespace member calls are handled below.
    .replace(/\bimport\(\s*(['"])[^'"]+\1\s*\)/g, 'importModule()')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // API paths are string values, not references to the imported `api` helper.
    .replace(/\/api(?=\/)/g, '    ')
    .replace(
      /data-(?:action|nav|view|event|type|stop|place|category|trip|rating)="[^"]*"/g,
      '',
    );
}

function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'[^']+';/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolve lexical bindings, including destructured parameters and object methods. */
function unboundNames(sources: Map<string, string>): Map<string, Set<string>> {
  const normalized = (path: string) => path.replaceAll('\\', '/');
  const absolute = new Map([...sources].map(([path, source]) => [normalized(join(PUBLIC_DIR, path)), source]));
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noEmit: true, noResolve: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host), originalReadFile = host.readFile.bind(host);
  host.fileExists = path => absolute.has(normalized(path)) || originalFileExists(path);
  host.readFile = path => absolute.get(normalized(path)) ?? originalReadFile(path);
  const originalSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, createNewSourceFile) => {
    const source = absolute.get(normalized(path));
    return source === undefined ? originalSourceFile(path, languageVersion, onError, createNewSourceFile)
      : ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.JS);
  };
  const program = ts.createProgram([...absolute.keys()], options, host), checker = program.getTypeChecker();
  const results = new Map<string, Set<string>>();
  for (const [path] of sources) {
    const unresolved = new Set<string>(), file = program.getSourceFile(join(PUBLIC_DIR, path));
    assert.ok(file, `Reference guard did not parse ${path}`);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const property = ts.isPropertyAccessExpression(parent) && parent.name === node ||
          ts.isPropertyAssignment(parent) && parent.name === node ||
          ts.isMethodDeclaration(parent) && parent.name === node;
        if (!property && !checker.getSymbolAtLocation(node)) unresolved.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file); results.set(path, unresolved);
  }
  return results;
}

test('reference guard accepts local parameters and methods while detecting missing bare helpers', () => {
  const fixture = 'reference-guard-fixture.js';
  const unresolved = unboundNames(new Map([[fixture, `
    export function back({state,navigate,dismissSheet}) { navigate(state); dismissSheet(); }
    const runtime={bootstrap(){return true}}; runtime.bootstrap();
    missingHelper(); const callback=()=>lostState;
  `]])).get(fixture)!;
  assert.deepEqual([...unresolved].sort(), ['lostState', 'missingHelper']);
});

/**
 * 某个名字是否在模块体里被当作"外部引用"使用。
 *
 * `$` 要单独处理：它是唯一以非词字符结尾的标识符，且正则字面量里的行尾锚点
 * （`/^(\d{4})$/`）会被通用规则误判成引用。`$` 在本项目里只以 `$('id')` 形式出现，
 * 因此只承认这种调用形式——通用规则仍然覆盖所有普通名字。
 */
function isReferenced(name: string, body: string): boolean {
  if (name === '$') return /(?:^|[^.\w$])\$\s*\(/.test(body);
  return new RegExp(`(?:^|[^.\\w$])${escapeName(name)}${BOUNDARY}`).test(body);
}

test('every name a frontend module uses is declared or imported', async () => {
  // 第三方 bundle 在各自模块作用域内复用压缩变量名，不属于应用模块引用检查。
  const files = (await frontendScriptPaths()).filter(path => !/^vendor[\\/]/.test(path));
  const sources = new Map<string, string>();
  for (const path of files) {
    sources.set(path, await readFile(join(PUBLIC_DIR, path), 'utf8'));
  }

  // 所有模块对外导出的名字，作为"可能在别处被使用"的集合
  const exported = new Set<string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+${IDENT}`, 'g'))) {
      exported.add(m[0].split(/\s+/).pop()!);
    }
    for (const m of source.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${IDENT})`, 'g'))) {
      exported.add(m[1]);
    }
  }
  assert.ok(exported.size >= 20, `只解析到 ${exported.size} 个导出，检查本身可能失效了`);
  // 回归：`$` 曾经因为 `\w+` 不匹配它而完全不在候选集里，导致三处漏 import 全部漏检。
  assert.ok(
    exported.has('$'),
    '导出名解析漏掉了 `$`（JS 标识符包含 $，不能用 \\w+ 收集）',
  );

  const problems: string[] = [];
  const unresolved = unboundNames(sources);
  for (const [path, source] of sources) {
    const imported = importedNames(source);
    const body = stripNonCode(source);
    for (const name of exported) {
      if (imported.has(name)) continue;
      if (!unresolved.get(path)?.has(name)) continue;
      const escape = escapeName(name);
      // 属性名（obj.foo）不算引用导出的那个名字
      if (!isReferenced(name, body)) continue;
      if (new RegExp(`(?:^|\\s)(?:async\\s+)?function\\s+${escape}${BOUNDARY}`).test(body)) continue;
      if (new RegExp(`(?:const|let|var)\\s+${escape}${BOUNDARY}`).test(body)) continue;
      problems.push(`${path}: ${name}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `这些名字被使用但没有 import（浏览器会报 ReferenceError）:\n  ${problems.join('\n  ')}`,
  );
});

test('no module calls a helper that another module keeps private', async () => {
  // 回归：把 toggleLargeText/toggleTheme 留在入口文件里、动作表却调用它们时，
  // 这两个名字既不是"导出名"也不是本文件声明，前一条检查抓不到——
  // 只有点击设置页的主题按钮才会 ReferenceError。
  // 这里反过来做：收集每个文件的顶层声明，检查别的文件是否调用了它却未 import。
  // 第三方 bundle 在各自模块作用域内复用压缩变量名，不属于应用模块引用检查。
  const files = (await frontendScriptPaths()).filter(path => !/^vendor[\\/]/.test(path));
  const sources = new Map<string, string>();
  for (const path of files) {
    sources.set(path, await readFile(join(PUBLIC_DIR, path), 'utf8'));
  }

  const declaredIn = new Map<string, string[]>();
  for (const [path, source] of sources) {
    const names: string[] = [];
    for (const m of source.matchAll(new RegExp(`^\\s{4}(?:const|let|var)\\s+(${IDENT})`, 'gm'))) {
      names.push(m[1]);
    }
    for (const m of source.matchAll(
      new RegExp(`^\\s{2,6}(?:export\\s+)?(?:async\\s+)?function\\s+(${IDENT})`, 'gm'),
    )) {
      names.push(m[1]);
    }
    declaredIn.set(path, names);
  }

  const problems: string[] = [];
  const unresolved = unboundNames(sources);
  for (const [path, source] of sources) {
    const imported = importedNames(source);
    const own = new Set(declaredIn.get(path) ?? []);
    const body = stripNonCode(source);
    for (const [other, names] of declaredIn) {
      if (other === path) continue;
      for (const name of names) {
        if (own.has(name) || imported.has(name)) continue;
        if (!unresolved.get(path)?.has(name)) continue;
        if (!new RegExp(`(?:^|[^.\\w$])${escapeName(name)}\\s*\\(`).test(body)) continue;
        problems.push(`${path} 调用了 ${other} 里的 ${name}，但没有 import`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('every relative import points at a file that exists', async () => {
  // 第三方 bundle 在各自模块作用域内复用压缩变量名，不属于应用模块引用检查。
  const files = (await frontendScriptPaths()).filter(path => !/^vendor[\\/]/.test(path));
  const broken: string[] = [];
  for (const path of files) {
    const source = await readFile(join(PUBLIC_DIR, path), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join(dirname(join(PUBLIC_DIR, path)), match[1]);
      const ok = await readFile(target, 'utf8').then(
        () => true,
        () => false,
      );
      if (!ok) broken.push(`${path} -> ${match[1]}`);
    }
  }
  assert.deepEqual(broken, [], `断链的相对 import: ${broken.join(', ')}`);
});
