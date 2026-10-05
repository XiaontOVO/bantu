import type { ExecutionEventType, PlaceRef, StopStatus } from '../../../domain/types.js';
import type { PlaceProvider } from '../../../providers/travel.js';

export function readExecutionType(value: unknown): ExecutionEventType | null {
  return value === 'depart' || value === 'arrive' || value === 'complete' || value === 'skip' || value === 'abort'
    ? value
    : null;
}

export function readStopStatus(value: unknown): StopStatus | null {
  return value === 'planned' || value === 'en_route' || value === 'visiting' || value === 'completed' || value === 'skipped'
    ? value
    : null;
}

export function placeRefFromDirectory(place: Awaited<ReturnType<PlaceProvider['detail']>>): PlaceRef | null {
  if (!place) return null;
  return {
    placeId: place.placeId,
    name: place.name,
    coordinates: place.coordinates ? { ...place.coordinates } : null,
    facilityCodes: [...place.facilityCodes],
    ...(place.provider ? { provider: place.provider } : {}),
    ...(place.providerPlaceId ? { providerPlaceId: place.providerPlaceId } : {}),
    ...(place.cityCode ? { cityCode: place.cityCode } : {}),
    ...(place.dataMode ? { dataMode: place.dataMode } : {}),
    ...(place.evidenceIds ? { evidenceIds: [...place.evidenceIds] } : {}),
  };
}
