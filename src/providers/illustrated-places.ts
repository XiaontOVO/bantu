import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { placeImpression } from '../../public/lib/place-impressions.js';
import type { PlaceProvider } from './travel.js';
import type { DemoPlace } from '../demo/demo-data.js';

/** Catalogue admission checks actual local artwork, never the generated placeholder. */
export function hasUsablePlaceImpression(place: DemoPlace, publicRoot = resolve('public')): boolean {
  const image = placeImpression(place);
  if (image.placeholder) return false;
  const path = image.src.split(/[?#]/, 1)[0];
  if (!path.startsWith('/images/places/')) return false;
  let handle: number | undefined;
  try {
    const root = realpathSync(publicRoot), file = realpathSync(resolve(root, path.slice(1))), inside = relative(root, file);
    if (inside.startsWith('..') || isAbsolute(inside) || !statSync(file).isFile()) return false;
    handle = openSync(file, 'r'); const header = Buffer.alloc(12); const length = readSync(handle, header, 0, 12, 0);
    if (length < 8) return false;
    // Some legacy AI-generated PNGs have .jpg names; browsers decode their actual bytes.
    return (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
      || header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || (header.subarray(0,4).toString() === 'RIFF' && header.subarray(8,12).toString() === 'WEBP');
  } catch { return false; }
  finally { if (handle !== undefined) closeSync(handle); }
}

export function illustratedPlaceProvider(source: PlaceProvider): PlaceProvider {
  return {
    providerName: source.providerName,
    async search(input) {
      const limit = Math.min(50, Math.max(1, input.limit || 12));
      const places: DemoPlace[] = []; let offset = input.offset || 0, nextCursor: number | null = null;
      // Continue across filtered pages; preserve a usable cursor instead of overfetching or skipping records.
      for (let page=0; page<4; page++) {
        const result = await source.search({ ...input, limit: limit - places.length, offset });
        if (result.error) return result;
        places.push(...result.places.filter(p => hasUsablePlaceImpression(p)).map(p => ({ ...p, impressionImage: placeImpression(p).src })));
        nextCursor = result.nextCursor ?? null;
        if (places.length >= limit || nextCursor === null || nextCursor <= offset) break;
        offset = nextCursor;
      }
      return { places, empty: !places.length, nextCursor };
    },
    async detail(id, mode) {
      const place = await source.detail(id, mode);
      return place && hasUsablePlaceImpression(place) ? { ...place, impressionImage: placeImpression(place).src } : null;
    },
  };
}
