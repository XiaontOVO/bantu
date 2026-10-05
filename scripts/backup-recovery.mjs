import { InMemoryTripService } from '../dist/src/services/trip-service.js';

const source = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
const { principal } = source.createAnonymousSession();
const created = source.createTrip(principal.principalId, {
  cityCode: '330100',
  localDate: '2026-09-20',
  dataMode: 'demo',
  partySize: 2,
});
if (!created.ok) throw new Error('create trip failed');
const backup = source.serialize();

const restored = new InMemoryTripService(() => '2026-09-20T13:05:00+08:00');
restored.loadSerialized(backup);
const trip = restored.getTrip(principal.principalId, created.value.trip.tripId);
if (!trip.ok || trip.value.trip.tripId !== created.value.trip.tripId) {
  throw new Error('restore failed');
}

console.log('RECOVERY=PASS');
console.log(`TRIP=${trip.value.trip.tripId}`);
console.log(`REVISION=${trip.value.trip.revision}`);
