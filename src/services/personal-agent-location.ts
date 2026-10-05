export interface AgentLocation { lat: number; lng: number; accuracyMeters: number; measuredAt: number }

/** Browser fixes are WGS84; an address or a plan's city is never a GPS fix. */
export function usableAgentLocation(value: unknown, now: string): AgentLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (![p.lat, p.lng, p.accuracyMeters, p.measuredAt].every(v => typeof v === 'number' && Number.isFinite(v))) return undefined;
  const { lat, lng, accuracyMeters, measuredAt } = p as unknown as AgentLocation;
  const age = Date.parse(now) - measuredAt;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracyMeters < 0 || accuracyMeters > 200 || !Number.isFinite(age) || age < -30000 || age > 300000) return undefined;
  return { lat, lng, accuracyMeters, measuredAt };
}
