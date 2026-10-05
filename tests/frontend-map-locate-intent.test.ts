import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const mapModule = await load('public/lib/map.js');
const locationModule = await load('public/lib/location.js');

async function environment(run: (fixture: any) => Promise<void>) {
  const previousState = { ...state };
  const keys = ['document', 'window', 'navigator', 'fetch'] as const;
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const a = { placeId: 'locate-a', name: '手动起点 A', coordinates: { lat: 31.2, lng: 121.4 } };
  const b = { placeId: 'locate-b', name: '目的地 B', coordinates: { lat: 31.21, lng: 121.41 } };
  const c = { placeId: 'locate-c', name: '手动起点 C', coordinates: { lat: 31.22, lng: 121.42 } };
  const node = (value = ''): any => ({ value, innerHTML: '', textContent: '', isConnected: true, clientHeight: 350,
    options: [], classList: { add() {}, toggle() {} }, addEventListener() {}, setAttribute() {},
    prepend(option: any) { this.options.unshift(option); }, appendChild(option: any) { this.options.push(option); },
    insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; } });
  const nodes: Record<string, any> = { 'travel-map': node(), 'map-status': node(), 'route-result': node(),
    routeFrom: node(a.placeId), routeTo: node(b.placeId), routeMode: node('walking'), toast: node() };
  nodes.routeFrom.options = [a, b, c].map(place => ({ value: place.placeId }));
  const locate = node(), fullRoute = node(), watchers: any[] = [], views: any[] = [], requests: any[] = [];
  const leafletMap: any = { setView(point: any, zoom: number) { views.push({ point, zoom }); return this; },
    getCenter() { return { lat: 31.2, lng: 121.4 }; }, getZoom() { return 15; },
    fitBounds() {}, removeLayer() {}, remove() {}, closePopup() {}, on() {} };
  const layer = (): any => ({ addTo() { return this; }, bindPopup() { return this; }, on() {},
    setLatLng() {}, setRadius() {}, getBounds() { return []; } });
  const control: any = () => ({ addTo() { return this; }, getContainer() { return node(); } });
  control.zoom = control;
  const documentFixture = Object.assign(new EventTarget(), { hidden: false, visibilityState: 'visible',
    getElementById: (id: string) => nodes[id] || null, createElement: () => node(), querySelectorAll: () => [],
    querySelector: (selector: string) => selector.includes('map-locate') ? locate : selector.includes('toggle-full-route') ? fullRoute : null });
  const windowFixture = Object.assign(new EventTarget(), { isSecureContext: true,
    gcoord: { WGS84: 'wgs', GCJ02: 'gcj', transform: (point: any) => point },
    L: { map: () => leafletMap, control, tileLayer: layer, marker: layer, circleMarker: layer, circle: layer,
      featureGroup: layer, polyline: layer, divIcon: (value: any) => value,
      DomUtil: { create: () => node() }, DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} } } });
  const globals: any = { document: documentFixture, window: windowFixture,
    navigator: { geolocation: { watchPosition(success: any, error: any) { watchers.push({ success, error }); return watchers.length; }, clearWatch() {} } },
    fetch: async (url: any, options: any = {}) => {
      if (String(url).startsWith('/api/v1/geo/reverse')) return new Response(JSON.stringify({ data: { label: '当前位置' } }));
      const body = JSON.parse(options.body || '{}'); requests.push({ url, body });
      return new Response(JSON.stringify({ data: { departureSupport: 'current_only', leg: { transportMode: body.transportMode,
        distanceMeters: 1200, durationMinutes: 10, geometryCrs: 'WGS84', geometry: [a.coordinates, b.coordinates] } } }));
    } };
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: globals[key] });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  Object.assign(state, { principal: { principalId: 'locate-intent-owner' }, accountContextChanged: false,
    currentView: 'map', navigationRevision: 1, planViewDate: today, currentLocation: null, trip: null,
    savedPlans: [{ id: 'locate-intent-plan', kind: 'plan', localDate: today, revision: 1,
      stops: [a, b, c].map((place, i) => ({ stopId: `locate-stop-${i}`, placeId: place.placeId, place, status: 'planned' })), routeLegs: [] }],
    places: [a, b, c], mapPlaces: [a, b, c], mapFrom: a.placeId, mapTo: b.placeId,
    mapRouteView: 'endpoints', routeMode: 'walking', routeModeSelected: false, routePreview: null,
    mapConfig: { routeModes: ['walking', 'driving'] }, stopModes: {} });
  locationModule.stopLocation({ clear: true });
  try {
    mapModule.mountMap(); await new Promise(resolve => setImmediate(resolve));
    await run({ a, b, c, nodes, views, requests, watchers, locate,
      emit() { watchers.at(-1).success({ coords: { latitude: 31.23, longitude: 121.43, accuracy: 20 }, timestamp: Date.now() }); },
      flush: () => new Promise(resolve => setImmediate(resolve)) });
  } finally {
    mapModule.disposeMap(); locationModule.stopLocation({ clear: true });
    clearTimeout((windowFixture as any).__toastTimer); Object.assign(state, previousState);
    keys.forEach((key, index) => { if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
}

test('a pending locate request cannot replace a subsequently selected manual origin or camera', () => environment(async f => {
  const locating = mapModule.locateMap();
  mapModule.setMapOrigin(f.c.placeId); await f.flush();
  const cameraCount = f.views.length, requestCount = f.requests.length;
  f.emit(); await locating;
  assert.equal(state.mapFrom, f.c.placeId, 'the later explicit manual origin wins over the GPS request');
  assert.equal(f.nodes.routeFrom.value, f.c.placeId);
  assert.equal(f.views.length, cameraCount, 'a superseded locate does not pull the camera away');
  assert.equal(f.requests.length, requestCount, 'a superseded locate does not query a route from GPS');
  assert.equal(state.currentLocation.coordinates.lat, 31.23, 'the shared GPS fix still updates normally');
  assert.equal(f.locate.disabled, false);
}));

test('selecting origins A to C to A while locating still preserves the last user choice', () => environment(async f => {
  const locating = mapModule.locateMap();
  mapModule.setMapOrigin(f.c.placeId); mapModule.setMapOrigin(f.a.placeId); await f.flush();
  f.emit(); await locating;
  assert.equal(state.mapFrom, f.a.placeId, 'an origin round trip is still a newer explicit user selection');
}));

test('a pending locate request does not switch a subsequently selected full-trip route back to endpoints', () => environment(async f => {
  const locating = mapModule.locateMap();
  await mapModule.toggleFullRoute();
  f.emit(); await locating;
  assert.equal(state.mapRouteView, 'entire');
  assert.equal(state.routePreview.entireTrip, true);
  assert.equal(state.mapFrom, f.a.placeId);
}));

test('an unchanged locate request still selects fresh GPS and plans the currently chosen destination', () => environment(async f => {
  const locating = mapModule.locateMap();
  f.emit(); await locating;
  assert.equal(state.mapFrom, 'my-location'); assert.equal(f.nodes.routeFrom.value, 'my-location');
  assert.equal(state.routePreview.mapTo, f.b.placeId);
  assert.equal(state.routePreview.segments[0].origin.coordinates.lat, 31.23);
  assert.equal(f.locate.disabled, false);
}));

test('a superseded locate failure cannot overwrite feedback for the newer manual origin', () => environment(async f => {
  const locating = mapModule.locateMap();
  mapModule.setMapOrigin(f.c.placeId); await f.flush();
  const status = f.nodes['map-status'].textContent, result = f.nodes['route-result'].innerHTML;
  f.watchers.at(-1).error({ code: 2 }); await locating;
  assert.equal(state.mapFrom, f.c.placeId);
  assert.equal(f.nodes['route-result'].innerHTML, result, 'the newer manual route remains displayed');
  assert.equal(f.nodes['map-status'].textContent, status, 'the old locate failure cannot replace current map feedback');
  assert.doesNotMatch(f.nodes.toast.className || '', /error/, 'the old locate failure cannot raise an unrelated error toast');
  assert.equal(f.locate.disabled, false);
}));

test('a locate rejection cannot show feedback after identity, view, foreground or account-context changes', async () => {
  for (const scenario of ['identity', 'view', 'background', 'account-pause']) await environment(async f => {
    const locating = mapModule.locateMap(), status = f.nodes['map-status'].textContent;
    if (scenario === 'identity') state.principal = { principalId: 'another-map-owner' };
    if (scenario === 'view') state.currentView = 'places';
    if (scenario === 'background') Object.assign(globalThis.document, { hidden: true });
    if (scenario === 'account-pause') state.accountContextChanged = true;
    locationModule.stopLocation({ clear: true }); await locating;
    assert.equal(f.nodes['map-status'].textContent, status, scenario);
    assert.doesNotMatch(f.nodes.toast.className || '', /error/, scenario);
    assert.equal(f.locate.disabled, false, scenario);
  });
});
