import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { safeLocalPhotoPath, imageViewerHtml } = await import(pathToFileURL(resolve('public/lib/image-viewer.js')).href);

test('photo viewing preserves local originals and rejects external or traversing paths', () => {
  for (const path of ['/images/places/photos/westbund-2.jpg', '/uploads/photo.avif?size=full', '/images/a%20b.webp']) {
    assert.equal(safeLocalPhotoPath(path), path);
  }
  for (const path of ['https://example.com/photo.jpg', '//example.com/photo.jpg', 'javascript:alert(1)', '/images/../photo.jpg', '/images/%2e%2e/photo.jpg', '/images/%5cphoto.jpg', '/%2fexample.com/photo.jpg', '/images/photo.svg', '/images/%zz.jpg']) {
    assert.equal(safeLocalPhotoPath(path), '', path);
  }
});

test('the photo and impression viewer provides a delegated, labelled close action and escapes image metadata', () => {
  const html = imageViewerHtml({ src: '/images/photo.jpg', title: '<img onerror=alert(1)>', alt: '" onload="alert(1)' });
  assert.match(html, /type="button"[^>]*data-action="close-sheet"[^>]*aria-label="关闭大图"/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  assert.match(html, /alt="&quot; onload=&quot;alert\(1\)"/);
  assert.doesNotMatch(html, /<img onerror=|place-floorplan-viewer/);
});
