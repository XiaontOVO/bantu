import type { RoutePlanInput, RoutePlanResult } from './travel.js';

/** Exact endpoint/mode cache and in-flight dedupe; never caches unavailable routes. */
export class RouteResultCache {
  private readonly values = new Map<string, { until: number; value: RoutePlanResult }>();
  private readonly pending = new Map<string, Promise<RoutePlanResult>>();
  async read(key: string, input: RoutePlanInput, request: () => Promise<RoutePlanResult>, ttlMs: number): Promise<RoutePlanResult> {
    const saved = this.values.get(key);
    let value: RoutePlanResult;
    if (saved && saved.until > Date.now()) value = saved.value;
    else {
      if (saved) this.values.delete(key);
      let pending = this.pending.get(key);
      if (!pending) {
        pending = request().then(result => {
          if (!result.error) {
            this.values.set(key, { until: Date.now() + ttlMs, value: structuredClone(result) });
            for (const [entry, cached] of this.values) if (cached.until <= Date.now()) this.values.delete(entry);
            while (this.values.size > 128) this.values.delete(this.values.keys().next().value!);
          }
          return result;
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      value = await pending;
    }
    const result = structuredClone(value);
    result.leg.fromStopId = 'placeId' in input.origin && input.origin.placeId ? input.origin.placeId : 'origin';
    result.leg.toStopId = 'placeId' in input.destination && input.destination.placeId ? input.destination.placeId : 'destination';
    return result;
  }
}
