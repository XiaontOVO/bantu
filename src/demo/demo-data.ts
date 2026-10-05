import type { CostEstimate, PlaceRef, TripSnapshot } from '../domain/types.js';
import { propagateSchedule, type ScheduleRoute, type ScheduleSegment } from '../domain/itinerary.js';
import { normalizeTripSnapshot } from '../domain/normalize.js';

export interface DemoReview {
  nickname: string;
  rating: number;
  text: string;
  daysAgo: number;
}

export interface PlacePhoto {
  /** 项目内本地图片路径；不接受外部图片服务地址。 */
  src: string;
  alt: string;
  caption: string;
  credit: string;
  license: string;
}

export interface DemoPlace extends PlaceRef {
  /** 兼容旧接口的内部递增收录号，由 PlaceNumberRegistry 分配；公开编号使用 placeId。 */
  placeNo?: number;
  officialTagIds?: string[];
  customTags?: string[];
  /** 联系电话（高德 POI tel 或收录时填写）；仅在有数据时展示。 */
  phone?: string;
  /** 预约与购票提示（例如「需在公众号预约」）；仅在有数据时展示。 */
  reservationHint?: string;
  category: string;
  suggestedDurationMinutes: number | null;
  openingIntervals: { startMinutes: number; endMinutes: number }[];
  costEstimate?: CostEstimate;
  /** 样例地点的可读地址；目录、卡片与详情共用。 */
  address?: string;
  /** 地点介绍：目录摘要与详情页正文共用。 */
  description?: string;
  /** 项目自绘的地点印象插画；与实拍 photos 分开保存。 */
  impressionImage?: string;
  /** 样例旅友评价：让每个地点在详情页「活起来」。 */
  reviews?: DemoReview[];
  /** 可公开复用的地点实拍图；许可与摄影者信息随图展示。 */
  photos?: PlacePhoto[];
  /** 收录的旅人推荐地点带入分享时间，用于目录中的“最新”排序。 */
  createdAt?: string;
}

// 这些地点 ID 已被行程、收藏、分享帖引用。坐标校正后仍保留旧 ID，避免破坏已有引用。
// 坐标原始值来自对应高德地点页（GCJ-02），已逆变换为系统内部使用的 WGS84。
// 高德地点页 ID：武康 B00155ITJ1、书院 B0FFMH4KQS、上图 B00155KHES、
// 龙华寺 B00155AMEJ、西岸美术馆 B0FFJGOAFY、徐家汇公园 B00155ILI8、桂林公园 B00155L0UC。
// 上海徐汇区真实地点（营业与费用为近似演示值）。
export const DEMO_PLACE_IDS = {
  wukang: '12143603120601',
  xujiahuiLibrary: '12143803119501',
  shanghaiLibrary: '12144703121101',
  longhuaTemple: '12145203117901',
  westbundMuseum: '12145903118001',
  xujiahuiPark: '12144103119301',
  guilinPark: '12141703117401',
};

const localPhoto = (
  file: string,
  caption: string,
  credit: string,
  license = 'CC BY-SA 4.0',
): PlacePhoto => ({ src: `/images/places/${file}`, alt: caption, caption, credit, license });

const demoPlacePhotos = {
  wukang: [
    localPhoto('photos/wukang-2.jpg', '武康大楼红砖立面', '钉钉'),
    localPhoto('photos/wukang-3.jpg', '武康大楼路口', '钉钉'),
  ],
  xujiahuiLibrary: [
    localPhoto('photos/xujiahui-library-2.jpg', '徐家汇书院空间一景', 'Nanhuajiaren'),
    localPhoto('photos/xujiahui-library-3.jpg', '徐家汇书院内部', 'Nanhuajiaren'),
  ],
  longhuaTemple: [
    localPhoto('photos/longhua-2.jpg', '龙华寺建筑与庭院', 'Jakub Hałun'),
    localPhoto('photos/longhua-3.jpg', '龙华寺塔', 'Drew Lietzow', '公有领域'),
  ],
  westbundMuseum: [
    localPhoto('photos/westbund-2.jpg', '西岸美术馆建筑外观', 'Lcsun'),
  ],
  xujiahuiPark: [
    localPhoto('photos/xujiahui-park-2.jpg', '徐家汇公园烟囱', 'Livelikerw', 'CC BY-SA 3.0'),
    localPhoto('photos/xujiahui-park-3.jpg', '徐家汇公园步道', 'Szalai.laci'),
  ],
  guilinPark: [
    localPhoto('photos/guilin-park-2.jpg', '桂林公园亭台', 'Szalai.laci'),
    localPhoto('photos/guilin-park-3.jpg', '桂林公园竹林门景', 'Szalai.laci'),
  ],
};

const demoPlaceImpressions = {
  wukang: '/images/places/impression/wukang-1.jpg',
  xujiahuiLibrary: '/images/places/impression/xujiahui-library-1.jpg',
  shanghaiLibrary: '/images/places/impression/shanghai-library-1.jpg',
  longhuaTemple: '/images/places/impression/longhua-1.jpg',
  // 西岸美术馆印象图使用本地自绘插画，实拍照独立保存在 photos 中。
  westbundMuseum: '/images/places/impression/west-bund-museum-impression-1.png',
  xujiahuiPark: '/images/places/impression/xujiahui-park-1.jpg',
  guilinPark: '/images/places/impression/guilin-park-1.jpg',
} as const;

export const DEMO_SHANGHAI_PLACES: DemoPlace[] = [
  {
    placeId: DEMO_PLACE_IDS.wukang,
    name: '武康大楼',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.206298, lng: 121.433655, source: 'demo' },
    address: '淮海中路1856-1858号',
    description: '1924 年落成的文艺复兴风格公寓大楼，外形如巨轮泊在武康路与淮海中路的转角，是上海最早的外廊式建筑之一，也是 City Walk 的经典起点。',
    impressionImage: demoPlaceImpressions.wukang,
    photos: demoPlacePhotos.wukang,
    reviews: [],
    facilityCodes: ['outdoor'],
    evidenceIds: ['demo_evidence_wukang'],
    category: 'landmark',
    suggestedDurationMinutes: 60,
    openingIntervals: [{ startMinutes: 7 * 60, endMinutes: 22 * 60 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 0, upperMinor: 0, certainty: 'known', sourceRef: 'demo_free' },
  },
  {
    placeId: DEMO_PLACE_IDS.xujiahuiLibrary,
    name: '徐家汇书院',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.192304, lng: 121.432458, source: 'demo' },
    address: '漕溪北路158号',
    description: '全新开放的城市书房，阅读空间设计感十足，中庭的「光启之门」是打卡点，靠窗座位还能望见徐家汇天际线。',
    impressionImage: demoPlaceImpressions.xujiahuiLibrary,
    photos: demoPlacePhotos.xujiahuiLibrary,
    reviews: [],
    facilityCodes: ['indoor', 'seat', 'accessible'],
    evidenceIds: ['demo_evidence_library'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [{ startMinutes: 9 * 60, endMinutes: 21 * 60 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 0, upperMinor: 0, certainty: 'known', sourceRef: 'demo_free' },
  },
  {
    placeId: DEMO_PLACE_IDS.shanghaiLibrary,
    name: '上海图书馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.209211, lng: 121.440142, source: 'demo' },
    address: '淮海中路1555号',
    description: '藏书逾三千万册的大型研究型公共图书馆，阅览座位充足，展览与讲座常办，安静适合深度阅读。',
    impressionImage: demoPlaceImpressions.shanghaiLibrary,
    reviews: [],
    facilityCodes: ['indoor', 'seat', 'drink', 'accessible'],
    evidenceIds: ['demo_evidence_shlib'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [{ startMinutes: 9 * 60, endMinutes: 20 * 60 + 30 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 0, upperMinor: 0, certainty: 'known', sourceRef: 'demo_free' },
  },
  {
    placeId: DEMO_PLACE_IDS.longhuaTemple,
    name: '龙华寺',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.177080, lng: 121.447249, source: 'demo' },
    address: '龙华路2853号',
    description: '上海历史最悠久的古刹之一，龙华塔影与素斋闻名，每逢新年撞钟活动人气极高。',
    impressionImage: demoPlaceImpressions.longhuaTemple,
    photos: demoPlacePhotos.longhuaTemple,
    reviews: [],
    facilityCodes: ['indoor', 'food'],
    evidenceIds: ['demo_evidence_longhua'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [{ startMinutes: 7 * 60, endMinutes: 16 * 60 + 30 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 1000, upperMinor: 1000, certainty: 'known', sourceRef: 'demo_price' },
  },
  {
    placeId: DEMO_PLACE_IDS.westbundMuseum,
    name: '西岸美术馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.171541, lng: 121.454705, source: 'demo' },
    address: '龙腾大道2600号',
    description: '坐落徐汇滨江的美术馆，与蓬皮杜中心合作带来常设展。看完展沿滨江步道走走，江景开阔。',
    impressionImage: demoPlaceImpressions.westbundMuseum,
    photos: demoPlacePhotos.westbundMuseum,
    reviews: [],
    facilityCodes: ['indoor', 'accessible', 'rest_area'],
    evidenceIds: ['demo_evidence_westbund'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [{ startMinutes: 10 * 60, endMinutes: 17 * 60 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 8000, upperMinor: 8000, certainty: 'bounded', sourceRef: 'demo_price' },
  },
  {
    placeId: DEMO_PLACE_IDS.xujiahuiPark,
    name: '徐家汇公园',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.199279, lng: 121.437846, source: 'demo' },
    address: '肇嘉浜路986号',
    description: '由旧厂房改造的城市公园，保留烟囱与工业遗迹，湖景与步道适合散步放松。',
    impressionImage: demoPlaceImpressions.xujiahuiPark,
    photos: demoPlacePhotos.xujiahuiPark,
    reviews: [],
    facilityCodes: ['outdoor', 'walking', 'rest_area'],
    evidenceIds: ['demo_evidence_xjhpark'],
    category: 'rest',
    suggestedDurationMinutes: 40,
    openingIntervals: [{ startMinutes: 0, endMinutes: 24 * 60 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 0, upperMinor: 0, certainty: 'known', sourceRef: 'demo_free' },
  },
  {
    placeId: DEMO_PLACE_IDS.guilinPark,
    name: '桂林公园',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.167189, lng: 121.413286, source: 'demo' },
    address: '漕宝路188号',
    description: '以桂花闻名的江南古典园林，秋天满园桂香。园内亭台假山错落，是喝茶赏秋的好去处。',
    impressionImage: demoPlaceImpressions.guilinPark,
    photos: demoPlacePhotos.guilinPark,
    reviews: [],
    facilityCodes: ['outdoor', 'walking'],
    evidenceIds: ['demo_evidence_guilin'],
    category: 'rest',
    suggestedDurationMinutes: 50,
    openingIntervals: [{ startMinutes: 7 * 60, endMinutes: 18 * 60 }],
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 200, upperMinor: 200, certainty: 'known', sourceRef: 'demo_price' },
  },
  // 徐汇区补充目录。坐标为 WGS84；开放时间不确定的场馆不预填时间限制。
  {
    placeId: 'xh-guangqi-park',
    name: '光启公园',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1915960, lng: 121.4301649, source: 'catalog-wgs84' },
    address: '南丹路17号',
    description: '南丹路17号的徐家汇历史公园，园内设有徐光启纪念馆。',
    impressionImage: '/images/places/impression/guangqi-park-1.png',
    facilityCodes: ['indoor', 'outdoor', 'walking'],
    category: 'culture',
    suggestedDurationMinutes: 30,
    openingIntervals: [],
  },
  {
    placeId: 'xh-bibliotheca-zi-ka-wei',
    name: '徐家汇藏书楼',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1939328, lng: 121.4329485, source: 'openstreetmap' },
    address: '漕溪北路80号',
    description: '徐家汇历史建筑群中的藏书楼，适合与周边的徐家汇源景点一同游览。',
    impressionImage: '/images/places/impression/bibliotheca-zi-ka-wei-1.png',
    facilityCodes: ['indoor', 'accessible'],
    category: 'culture',
    suggestedDurationMinutes: 45,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-meteorological-museum',
    name: '上海气象博物馆（徐家汇观象台）',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1917331, lng: 121.4323362, source: 'openstreetmap' },
    address: '浦西路166号',
    description: '由徐家汇观象台旧址改建的气象主题博物馆，展示上海气象观测与城市历史。',
    impressionImage: '/images/places/impression/meteorological-museum-1.png',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 45,
    openingIntervals: [],
  },
  {
    placeId: 'xh-soong-ching-ling-former-residence',
    name: '宋庆龄故居纪念馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.2057687, lng: 121.4344177, source: 'openstreetmap' },
    address: '淮海中路1843号',
    description: '以宋庆龄在上海生活与工作的旧居为核心的纪念场所，保留住宅和庭院风貌。',
    impressionImage: '/images/places/impression/soong-ching-ling-1.png',
    facilityCodes: ['indoor', 'outdoor'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-sjtu-xuhui-campus',
    name: '上海交通大学徐汇校区',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.2008911, lng: 121.4283949, source: 'openstreetmap' },
    address: '华山路1954号',
    description: '上海交通大学徐汇校区，以校园历史建筑与林荫道路闻名。',
    impressionImage: '/images/places/impression/shanghaijiaotonguniversity-1.jpg',
    facilityCodes: ['outdoor', 'walking'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-film-museum',
    name: '上海电影博物馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1880906, lng: 121.4336552, source: 'openstreetmap' },
    address: '漕溪北路595号',
    description: '围绕上海电影发展历程设置展览，可了解电影制作、放映和影人故事。',
    impressionImage: '/images/places/impression/film-museum-1.png',
    facilityCodes: ['indoor', 'accessible'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-public-security-museum',
    name: '上海公安博物馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.2003517, lng: 121.4637986, source: 'openstreetmap' },
    address: '瑞金南路518号',
    description: '以近现代上海警务历史为主题的专题博物馆。',
    impressionImage: '/images/places/impression/public-security-museum-1.png',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 75,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-arts-and-crafts-museum',
    name: '上海工艺美术博物馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.212213, lng: 121.4498928, source: 'openstreetmap' },
    address: '汾阳路79号',
    description: '设于历史建筑中的工艺美术专题馆，可了解上海传统工艺与工艺美术作品。',
    impressionImage: '/images/places/impression/arts-and-crafts-museum-1.png',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-longhua-martyrs-memorial-park',
    name: '龙华烈士陵园',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.178577, lng: 121.444398, source: 'openstreetmap' },
    address: '龙华西路180号',
    description: '由纪念场馆与园林组成的纪念地，参观时请保持安静并遵守现场规定。',
    facilityCodes: ['outdoor', 'walking'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [],
  },
  {
    placeId: 'xh-long-museum-west-bund',
    name: '龙美术馆（西岸馆）',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.185916, lng: 121.460193, source: 'openstreetmap' },
    address: '龙腾大道3398号',
    description: '西岸滨江的美术馆，展览内容以馆方当期安排为准。',
    facilityCodes: ['indoor', 'accessible'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-center-of-photography',
    name: '上海摄影艺术中心',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1698825, lng: 121.4583913, source: 'openstreetmap' },
    address: '龙腾大道2555号-1',
    description: '专注摄影艺术展览与交流的空间，位于西岸滨江文化带。',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-tank-shanghai',
    name: '油罐艺术中心',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.166527, lng: 121.459405, source: 'openstreetmap' },
    address: '龙腾大道2380号',
    description: '由旧油罐改造的艺术展览空间，位于徐汇滨江。',
    facilityCodes: ['indoor', 'outdoor'],
    category: 'culture',
    suggestedDurationMinutes: 75,
    openingIntervals: [],
  },
  {
    placeId: 'xh-west-bund-dream-center',
    name: '西岸梦中心',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1623426, lng: 121.4615928, source: 'openstreetmap' },
    address: '龙腾大道2266号',
    description: '徐汇滨江的开放式商业与休闲空间，可沿江散步并按现场营业情况选择餐饮。',
    facilityCodes: ['outdoor', 'walking', 'food'],
    category: 'rest',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-botanical-garden',
    name: '上海植物园',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1498128, lng: 121.4404241, source: 'openstreetmap' },
    address: '龙吴路1111号',
    description: '以植物专类园和园林景观为特色的大型植物园，园区内容随季节变化。',
    facilityCodes: ['outdoor', 'walking'],
    category: 'nature',
    suggestedDurationMinutes: 120,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-stadium',
    name: '上海体育场',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1833432, lng: 121.4373709, source: 'openstreetmap' },
    address: '天钥桥路666号',
    description: '大型体育场馆，赛事与活动期间可按现场安排参观或观赛。',
    facilityCodes: ['outdoor'],
    category: 'landmark',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-shanghai-indoor-stadium',
    name: '上海体育馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1832847, lng: 121.4337061, source: 'openstreetmap' },
    address: '漕溪北路1111号',
    description: '上海的室内体育与演出场馆之一，具体活动信息以场馆公告为准。',
    facilityCodes: ['indoor'],
    category: 'landmark',
    suggestedDurationMinutes: 45,
    openingIntervals: [],
  },
  {
    placeId: 'xh-tushanwan-museum',
    name: '土山湾博物馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1884890, lng: 121.4305227, source: 'catalog-wgs84' },
    address: '蒲汇塘路55号-1临',
    description: '在土山湾孤儿院旧址上建成的博物馆，展陈上海近代工艺、绘画与中西文化交流史。',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-start-museum',
    name: '星美术馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.1897166, lng: 121.4657116, source: 'openstreetmap' },
    address: '瑞宁路111号',
    description: '由旧铁路货栈改造而成的当代艺术馆，保留了铁轨、吊塔与火车等工业遗存。',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 90,
    openingIntervals: [],
  },
  {
    placeId: 'xh-xuhui-art-museum',
    name: '徐汇艺术馆',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.2120365, lng: 121.4436116, source: 'catalog-wgs84' },
    address: '淮海中路1413号',
    description: '位于淮海中路的区级艺术馆，常设展览与活动安排以场馆公告为准。',
    impressionImage: '/images/places/impression/xuhui-art-museum-1.png',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  },
  {
    placeId: 'xh-ba-jin-former-residence',
    name: '巴金故居',
    cityCode: '310100',
    districtAdcode: '310104',
    coordinates: { lat: 31.215026, lng: 121.447147, source: 'catalog-wgs84' },
    address: '武康路113号',
    description: '截至2026年9月24日，上海市虹口区政府公告称故居因修缮暂停开放；出发前请再核对最新公告。',
    impressionImage: '/images/places/impression/ba-jin-residence-1.png',
    facilityCodes: ['indoor'],
    category: 'culture',
    suggestedDurationMinutes: 45,
    openingIntervals: [],
  },
];

function demoRoutes(
  stops: Array<{ placeId: string }>,
  modes: Array<{ mode: 'walking' | 'transit' | 'driving'; minutes: number; meters: number; buffer?: number }>,
): ScheduleRoute[] {
  const result: ScheduleRoute[] = [];
  stops.forEach((stop, index) => {
    if (index === 0) {
      result.push({
        legId: `origin-${stop.placeId}`,
        fromStopId: 'origin',
        toStopId: stop.placeId,
        transportMode: 'walking',
        durationMinutes: 10,
        walkingMeters: 700,
        distanceMeters: 700,
        bufferMinutes: 5,
        departureSupport: 'demo',
      });
      return;
    }
    const mode = modes[index] ?? modes[modes.length - 1];
    result.push({
      legId: `${stops[index - 1].placeId}-${stop.placeId}`,
      fromStopId: stops[index - 1].placeId,
      toStopId: stop.placeId,
      transportMode: mode.mode,
      durationMinutes: mode.minutes,
      walkingMeters: mode.mode === 'walking' ? mode.meters : 0,
      distanceMeters: mode.meters,
      bufferMinutes: mode.buffer ?? 5,
      departureSupport: 'demo',
    });
  });
  return result;
}

export interface DemoPlanInput {
  tripId: string;
  dataMode: 'online' | 'demo';
  timezone: string;
  travelDate?: string;
  dayStartMinutes: number;
  partySize?: number;
  /** 是否插入硬条件休息点。 */
  includeRest?: boolean;
  /** 自定义顺序；用于雨天室内替代等样例。 */
  orderedPlaceIds?: string[];
  /** 出发时间；用于延误案例。 */
  departureMinutes?: number;
}

/** 生成可复算的上海样例计划（营业与费用为演示值）。 */
export function buildDemoPlanSnapshot(input: DemoPlanInput): TripSnapshot {
  const byId = new Map(DEMO_SHANGHAI_PLACES.map((place) => [place.placeId, place]));
  const orderedIds = input.orderedPlaceIds
    ? input.orderedPlaceIds
    : input.includeRest
      ? [DEMO_PLACE_IDS.wukang, DEMO_PLACE_IDS.xujiahuiPark, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.longhuaTemple, DEMO_PLACE_IDS.guilinPark]
      : [DEMO_PLACE_IDS.wukang, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.longhuaTemple];
  const segments: ScheduleSegment[] = orderedIds.map((placeId) => {
    const place = byId.get(placeId);
    if (!place) throw new Error(`missing demo place ${placeId}`);
    return {
      stopId: placeId,
      placeId,
      placeName: place.name,
      coordinates: place.coordinates,
      facilityCodes: place.facilityCodes,
      durationMinutes: place.suggestedDurationMinutes ?? 60,
      minDurationMinutes: place.suggestedDurationMinutes ?? 60,
      openingIntervals: place.openingIntervals,
    };
  });
  const routes = demoRoutes(
    orderedIds.map((placeId) => ({ placeId })),
    input.includeRest
      ? [
          { mode: 'walking', minutes: 10, meters: 700 },
          { mode: 'walking', minutes: 5, meters: 250 },
          { mode: 'transit', minutes: 10, meters: 600 },
          { mode: 'transit', minutes: 12, meters: 900 },
          { mode: 'walking', minutes: 10, meters: 500 },
        ]
      : [
          { mode: 'walking', minutes: 10, meters: 700 },
          { mode: 'transit', minutes: 10, meters: 600 },
          { mode: 'transit', minutes: 12, meters: 900 },
          { mode: 'walking', minutes: 10, meters: 500 },
        ],
  );
  const schedule = propagateSchedule({
    departureMinutes: input.departureMinutes ?? input.dayStartMinutes,
    segments,
    routes,
  });

  const plannedCharges = orderedIds
    .map((placeId, index) => {
      const place = byId.get(placeId);
      if (!place?.costEstimate) return null;
      return {
        chargeId: `charge_${index + 1}_${placeId}`,
        stopId: placeId,
        quantity: 1,
        costEstimate: place.costEstimate,
        paymentStatus: 'unpaid' as const,
      };
    })
    .filter((charge): charge is NonNullable<typeof charge> => Boolean(charge));

  return normalizeTripSnapshot({
    schemaVersion: 1,
    tripId: input.tripId,
    dataMode: input.dataMode,
    lifecycle: 'draft',
    planningStatus: 'validated',
    timezone: input.timezone,
    travelDate: input.travelDate,
    dayStartMinutes: input.dayStartMinutes,
    tripSettings: {
      cityCode: '310100',
      localDate: input.travelDate,
      timezone: input.timezone,
      partySize: input.partySize ?? 2,
      dayStartAt: input.dayStartMinutes,
    },
    budget: {
      currency: 'CNY',
      limitMinor: 20000,
      strength: 'hard',
      scope: 'trip',
    },
    constraints: [],
    stops: schedule.stops,
    routeLegs: schedule.routeLegs,
    plannedCharges,
    version: 0,
    contextSnapshotId: null,
  });
}

/** 生成“想休息”候选：保留后续节点，插入有设施证据的休息点。 */
export function buildRestReplanSnapshot(current: TripSnapshot): TripSnapshot {
  const normalized = normalizeTripSnapshot(current);
  const tripId = normalized.tripId;
  const base = buildDemoPlanSnapshot({
    tripId,
    dataMode: normalized.dataMode,
    timezone: normalized.timezone,
    travelDate: normalized.travelDate,
    dayStartMinutes: normalized.dayStartMinutes,
    partySize: normalized.tripSettings?.partySize ?? 2,
    includeRest: true,
    departureMinutes: normalized.stops[0]?.plannedArrivalMinutes ?? normalized.dayStartMinutes,
  });
  return {
    ...base,
    lifecycle: normalized.lifecycle,
    contextSnapshotId: normalized.contextSnapshotId,
  };
}

/** 雨天样例：用有室内证据的节点替换户外首站。 */
export function buildRainReplanSnapshot(current: TripSnapshot): TripSnapshot {
  const normalized = normalizeTripSnapshot(current);
  const base = buildDemoPlanSnapshot({
    tripId: normalized.tripId,
    dataMode: normalized.dataMode,
    timezone: normalized.timezone,
    travelDate: normalized.travelDate,
    dayStartMinutes: normalized.dayStartMinutes,
    partySize: normalized.tripSettings?.partySize ?? 2,
    orderedPlaceIds: [DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.westbundMuseum, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.longhuaTemple],
    departureMinutes: normalized.dayStartMinutes,
  });
  return {
    ...base,
    lifecycle: normalized.lifecycle,
    contextSnapshotId: normalized.contextSnapshotId,
  };
}

/** 延误样例：固定预约不移动，从更晚的出发时刻完整传播后续时间。 */
export function buildDelayReplanSnapshot(current: TripSnapshot, delayMinutes = 30): TripSnapshot {
  const normalized = normalizeTripSnapshot(current);
  const base = buildDemoPlanSnapshot({
    tripId: normalized.tripId,
    dataMode: normalized.dataMode,
    timezone: normalized.timezone,
    travelDate: normalized.travelDate,
    dayStartMinutes: normalized.dayStartMinutes,
    partySize: normalized.tripSettings?.partySize ?? 2,
    departureMinutes: normalized.dayStartMinutes + Math.max(0, delayMinutes),
  });
  return {
    ...base,
    lifecycle: normalized.lifecycle,
    contextSnapshotId: normalized.contextSnapshotId,
  };
}

/** 三类事件的 demo 候选入口；未知事件不猜测，退回休息样例。 */
export function buildEventReplanSnapshot(
  current: TripSnapshot,
  event: Record<string, unknown> | undefined,
): TripSnapshot {
  const type = typeof event?.type === 'string' ? event.type : 'rest_requested';
  if (type.includes('rain')) return buildRainReplanSnapshot(current);
  if (type.includes('delay')) {
    const delayMinutes = Number(event?.delayMinutes ?? 30);
    return buildDelayReplanSnapshot(current, Number.isFinite(delayMinutes) ? delayMinutes : 30);
  }
  return buildRestReplanSnapshot(current);
}
