import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;
const components = await load('public/lib/components.js');
const linkClick = await load('public/lib/link-click.js');
const { readFrontendScripts } = await import('./ui-source.js');

test('place cards use a native detail link and keep favorite outside the link', async () => {
  const html = components.placeCard({
    placeId: 'place_1', name: '西湖白堤', category: 'landmark', facilityCodes: [],
    description: '沿湖步行道',
  });
  const article = html.match(/<article class="place-card[^>]*>([\s\S]*?)<\/article>/)?.[1] || '';
  const link = article.match(/<a class="place-card-main"[\s\S]*?<\/a>/)?.[0] || '';
  assert.ok(link.includes('href="#/place/place_1"'), 'the primary card action should be a real keyboard-operable link');
  assert.ok(link.includes('<h4>西湖白堤</h4>'));
  assert.equal(link.includes('<button'), false, 'interactive actions must not be nested inside the link');
  assert.equal(article.includes('role="link"'), false, 'the article itself must not impersonate a link');
  assert.ok(article.indexOf('</a>') < article.indexOf('data-action="shortlist"'), 'favorite should be a sibling action');

  const scripts = await readFrontendScripts();
  assert.match(scripts, /if \(actionButton\.matches\('a\[href\]'\)\)\s*\{\s*if \(!isUnmodifiedPrimaryClick\(event\)\) return;\s*event\.preventDefault\(\);\s*\}/,
    'only a plain primary click should enter delegated SPA routing');
});

test('modified and non-primary link activations stay native', () => {
  const isPlain = linkClick.isUnmodifiedPrimaryClick;
  assert.equal(isPlain({ button: 0 }), true, 'ordinary primary click should use SPA routing');
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    assert.equal(isPlain({ button: 0, [modifier]: true }), false, `${modifier} should preserve native link behavior`);
  }
  assert.equal(isPlain({ button: 1 }), false, 'middle click should preserve native new-tab behavior');
  assert.equal(isPlain({ button: 2 }), false, 'secondary click should not trigger SPA navigation');
});
