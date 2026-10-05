import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('public/boot-recovery.js', 'utf8');
function fallback(flags: Record<string, boolean> = {}) {
  const callbacks: Record<string, () => void> = {};
  const overlay = { hidden: true };
  let timeout = () => {};
  const window = { __bantuUiReady:false, ...flags, addEventListener: (event: string, callback: () => void) => { callbacks[event] = callback; } };
  runInNewContext(source, { window,
    document: { addEventListener: () => {}, getElementById: () => overlay },
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 6000); timeout = callback; },
  });
  callbacks.DOMContentLoaded();
  return { overlay, window, fire: () => timeout() };
}

test('independent startup recovery remains available when the app module never runs', () => {
  const page = fallback();
  assert.equal(page.overlay.hidden, true);
  page.fire();
  assert.equal(page.overlay.hidden, false);
});

test('slow initialization does not cover an already usable page or a handled error', () => {
  for (const flag of ['__bantuBooted', '__bantuUiReady', '__bantuRecoveryShown']) {
    const page = fallback({ [flag]: true });
    page.fire();
    assert.equal(page.overlay.hidden, true, flag);
  }
});

test('classic recovery checks readiness when its deadline arrives', () => {
  const page = fallback({ __bantuUiReady: false });
  page.window.__bantuUiReady = true;
  page.fire();
  assert.equal(page.overlay.hidden, true);
});
