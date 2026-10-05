import type { WeatherProvider, WeatherReadInput, WeatherReadResult } from './travel.js';

const conditions: Record<number, string> = { 0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '中毛毛雨', 55: '强毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪', 95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴伴冰雹' };
const numeric = (value: unknown, min: number, max: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const unavailable = (code: string, message: string): WeatherReadResult => ({ available: false, error: { code, message } });

/** Forecast values, not station observations. API definitions: https://open-meteo.com/en/docs */
export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly providerName = 'open_meteo';
  private readonly cache = new Map<string, { expires: number; value: WeatherReadResult }>();
  constructor(private readonly options: { fetchImpl?: typeof fetch; now?: () => string; timeoutMs?: number } = {}) {}
  async read(input: WeatherReadInput): Promise<WeatherReadResult> {
    const center = input.center;
    if (!center || numeric(center.lat, -90, 90) === null || numeric(center.lng, -180, 180) === null) return unavailable('WEATHER_LOCATION_REQUIRED', '天气查询需要目录地点坐标或近期定位。');
    const dateMs = Date.parse(`${input.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== input.date) return unavailable('WEATHER_DATE_INVALID', '天气查询日期无效。');
    const now = this.options.now?.() || new Date().toISOString();
    const today = new Date(Date.parse(now) + 8 * 3600000).toISOString().slice(0, 10);
    const days = (dateMs - Date.parse(`${today}T00:00:00Z`)) / 86400000;
    if (days < 0 || days > 15) return unavailable('WEATHER_DATE_UNAVAILABLE', '只能查询今天起 16 天内的预报；更远日期不能据此判断天气。');
    const key = `${center.lat},${center.lng},${input.date}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.parse(now)) return structuredClone(cached.value);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(center.lat), longitude: String(center.lng), timezone: 'Asia/Shanghai', start_date: input.date, end_date: input.date,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
      hourly: 'temperature_2m,precipitation_probability,precipitation', temperature_unit: 'celsius', precipitation_unit: 'mm' }).toString();
    try {
      const response = await (this.options.fetchImpl || fetch)(url, { signal: AbortSignal.timeout(this.options.timeoutMs || 12000) });
      if (!response.ok) return unavailable('WEATHER_PROVIDER_UNAVAILABLE', '天气服务暂时不可用，请稍后重试。');
      const data = await response.json() as any;
      const daily = data.daily, units = data.daily_units;
      const min = numeric(daily?.temperature_2m_min?.[0], -100, 70), max = numeric(daily?.temperature_2m_max?.[0], -100, 70);
      const code = daily?.weather_code?.[0];
      if (data.error || data.timezone !== 'Asia/Shanghai' || daily?.time?.[0] !== input.date || min === null || max === null || min > max || !Number.isInteger(code) || !conditions[code] || units?.temperature_2m_min !== '°C' || units?.temperature_2m_max !== '°C') return unavailable('WEATHER_DATA_INVALID', '天气服务返回的数据不完整，不能据此判断天气。');
      const probability = units?.precipitation_probability_max === '%' ? numeric(daily.precipitation_probability_max?.[0], 0, 100) : null;
      const precipitation = units?.precipitation_sum === 'mm' ? numeric(daily.precipitation_sum?.[0], 0, 5000) : null;
      const hours = Array.isArray(data.hourly?.time) ? data.hourly.time.slice(0, 24).flatMap((time: unknown, i: number) => typeof time === 'string' && time.startsWith(`${input.date}T`) && /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time) ? [{ time,
        temperatureC: data.hourly_units?.temperature_2m === '°C' ? numeric(data.hourly.temperature_2m?.[i], -100, 70) : null,
        precipitationProbability: data.hourly_units?.precipitation_probability === '%' ? numeric(data.hourly.precipitation_probability?.[i], 0, 100) : null,
        precipitationMm: data.hourly_units?.precipitation === 'mm' ? numeric(data.hourly.precipitation?.[i], 0, 5000) : null }] : []) : [];
      const result: WeatherReadResult = { available: true, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', retrievedAt: now, date: input.date, timezone: 'Asia/Shanghai',
        summary: `${conditions[code]}，${min}–${max}℃${probability === null ? '' : `，全天最高降水概率 ${probability}%`}（预报，非实测）`,
        forecast: { temperatureMinC: min, temperatureMaxC: max, precipitationProbabilityMax: probability, precipitationMm: precipitation, weatherCode: code }, hours };
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.parse(now) + 600000, value: structuredClone(result) });
      return result;
    } catch { return unavailable('WEATHER_PROVIDER_UNAVAILABLE', '天气查询失败，未取得可用预报。'); }
  }
}
