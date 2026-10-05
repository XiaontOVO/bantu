const IMPRESSIONS = Object.freeze({
  '武康大楼': { file: 'impression/wukang-1.jpg', key: 'wukang', accent: '#a94d38', wash: '#eee5d6' },
  '徐家汇书院': { file: 'impression/xujiahui-library-1.jpg', key: 'xujiahui-library', accent: '#39708c', wash: '#e8e2d8' },
  '上海图书馆': { file: 'impression/shanghai-library-1.jpg', key: 'shanghai-library', accent: '#315c7b', wash: '#eee8dd' },
  '龙华寺': { file: 'impression/longhua-1.jpg', key: 'longhua', accent: '#d45b24', wash: '#f0b748' },
  '西岸美术馆': { file: 'impression/west-bund-museum-impression-1.png', key: 'westbund-museum', accent: '#c94c34', wash: '#eee7dc' },
  '徐家汇公园': { file: 'impression/xujiahui-park-1.jpg', key: 'xujiahui-park', accent: '#4c7c47', wash: '#e7eddc' },
  '桂林公园': { file: 'impression/guilin-park-1.jpg', key: 'guilin-park', accent: '#71893b', wash: '#edf0d4' },
  '上海工艺美术博物馆': { file: 'impression/arts-and-crafts-museum-1.png', key: 'arts-and-crafts-museum', accent: '#8b5d49', wash: '#eee5d8' },
  '巴金故居': { file: 'impression/ba-jin-residence-1.png', key: 'ba-jin-residence', accent: '#985c42', wash: '#efe5d8' },
  '徐家汇藏书楼': { file: 'impression/bibliotheca-zi-ka-wei-1.png', key: 'bibliotheca-zi-ka-wei', accent: '#526e8a', wash: '#e7e8df' },
  '上海电影博物馆': { file: 'impression/film-museum-1.png', key: 'film-museum', accent: '#a9433e', wash: '#eee2da' },
  '光启公园': { file: 'impression/guangqi-park-1.png', key: 'guangqi-park', accent: '#4d7d48', wash: '#e7eddc' },
  '上海气象博物馆（徐家汇观象台）': { file: 'impression/meteorological-museum-1.png', key: 'meteorological-museum', accent: '#47778d', wash: '#e2ebeb' },
  '上海公安博物馆': { file: 'impression/public-security-museum-1.png', key: 'public-security-museum', accent: '#4c627b', wash: '#e3e9e9' },
  '上海交通大学徐汇校区': { file: 'impression/shanghaijiaotonguniversity-1.jpg', key: 'shanghaijiaotonguniversity', accent: '#914c4c', wash: '#efe3d8' },
  '宋庆龄故居纪念馆': { file: 'impression/soong-ching-ling-1.png', key: 'soong-ching-ling', accent: '#657b54', wash: '#e9ebdd' },
  '徐汇艺术馆': { file: 'impression/xuhui-art-museum-1.png', key: 'xuhui-art-museum', accent: '#74618b', wash: '#eae4ed' },
  '龙华烈士陵园': { file: 'impression/longhua-martyrs-park-ai-2x1.png', key: 'longhua-martyrs-park', accent: '#9a493d', wash: '#eee5d8' },
  '龙美术馆（西岸馆）': { file: 'impression/long-museum-west-bund-ai-2x1.png', key: 'long-museum-west-bund', accent: '#b85b3d', wash: '#eee5d8' },
  '上海摄影艺术中心': { file: 'impression/shanghai-center-of-photography-ai-2x1.png', key: 'shanghai-center-of-photography', accent: '#3e708a', wash: '#e8e8df' },
  '油罐艺术中心': { file: 'impression/tank-art-center-ai-2x1.png', key: 'tank-art-center', accent: '#a75036', wash: '#eee2d4' },
  '西岸梦中心': { file: 'impression/west-bund-dream-center-ai-2x1.png', key: 'west-bund-dream-center', accent: '#b45f3e', wash: '#e9e7d9' },
  '上海植物园': { file: 'impression/shanghai-botanical-garden-ai-2x1.png', key: 'shanghai-botanical-garden', accent: '#54784d', wash: '#e8eddc' },
  '上海体育场': { file: 'impression/shanghai-stadium-ai-2x1.png', key: 'shanghai-stadium', accent: '#547568', wash: '#e6ece4' },
  '上海体育馆': { file: 'impression/shanghai-indoor-stadium-ai-2x1.png', key: 'shanghai-indoor-stadium', accent: '#547568', wash: '#e6ece4' },
  '土山湾博物馆': { file: 'impression/tushanwan-museum-ai-2x1.png', key: 'tushanwan-museum', accent: '#9a5945', wash: '#eee4d8' },
  '星美术馆': { file: 'impression/start-museum-ai-2x1.png', key: 'start-museum', accent: '#557789', wash: '#e8e7df' },
});

const CATEGORY_THEME = Object.freeze({
  landmark: { accent: '#a94d38', wash: '#eee5d6' },
  culture: { accent: '#39708c', wash: '#e8e2d8' },
  rest: { accent: '#4c7c47', wash: '#e7eddc' },
  food: { accent: '#bd6b2d', wash: '#f4e4cf' },
});

// 旧地点快照保留原路径时也采用现行插画；西岸美术馆的历史扩展名一并修正。
const LOCAL_IMAGE_ALIASES = Object.freeze({
  '/images/places/impression/longhua-martyrs-park-1.jpg': '/images/places/impression/longhua-martyrs-park-ai-2x1.png',
  '/images/places/impression/long-museum-west-bund-1.jpg': '/images/places/impression/long-museum-west-bund-ai-2x1.png',
  '/images/places/impression/shanghai-center-of-photography-1.jpg': '/images/places/impression/shanghai-center-of-photography-ai-2x1.png',
  '/images/places/impression/tank-art-center-1.jpg': '/images/places/impression/tank-art-center-ai-2x1.png',
  '/images/places/impression/west-bund-dream-center-1.jpg': '/images/places/impression/west-bund-dream-center-ai-2x1.png',
  '/images/places/impression/shanghai-botanical-garden-1.jpg': '/images/places/impression/shanghai-botanical-garden-ai-2x1.png',
  '/images/places/impression/shanghai-stadium-1.jpg': '/images/places/impression/shanghai-stadium-ai-2x1.png',
  '/images/places/impression/shanghai-indoor-stadium-1.jpg': '/images/places/impression/shanghai-indoor-stadium-ai-2x1.png',
  '/images/places/impression/tushanwan-museum-1.jpg': '/images/places/impression/tushanwan-museum-ai-2x1.png',
  '/images/places/impression/start-museum-1.jpg': '/images/places/impression/start-museum-ai-2x1.png',
  '/images/places/impression/westbund-1.jpg': '/images/places/impression/west-bund-museum-impression-1.png',
  '/images/places/impression/west-bund-museum-impression-1.jpg': '/images/places/impression/west-bund-museum-impression-1.png',
});

const NAME_ALIASES = Object.freeze({
  '上海图书馆淮海中路馆': '上海图书馆',
  '上海图书馆（淮海中路馆）': '上海图书馆',
  '上海气象博物馆': '上海气象博物馆（徐家汇观象台）',
  '上海交通大学': '上海交通大学徐汇校区',
  '上海交通大学徐家汇藏书楼': '徐家汇藏书楼',
  '徐家汇藏书楼（上海交通大学）': '徐家汇藏书楼',
  '巴金故居纪念馆': '巴金故居',
  '复旦大学邯郸校区': '复旦大学',
});

function localImage(value) {
  if (typeof value !== 'string') return '';
  const src = value.trim();
  if (!src.startsWith('/images/places/') || src.startsWith('//') || src.includes('\\')) return '';
  const pathname = src.split(/[?#]/, 1)[0];
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.split('/').some(segment => segment === '..')) return '';
  } catch { return ''; }
  if (!/^\/images\/places\/[a-z0-9_\/-]+\.(?:jpe?g|png|webp)$/i.test(pathname)) return '';
  const canonicalPath = LOCAL_IMAGE_ALIASES[pathname];
  return canonicalPath ? `${canonicalPath}${src.slice(pathname.length)}` : src;
}

/** 无插画地点的占位印象图：按分类主题色绘制的扁平风景插画（内联 SVG，无外部文件）。 */
function placeholderArt(accent, wash) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" role="img" aria-label="印象占位图">` +
    `<rect width="400" height="200" fill="${wash}"/>` +
    `<circle cx="312" cy="62" r="36" fill="${accent}" opacity=".75"/>` +
    `<path d="M0 142 C96 112 188 137 262 131 S368 112 400 121 V200 H0 Z" fill="${accent}" opacity=".22"/>` +
    `<path d="M0 168 C110 143 226 165 318 159 S388 152 400 155 V200 H0 Z" fill="${accent}" opacity=".4"/>` +
    `<path d="M64 159 C130 143 224 149 316 157" fill="none" stroke="${wash}" stroke-width="5" stroke-linecap="round" opacity=".85"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 已登记地点统一使用对应插画，避免旧地点记录里的过期路径覆盖正确素材；未登记地点可使用本地自定义图。 */
export function placeImpression(place) {
  const rawName = typeof place?.name === 'string' ? place.name.trim() : '';
  const name = NAME_ALIASES[rawName] || rawName;
  const mapped = IMPRESSIONS[name];
  const src = mapped ? `/images/places/${mapped.file}` : localImage(place?.impressionImage);
  const category = CATEGORY_THEME[place?.category] || CATEGORY_THEME.landmark;
  // 没有插画的地点返回按分类主题色的占位印象图（placeholder: true），
  // 保证列表与详情都有完整的印象视觉；占位图不可放大查看。
  if (!src) {
    return { src: placeholderArt(category.accent, category.wash), key: 'placeholder', accent: category.accent, wash: category.wash, placeholder: true };
  }
  return {
    src,
    key: mapped?.key || 'custom',
    accent: mapped?.accent || category.accent,
    wash: mapped?.wash || category.wash,
    placeholder: false,
  };
}
