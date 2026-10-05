import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { renderMessageMarkdown } = await import(pathToFileURL(resolve('public/lib/message-markdown.js')).href);

test('agent markdown renders structured travel advice, tables and code', () => {
  const html = renderMessageMarkdown('## 下午安排\n\n**先休息**\n\n1. 喝茶\n2. 逛展\n\n| 地点 | 时间 |\n| --- | --- |\n| 茶馆 | 14:00 |\n\n> 留出交通时间\n\n```text\n<example>\n```');
  for (const tag of ['<h2>', '<strong>', '<ol>', '<table>', '<blockquote>', '<pre>']) assert.ok(html.includes(tag));
  assert.ok(html.includes('&lt;example&gt;'));
});

test('agent markdown escapes HTML and rejects executable links and remote images', () => {
  const html = renderMessageMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n![tracking](https://example.com/pixel)\n\n[地图](https://example.com/map)');
  assert.ok(!html.includes('<script') && !html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://example.com/map"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});
