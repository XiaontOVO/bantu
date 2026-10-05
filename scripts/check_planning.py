"""Check current docs, links and implementation references; not runtime acceptance."""
from pathlib import Path
import json
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
errors = []
checks = []


def check(condition, message):
    (checks if condition else errors).append(message)


files = [ROOT / 'README.md', *sorted(DOCS.glob('*.md'))]
texts = {p.name: p.read_text(encoding='utf-8') for p in files}
index = texts.get('文档索引.md', '')
contract = texts.get('工程设计与接口契约.md', '')

for path in files:
    body = texts[path.name]
    check('\ufffd' not in body and not body.startswith('\ufeff'), f'UTF-8: {path.name}')
    check(body.startswith('# '), f'Title: {path.name}')
    numbered = re.match(r'(\d{2})-', path.name)
    if numbered:
        check(body.startswith(f'# {numbered.group(1)}｜'), f'Title number: {path.name}')
    if path.parent == DOCS and path.name != '文档索引.md':
        check(f']({path.name})' in index, f'Indexed: {path.name}')

    outside = []
    fence = None
    language = ''
    block = []
    for line in body.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})(.*)$', line)
        if marker and fence is None:
            fence = marker.group(1)
            language = marker.group(2).strip()
            block = []
        elif marker and fence and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and not marker.group(2).strip():
            if language == 'json':
                try:
                    json.loads('\n'.join(block))
                    checks.append(f'JSON: {path.name}')
                except json.JSONDecodeError as exc:
                    errors.append(f'JSON: {path.name}: {exc}')
            fence = None
        elif fence:
            block.append(line)
        else:
            outside.append(line)
    check(fence is None, f'Closed fences: {path.name}')
    prose = '\n'.join(outside)

    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', prose):
        target = target.strip().strip('<>')
        if re.match(r'^[a-z][a-z\d+.-]*:|^#', target, re.I):
            continue
        local = unquote(target.split('#', 1)[0])
        check((path.parent / local).is_file(), f'Link: {path.name} -> {local}')

    widths = []
    for line in outside + ['']:
        if line.startswith('|'):
            widths.append(len(re.split(r'(?<!\\)\|', line)) - 2)
        elif widths:
            check(len(set(widths)) == 1, f'Table: {path.name}')
            widths = []

    # Only concrete repo paths, not relative shorthand or future design claims.
    for ref in set(re.findall(r'(?<![\w/])((?:src|public|scripts|tests)/[\w./-]+\.(?:ts|js|mjs|json|py|css|svg)\b)', body)):
        check((ROOT / ref).is_file(), f'Code path: {path.name} -> {ref}')

endpoints = re.findall(r'^\| (GET|POST|PUT|PATCH|DELETE) (/[^ |]+) \|', contract, re.M)
check(len(endpoints) == len(set(endpoints)), 'Unique API inventory')
required = {
    ('GET', '/plans'), ('POST', '/plans'), ('PUT', '/plans/:planId'),
    ('DELETE', '/plans/:planId'), ('POST', '/plans/:planId/load'),
    ('POST', '/plans/:planId/execution-events'),
    ('POST', '/plans/:planId/execution-corrections'),
    ('POST', '/plans/:planId/restore'), ('GET', '/agent/chat'),
    ('POST', '/agent/chat'), ('DELETE', '/agent/task'),
    ('POST', '/account/register'), ('POST', '/account/login'),
    ('GET', '/memories'), ('POST', '/routes'),
    ('PATCH', '/community/posts/:postId'),
}
check(required <= set(endpoints), 'Current workflow API coverage')
check(bool(index) and bool(texts.get('产品体验全盘核查.md')), 'Current index and audit present')
for name in ('作品说明与演示.md', '产品与交互规格.md', '工程设计与接口契约.md',
             '运行与部署.md', '计划与进度三态转换逻辑.md', '景点示意图绘制规范.md'):
    check(bool(texts.get(name)), f'Canonical document: {name}')
check((DOCS / '作品介绍.html').is_file(), 'Standalone presentation present')
audit = texts.get('产品体验全盘核查.md', '')
issue_ids = re.findall(r'^\| (UX\d{2}) /', audit, re.M)
check(len(issue_ids) == len(set(issue_ids)) and len(issue_ids) >= 1, 'Unique audit issues')

retired = ['05-开发任务与验收计划.md', '06-决策登记与场景验算.md',
           '08-落实前全盘审查与开工结论.md', '规划审查与修订记录.md',
           '体验测试缺陷记录-2026-09-23.md']
retired += ['项目总体规划.md', '01-产品模块与功能规格.md',
            '02-系统架构与核心流程.md', '03-数据模型与接口契约.md',
            '04-页面与交互设计.md', '07-Agent与工具授权设计.md',
            '09-代码模块地图.md', '10-社区发现与平台收录.md',
            '伴途随行整体规划.md', '地图路线与收藏使用说明.md',
            '本地运行与排障.md', '邀请测试部署.md',
            '本地账号与社区测试.md', '行程模块验收记录.md']
for name in retired:
    check(not (DOCS / name).exists(), f'Retired: {name}')

print(f'Documents: {len(files)}; API entries: {len(endpoints)}; audit issues: {len(issue_ids)}')
for error in errors:
    print('FAIL:', error)
print(f'{"FAIL" if errors else "PASS"}: {len(checks)} checks; {len(errors)} errors.')
print('Scope: local docs and references only; no runtime, provider or field acceptance.')
sys.exit(1 if errors else 0)
