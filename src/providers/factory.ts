import type { ModelProvider } from './model.js';
import { OpenAiCompatibleModelProvider } from './openai-compatible-model.js';
import type { PlaceProvider, RouteProvider, WeatherProvider } from './travel.js';
import { DemoPlaceProvider, DisabledWeatherProvider } from './travel.js';
import { AmapPlaceProvider, AmapRouteProvider } from './amap.js';
import { FossgisOsrmRouteProvider } from './osrm.js';
import { AmapGeoService, DisabledGeoService } from './geo.js';
import { OpenMeteoWeatherProvider } from './open-meteo.js';
import {parseModelControls} from './model-controls.js';

export interface ProviderBundle {
  modelProvider?: ModelProvider;
  placeProvider: PlaceProvider;
  routeProvider: RouteProvider;
  weatherProvider: WeatherProvider;
  /** 逆地理编码（定位坐标→地名）；未配置高德 Key 时为 disabled，reverse 恒返回 null。 */
  geoService: import('./geo.js').GeoService;
  /** 是否使用了真实在线供应商。 */
  hasOnlineModel: boolean;
  hasOnlinePlaces: boolean;
  hasOnlineRoutes: boolean;
}

/** 显式读取服务器环境变量；路线默认使用真实 OSM 步行/驾车服务，公交需高德 Key。 */
export function createProviderBundle(env: NodeJS.ProcessEnv = process.env): ProviderBundle {
  const modelApiKey = env.MODEL_API_KEY;
  const modelBaseUrl = env.MODEL_BASE_URL;
  const modelName = env.MODEL_NAME;
  const modelProvider =
    modelApiKey && modelBaseUrl && modelName
      ? new OpenAiCompatibleModelProvider({
          apiKey: modelApiKey,
          baseUrl: modelBaseUrl,
          modelName,
          providerName: env.MODEL_PROVIDER ?? 'openai_compatible',
          ...parseModelControls({thinking:env.MODEL_THINKING,thinkingEffort:env.MODEL_THINKING_EFFORT,thinkingFormat:env.MODEL_THINKING_FORMAT,apiFormat:env.MODEL_API_FORMAT}),
        })
      : undefined;

  const amapKey = env.AMAP_API_KEY;
  const placeProvider = amapKey
    ? new AmapPlaceProvider({ apiKey: amapKey })
    : new DemoPlaceProvider();
  const routeProvider = amapKey
    ? new AmapRouteProvider({ apiKey: amapKey })
    : new FossgisOsrmRouteProvider();
  const geoService = amapKey ? new AmapGeoService(amapKey) : new DisabledGeoService();

  return {
    modelProvider,
    placeProvider,
    routeProvider,
    weatherProvider: env.WEATHER_PROVIDER === 'disabled' ? new DisabledWeatherProvider() : new OpenMeteoWeatherProvider(),
    geoService,
    hasOnlineModel: modelProvider !== undefined,
    hasOnlinePlaces: Boolean(amapKey),
    hasOnlineRoutes: true,
  };
}
