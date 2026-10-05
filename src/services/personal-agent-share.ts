import type { ServerContext } from '../server/http/context.js';
import type { PlanStop } from '../domain/types.js';
import { getStopStart, getStopEnd } from '../domain/normalize.js';
import { decodePlanShareCode } from './community-service.js';
import { prepareCommunityAction } from './personal-agent-community-actions.js';
import { cityNameOf } from '../domain/cities.js';

/** Resolve each shared place from the catalog; the model never manufactures an encoded share. */
export async function prepareAgentPlanShare(ctx: ServerContext, actorId: string, planId: string) {
  if (ctx.accounts.profile(actorId).kind !== 'account') throw new Error('请先登录账号，再分享方案。');
  const source = structuredClone(ctx.planLibrary.get(actorId, planId));
  const provider = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const sourceDays = source.kind === 'scheme' ? source.days || [] : [{ stops: source.stops }];
  const days = [];
  const cities = new Set<string>();
  for (const day of sourceDays) {
    const stops = [];
    for (const value of day.stops) {
      const stop = value as PlanStop;
      const place = await provider.detail(stop.placeId || stop.place?.placeId || '');
      if (!place?.coordinates) throw new Error(`地点「${stop.place?.name || stop.stopId}」无法匹配目录或缺少坐标，暂时不能分享。`);
      const cityCode = place.cityCode || '000000';
      if (cityCode !== '000000') cities.add(cityCode);
      const duration = stop.plannedDurationMinutes || stop.minDurationMinutes || getStopEnd(stop) - getStopStart(stop) || 60;
      stops.push({ p: place.placeId, n: place.name, la: place.coordinates.lat, ln: place.coordinates.lng,
        crs: place.coordinates.source === 'amap' ? 'GCJ02' : 'WGS84', cc: cityCode, a: getStopStart(stop), m: Math.max(15, Math.min(1440, Math.round(duration))) });
    }
    days.push({ s: stops });
  }
  if (JSON.stringify(ctx.planLibrary.get(actorId, planId)) !== JSON.stringify(source)) throw new Error('方案在查询地点期间已更新，请重新读取后分享。');
  const cityCode = [...cities][0] || '000000';
  const cityLabel = cities.size > 1 ? '多地' : (cityNameOf(cityCode) || '城市待核实');
  const payload = { v: 3, n: source.name, c: cityCode, cn: cityLabel, days };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=+$/, '');
  const sum = [...body].reduce((total, ch) => total + ch.charCodeAt(0), 0);
  const code = `BT1-${body}-${(sum % 1296).toString(36).toUpperCase().padStart(2, '0')}`;
  const decoded = decodePlanShareCode(code);
  return prepareCommunityAction(ctx, actorId, 'share_publish', { planId, dayNames: days.map(d => d.s.map(s => s.n)), share: { code, name: source.name, cityCode: decoded.cityCode, cityLabel: decoded.cityLabel, stopCount: decoded.stopCount } });
}
