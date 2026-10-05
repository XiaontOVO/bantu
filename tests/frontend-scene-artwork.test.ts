import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const importSceneModule = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await importSceneModule('public/lib/store.js');
const artwork = await importSceneModule('public/lib/scene-artwork.js');
let fixtureNumber = 0;

function withArtworkFixture(run: (env: any) => void) {
  const previous = { document: globalThis.document, principal: state.principal, view: state.currentView, scene: state.sceneData, place: state.scenePlaceId, revision: state.navigationRevision, accountContextChanged: state.accountContextChanged };
  const scene = { id: `asset-test-${++fixtureNumber}`, placeId: 'test-place', version: 1, artwork: '/images/scene.jpg' };
  const classes = new Set<string>();
  const env: any = { stage: { setAttribute() {}, focus() {} }, hotspots: [{ disabled: false }], fallback: { hidden: true }, topics: { hidden: true }, heading: {}, message: {}, retry: {}, show: {}, hide: {}, focused: false };
  class ArtworkImage extends EventTarget {
    complete = false;
    naturalWidth = 0;
    isConnected = true;
    src = '/images/scene.jpg';
    getAttribute(name: string) { return name === 'src' ? this.src || null : null; }
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
    cloneNode() { return new ArtworkImage(); }
    replaceWith(next: ArtworkImage) { this.isConnected = false; env.image = next; }
  }
  env.image = new ArtworkImage();
  const selectors: Record<string, any> = {
    '.scene-stage': env.stage, '[data-scene-artwork-state]': env.fallback, '[data-scene-text-topics]': env.topics,
    '[data-scene-artwork-heading]': env.heading, '[data-scene-artwork-message]': env.message,
    '[data-action="retry-scene-artwork"]': env.retry, '[data-action="show-scene-text"]': env.show, '[data-action="hide-scene-text"]': env.hide,
    '[data-scene-text-topics] button': { focus() { env.focused = true; } },
  };
  env.host = { dataset: {}, querySelector: (selector: string) => selector === '.scene-artwork' ? env.image : selectors[selector], querySelectorAll: (selector: string) => selector === '.scene-hotspot' ? env.hotspots : [] };
  globalThis.document = {
    hidden: false,
    body: { classList: { toggle(name: string, enabled: boolean) { enabled ? classes.add(name) : classes.delete(name); }, remove(name: string) { classes.delete(name); } } },
    querySelector: (selector: string) => selector === '.place-scene' ? env.host : selector === '.place-scene .scene-artwork' ? env.image : null,
  } as unknown as Document;
  state.principal = { principalId: 'artwork-owner' };
  state.currentView = 'scene'; state.sceneData = scene; state.scenePlaceId = scene.placeId; state.navigationRevision = 2; state.accountContextChanged = false;
  env.record = artwork.sceneArtworkState(); env.classes = classes; env.scene = scene;
  try { run(env); }
  finally { globalThis.document = previous.document; state.principal = previous.principal; state.currentView = previous.view; state.sceneData = previous.scene; state.scenePlaceId = previous.place; state.navigationRevision = previous.revision; state.accountContextChanged = previous.accountContextChanged; }
}

test('failed artwork disables invisible visual hotspots and exposes a text exploration path', () => {
  withArtworkFixture(env => {
    artwork.mountSceneArtwork();
    assert.equal(env.hotspots[0].disabled, true);
    env.image.complete = true; env.image.dispatchEvent(new Event('error'));
    assert.equal(env.record.status, 'error');
    assert.equal(env.fallback.hidden, false);
    assert.equal(env.topics.hidden, false);
    assert.equal(env.retry.hidden, false);
    assert.match(env.heading.textContent, /没有加载/);
  });
});

test('image readiness restores visual exploration without overriding the chosen text mode', () => {
  withArtworkFixture(env => {
    artwork.mountSceneArtwork(); artwork.showSceneTextExploration();
    assert.equal(env.focused, true);
    env.image.complete = true; env.image.naturalWidth = 1800; env.image.dispatchEvent(new Event('load'));
    assert.equal(env.record.status, 'ready');
    assert.equal(env.topics.hidden, false);
    assert.equal(env.hotspots[0].disabled, true);
    artwork.showSceneTextExploration(false);
    assert.equal(env.fallback.hidden, true);
    assert.equal(env.hotspots[0].disabled, false);
    assert.equal(env.classes.has('scene-text-active'), false);
  });
});

test('late image events cannot alter a different account, navigation or scene version', () => {
  withArtworkFixture(env => {
    artwork.mountSceneArtwork(); env.image.complete = true;
    state.principal = { principalId: 'another-owner' };
    env.image.dispatchEvent(new Event('error'));
    assert.equal(env.record.status, 'loading');
    state.principal = { principalId: 'artwork-owner' }; state.navigationRevision++;
    env.image.dispatchEvent(new Event('error'));
    assert.equal(env.record.status, 'loading');
    state.navigationRevision = 2; state.scenePlaceId = 'another-place';
    env.image.dispatchEvent(new Event('error'));
    assert.equal(env.record.status, 'loading');
    state.scenePlaceId = env.scene.placeId; state.sceneData = { ...env.scene, version: 2 };
    env.image.naturalWidth = 1800; env.image.dispatchEvent(new Event('load'));
    assert.equal(env.record.status, 'loading');
    assert.equal(artwork.sceneArtworkState().status, 'loading');
  });
});

test('retry replaces the request target and ignores events from the detached old image', () => {
  withArtworkFixture(env => {
    artwork.mountSceneArtwork(); env.image.complete = true; env.image.dispatchEvent(new Event('error'));
    artwork.showSceneTextExploration();
    const old = env.image;
    artwork.retrySceneArtwork();
    assert.notEqual(env.image, old);
    assert.equal(env.record.status, 'loading');
    assert.equal(env.record.textMode, true);
    assert.match(env.image.src, /scene_retry=1/);
    old.naturalWidth = 1800; old.dispatchEvent(new Event('load'));
    assert.equal(env.record.status, 'loading');
    env.image.complete = true; env.image.naturalWidth = 1800; env.image.dispatchEvent(new Event('load'));
    assert.equal(env.record.status, 'ready');
    assert.equal(env.record.textMode, true);
  });
});

test('account pause prevents image retry and leaving clears only the scene layout class', () => {
  withArtworkFixture(env => {
    artwork.mountSceneArtwork(); state.accountContextChanged = true;
    const before = env.image;
    artwork.retrySceneArtwork();
    assert.equal(env.image, before);
    assert.equal(env.record.attempt, 0);
    env.classes.add('other-page-state'); state.currentView = 'home'; artwork.mountSceneArtwork();
    assert.equal(env.classes.has('scene-text-active'), false);
    assert.equal(env.classes.has('other-page-state'), true);
  });
});

test('fresh image request preserves existing query and fragment', () => {
  withArtworkFixture(env => {
    state.sceneData = { ...env.scene, artwork: '/images/scene.jpg?version=2#view' };
    const record = artwork.sceneArtworkState(); record.attempt = 3;
    assert.equal(artwork.sceneArtworkSource(), '/images/scene.jpg?version=2&scene_retry=3#view');
  });
});
