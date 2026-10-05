import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FossgisOsrmRouteProvider } from '../src/providers/osrm.js';

const response = (mode: string) => ({
  code: 'Ok',
  routes: [{
    distance: mode === 'walking' ? 1280.7 : 1900,
    duration: mode === 'walking' ? 930 : 360,
    geometry: { coordinates: [[121.433, 31.206], [121.435, 31.207], [121.44, 31.209]] },
    legs: [{ steps: [
      { name: '淮海中路', maneuver: { type: 'depart' } },
      { name: '', maneuver: { type: 'turn', modifier: 'right' } },
      { name: '', maneuver: { type: 'arrive' } },
    ] }],
  }],
});

test('FOSSGIS OSRM returns real metrics, WGS84 geometry and Chinese instructions for walking and driving', async () => {
  const urls: string[] = [];
  const startedAt: number[] = [];
  const provider = new FossgisOsrmRouteProvider({
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      startedAt.push(Date.now());
      const mode = url.includes('routed-foot') ? 'walking' : 'driving';
      return Response.json(response(mode));
    }) as typeof fetch,
  });
  const origin = { lat: 31.206, lng: 121.433, placeId: 'place-a' };
  const destination = { lat: 31.209, lng: 121.44, placeId: 'place-b' };
  const walking = await provider.plan({ origin, destination, transportMode: 'walking' });
  const driving = await provider.plan({ origin, destination, transportMode: 'driving' });

  assert.match(urls[0], /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/driving\/121\.433,31\.206;121\.44,31\.209\?/);
  assert.match(urls[0], /overview=full&geometries=geojson&steps=true/);
  assert.match(urls[1], /^https:\/\/routing\.openstreetmap\.de\/routed-car\/route\/v1\/driving\//);
  assert.ok(startedAt[1] - startedAt[0] >= 950, 'global service policy requires no more than one request per second');
  assert.equal(walking.error, undefined);
  assert.equal(walking.leg.distanceMeters, 1281);
  assert.equal(walking.leg.durationSeconds, 930);
  assert.equal(walking.leg.geometryCrs, 'WGS84');
  assert.deepEqual(walking.leg.geometry?.[0], { lng: 121.433, lat: 31.206 });
  assert.deepEqual(walking.leg.instructions, ['从起点出发，沿淮海中路前行', '右转', '到达目的地']);
  assert.equal(walking.leg.walkingMeters, 1281);
  assert.equal(driving.leg.distanceMeters, 1900);
  assert.equal(driving.leg.walkingMeters, undefined);
});

test('OSRM does not disguise transit as a walking or driving route', async () => {
  let requestCount = 0;
  const provider = new FossgisOsrmRouteProvider({
    fetchImpl: (async () => { requestCount += 1; return Response.json(response('walking')); }) as typeof fetch,
  });
  const result = await provider.plan({
    origin: { lat: 31.2, lng: 121.4 },
    destination: { lat: 31.21, lng: 121.41 },
    transportMode: 'transit',
  });
  assert.equal(result.error?.code, 'TRANSIT_PROVIDER_UNAVAILABLE');
  assert.equal(result.leg.transportMode, 'transit');
  assert.equal(requestCount, 0);
});

test('OSRM accepts provider-confirmed zero route for nearby points, but rejects zero for separated points', async () => {
  const provider = new FossgisOsrmRouteProvider({ fetchImpl: (async () => Response.json({ code: 'Ok', routes: [{ distance: 0, duration: 0, geometry: { coordinates: [[121.44, 31.19], [121.44, 31.19]] }, legs: [] }] })) as typeof fetch });
  const nearby = await provider.plan({ origin: { lat: 31.19, lng: 121.44 }, destination: { lat: 31.19001, lng: 121.44001 }, transportMode: 'walking' });
  assert.equal(nearby.error, undefined); assert.equal(nearby.leg.durationMinutes, 0); assert.equal(nearby.leg.distanceMeters, 0);
  const separated = await provider.plan({ origin: { lat: 31.19, lng: 121.44 }, destination: { lat: 31.21, lng: 121.47 }, transportMode: 'walking' });
  assert.equal(separated.error?.code, 'OSRM_ROUTE_DATA_INCOMPLETE');
});

test('OSRM provider reports missing routes and HTTP errors clearly', async () => {
  const provider = new FossgisOsrmRouteProvider({
    fetchImpl: (async () => Response.json({ code: 'NoRoute', routes: [] })) as typeof fetch,
  });
  const result = await provider.plan({
    origin: { lat: 31.2, lng: 121.4 },
    destination: { lat: 31.21, lng: 121.41 },
    transportMode: 'walking',
  });
  assert.equal(result.error?.code, 'OSRM_ROUTE_NOT_FOUND');
  assert.match(result.error?.message ?? '', /没有找到可用路线/);

  const httpFailure = new FossgisOsrmRouteProvider({
    walkingBaseUrl: 'https://routing.invalid/routed-foot',
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
  });
  const failed = await httpFailure.plan({
    origin: { lat: 31.2, lng: 121.4 },
    destination: { lat: 31.21, lng: 121.41 },
    transportMode: 'walking',
  });
  assert.equal(failed.error?.code, 'FOSSGIS_HTTP_503');
});
