/** Curated, versioned interpretation layers. Artwork is never a navigation map. */
export interface PlaceSceneHotspot {
  id: string;
  title: string;
  floor?: string;
  anchor: { x: number; y: number };
  summary: string;
  story?: string;
  detail: string;
  evidence: string;
  checkedAt: string;
  mapLabel?: string;
}

export interface PlaceScene {
  id: string;
  placeName: string;
  version: number;
  artwork: string;
  soundTheme: 'nature' | 'street' | 'library' | 'park' | 'temple' | 'garden' | 'gallery';
  stageCaption: string;
  startQuestion: string;
  subtitle: string;
  introduction: string;
  evidenceNote: string;
  arrival: { lat: number; lng: number; radiusMeters: number; source: string; checkedAt: string };
  hotspots: PlaceSceneHotspot[];
}

const naturalHistoryScene: PlaceScene = {
  id: 'shanghai-natural-history',
  placeName: '上海自然博物馆',
  version: 2,
  artwork: '/images/places/scene/shanghai-natural-history-v2.jpg',
  soundTheme: 'nature',
  stageCaption: '一座馆，许多故事',
  startQuestion: '这座馆，从哪里开始？',
  subtitle: '从一座馆，走进生命的故事',
  introduction: '想先看建筑光影，还是点开生命与演化主题？这幅画是艺术表达，实际展区可以对照 L1 与 B1 资料。',
  evidenceNote: '场景为 AI 生成的自然主题艺术空间，不是实际展项、实景照片或室内定位图；画中的骨架与化石不表示所在楼层或真实陈列位置；楼层信息依据已收录的馆方导览资料，展陈与开放以现场为准。',
  arrival: {
    lat: 31.236921, lng: 121.458101, radiusMeters: 75,
    source: '高德地点目录 GCJ02 坐标转 WGS84（保守触发范围，非场地边界）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'architecture', story: '先留意画中的建筑光影：玻璃、结构与绿意相互映照。这是自然主题的艺术空间，实际建筑与入口请对照场地总览。', title: '先看这座建筑', anchor: { x: 24, y: 61 },
      summary: '留意建筑光影，再选一个自然主题。',
      detail: '这幅画以玻璃结构、绿意和自然主题组合成艺术空间，不表示实际馆内布局或真实展项，不用于识别入口、楼梯或卫生间。需要找路时，请打开场地总览和现场指引。',
      evidence: '伴途地点收录与场地资料；插画为原创艺术表达', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'life-river', story: '把目光交给画里的生命姿态，骨骼、尺度与光线让自然主题变得直观。想了解实际展区，可以打开 L1“生命长河”资料。', title: '生命长河', floor: 'L1', anchor: { x: 51, y: 47 },
      summary: '馆方导览将“生命长河 · 体验自然”列在 L1。',
      detail: '可以从 L1 的“生命长河”开始。现有资料能确认它属于 L1，不能据此判断你已经进入这一展区，也不能保证具体展项正在开放。',
      evidence: '上海自然博物馆官网楼层导览（伴途重绘资料）', checkedAt: '2026-09-30',
      mapLabel: '查看 L1 平面图',
    },
    {
      id: 'evolution', story: '一块化石像一页很久以前留下的书。画面以标本表达演化主题；想查实际展区，请打开 B1“演化之道”资料。', title: '演化之道', floor: 'B1', anchor: { x: 76, y: 66 },
      summary: '馆方导览将“演化之道 · 未来之路”列在 B1。',
      detail: '想继续看演化主题，可以先了解 B1 的“演化之道”。楼层图仅帮助辨认区域，馆内路线与临时展陈仍以现场标识为准。',
      evidence: '上海自然博物馆官网楼层导览（伴途重绘资料）', checkedAt: '2026-09-30',
      mapLabel: '查看 B1 平面图',
    },
  ],
};

const wukangScene: PlaceScene = {
  id: 'wukang-building',
  placeName: '武康大楼',
  version: 2,
  artwork: '/images/places/scene/wukang-building-v2.jpg',
  soundTheme: 'street',
  stageCaption: '一处街角，几种视角',
  startQuestion: '先看这座街角建筑的哪一面？',
  subtitle: '沿着街角，读懂一座建筑的表情',
  introduction: '可以先看弧形转角，再留意红砖、窗与街道之间的关系。所有视角都只对应室外可见的外观。',
  evidenceNote: '伴途依据已收录的武康大楼外观照片绘制AI 艺术场景；不是实景、测绘图或室内参观指引。建筑内部没有已核实的公众参观平面资料。',
  arrival: {
    lat: 31.206298, lng: 121.433655, radiusMeters: 60,
    source: '高德地点目录 GCJ02 坐标转 WGS84（候选触发范围，非街道或建筑边界）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'brick-facade', story: '先别急着拍照。把视线从浅色石质底层移向红砖，再看看窗与小阳台怎样一层层展开，读出这座建筑的节奏。', title: '红砖立面', anchor: { x: 29, y: 65 },
      summary: '红砖墙面与浅色石质底层，构成这座建筑醒目的层次。',
      detail: '从已收录的室外照片能看到红砖墙、成排窗户和浅色底层。插画只提取外观特征，不给出哪扇门可进入或室内用途。',
      evidence: '伴途收录的武康大楼室外外观照片', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'curved-corner', story: '顺着弧形转角往上看，窗、阳台和檐口一起绕过街角。这条柔和的轮廓，让武康大楼从不同方向看都有自己的表情。', title: '弧形转角', anchor: { x: 51, y: 46 },
      summary: '建筑在两条路相接处收成圆弧，转角轮廓是辨认它的关键。',
      detail: '可把视线放在转角处层层展开的窗、檐与立面。插画强调轮廓，不是建筑尺寸或入口位置；请从安全的人行空间观察。',
      evidence: '伴途收录的武康大楼街角照片与地点地址', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'street-view', story: '把镜头稍稍放低，看看街道怎样托起建筑的轮廓。树影、行人和路口让画面有了生活气息；现场观察请留在人行空间。', title: '街口视角', anchor: { x: 73, y: 70 },
      summary: '从街口看建筑与周围街道相接，而非只看一面墙。',
      detail: '这里适合比较建筑的转角与两侧立面。实际道路、行人和车流会变化，画中的街道不能用于选择过街位置或导航。',
      evidence: '伴途收录的武康大楼街口照片', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
  ],
};

const xujiahuiLibraryScene: PlaceScene = {
  id: 'xujiahui-library',
  placeName: '徐家汇书院',
  version: 2,
  artwork: '/images/places/scene/xujiahui-library-v2.jpg',
  soundTheme: 'library',
  stageCaption: '翻开一页，走进书院',
  startQuestion: '想先了解书墙，还是挑一层阅读？',
  subtitle: '从书架到楼层，找到自己的阅读节奏',
  introduction: '这幅画把书墙与阅读氛围放在一起。点开主题后，可对照已收录的楼层资料了解不同阅读空间。',
  evidenceNote: '伴途依据已收录的书院室内照片及楼层资料绘制艺术场景；书架、光影和席位不表示真实房间布局。楼层资料来自公开设计图的本地重绘，实际区域与开放情况以现场标识为准。',
  arrival: {
    lat: 31.192304, lng: 121.432458, radiusMeters: 65,
    source: '高德地点目录 GCJ02 坐标转 WGS84（候选触发范围，非建筑边界）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'book-wall', story: '沿着书脊慢慢看过去，木色、灯光与成列的书册，构成这里最温暖的阅读印象。你会先注意到哪一本书的颜色？', title: '走近书墙', anchor: { x: 28, y: 65 },
      summary: '已收录的室内照片呈现木色书架和成列书册。',
      detail: '可以先从书架的材质、灯光和书脊开始观察。画中的书墙是艺术化组合，不代表具体书目、藏书位置或你当前所在的房间。',
      evidence: '伴途收录的徐家汇书院室内实拍照片', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'children-reading', story: '小桌、书页和低一些的视角，让阅读变成可以一起分享的时刻。画面只是儿童阅读主题；实际一层区域请对照楼层资料。', title: '儿童阅览', floor: '1F', anchor: { x: 51, y: 48 },
      summary: '本地重绘的一层设计平面列有儿童阅览区域。',
      detail: '若想和孩子一起看书，可先查一层资料，再以现场标识确认实际开放的阅读区。设计平面不保证今天的书架、座位或通道与图上相同。',
      evidence: '徐家汇书院 1F 设计平面本地重绘资料', checkedAt: '2026-09-30',
      mapLabel: '查看 1F 平面图',
    },
    {
      id: 'upstairs-reading', story: '把目光移向画里的阅读席位，想象把城市的节奏暂时放慢。想找阅览、自习或电子阅览区域，可以打开二层资料核对。', title: '二层阅读', floor: '2F', anchor: { x: 75, y: 67 },
      summary: '本地重绘的二层设计平面列有阅览、自习和电子阅览。',
      detail: '想安静阅读或自习，可以查看二层已收录的功能区资料。此处只介绍设计平面中的功能，不能推断实时空座、使用规则或你所在楼层。',
      evidence: '徐家汇书院 2F 设计平面本地重绘资料', checkedAt: '2026-09-30',
      mapLabel: '查看 2F 平面图',
    },
  ],
};

const xujiahuiParkScene: PlaceScene = {
  id: 'xujiahui-park',
  placeName: '徐家汇公园',
  version: 2,
  artwork: '/images/places/scene/xujiahui-park-v2.jpg',
  soundTheme: 'park',
  stageCaption: '树荫里的城市片刻',
  startQuestion: '想先看烟囱，还是沿着树荫慢慢走？',
  subtitle: '在城市绿意中，发现留在公园里的不同视角',
  introduction: '这幅原创园景把烟囱、林荫步道和高架步道的不同视角放在一张画里。点开一处了解它，再用场地总览辨认实际方位。',
  evidenceNote: '画面依据已收录的徐家汇公园烟囱与步道照片作艺术化组合，不是实景照片、设施现状或路线图；三个元素的画面相对位置不表示真实相邻关系，开放和通行请以现场为准。',
  arrival: {
    lat: 31.199279, lng: 121.437846, radiusMeters: 105,
    source: '高德地点目录 GCJ02 坐标转 WGS84（公园中心候选范围，未覆盖整片公园）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'chimney', story: '先抬头看那条修长的红砖轮廓。烟囱从树冠中伸出来，砖色与绿意形成鲜明对照，让公园有了一眼能记住的视觉标记。', title: '红砖烟囱', anchor: { x: 26, y: 57 },
      summary: '已收录的公园照片中，可以看到一座修长的红砖烟囱。',
      detail: '不妨先抬头辨认烟囱的圆筒轮廓与砖色。插画保留了这一视觉特征，但不标示它的准确位置，也不能据此判断建筑能否进入。',
      evidence: '徐家汇公园烟囱本地照片（Livelikerw，CC BY-SA 3.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'tree-walk', story: '沿着画里的树荫看向远处，光斑、铺装和树冠把视线带进绿地。此刻不妨慢一点，看看脚边的光影怎样变化。', title: '林荫步道', anchor: { x: 50, y: 72 },
      summary: '已收录的步道照片展示了树冠、铺装步道与两侧绿地。',
      detail: '走在树荫下，可以留意树冠与道路形成的纵深感。这幅画把不同照片的景物组合成一条视觉轴线，不是当前步行路线；要找入口、出口或设施请查看地图与现场指示。',
      evidence: '徐家汇公园步道本地照片（Szalai.laci，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'skywalk', story: '换一个高度，绿地的层次也会改变。画里的高架步行结构呈现了这种视角；实际接入点与通行状态请查看现场指示。', title: '高架步道', anchor: { x: 77, y: 52 },
      summary: '已收录的步道照片左侧可以辨认出一段抬高的步行结构。',
      detail: '可以比较地面与高架视角如何改变你对绿地的观察。插画里的桥和照片中的步道只是主题对应，不代表实际接入点、无障碍条件或实时通行状态。',
      evidence: '徐家汇公园步道本地照片与高德“景观天桥”地点目录', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
  ],
};

const longhuaTempleScene: PlaceScene = {
  id: 'longhua-temple',
  placeName: '龙华寺',
  version: 2,
  artwork: '/images/places/scene/longhua-temple-v2.jpg',
  soundTheme: 'temple',
  stageCaption: '慢下来，看见檐与塔',
  startQuestion: '先看塔檐，还是从庭院里的细节开始？',
  subtitle: '从塔到院落，留意不同尺度的建筑细节',
  introduction: '这幅原创画面组合了本地照片里的龙华塔、寺院屋檐与庭院香炉。三个主题可分别点开；画中的相对位置不构成实际游览路线。',
  evidenceNote: '本场景依据已收录的龙华寺塔与庭院照片绘制，是不同视角的艺术组合，不是实景照片、寺院平面图或礼佛路线。当前开放区域、参观和礼佛规则以现场公告为准。',
  arrival: {
    lat: 31.177080, lng: 121.447249, radiusMeters: 90,
    source: '高德地点目录 GCJ02 坐标转 WGS84（寺院中心候选范围，未核实入口范围）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'pagoda-eaves', story: '从塔顶往下看，层层屋檐重复、收分，再轻轻向外挑起。把视线放慢，就能读到它轮廓中的节奏。', title: '层层塔檐', anchor: { x: 27, y: 45 },
      summary: '已收录的龙华塔照片能看到多层上翘的塔檐与塔刹轮廓。',
      detail: '可以从塔顶往下看每层屋檐的重复与收分。插画只保留照片可见的轮廓，不表示塔身层数的测绘结果，也不表示塔内对游客开放。',
      evidence: '龙华寺塔本地照片（Drew Lietzow，公有领域）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'hall-roof', story: '沿着深色瓦面追到檐角，看看曲线怎样把目光引向庭院。光落在瓦与木构上，细节比远看时丰富得多。', title: '殿堂屋檐', anchor: { x: 75, y: 55 },
      summary: '已收录的庭院照片中，殿堂的深色瓦面和弯起的檐角十分醒目。',
      detail: '沿着屋脊和檐角看过去，可以体会建筑把视线引向庭院的方式。画面没有标定这是哪一座殿，也不能据此判断今天的入口、排队方向或殿内开放范围。',
      evidence: '龙华寺建筑与庭院本地照片（Jakub Hałun，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'incense-vessel', story: '先看香炉的轮廓，再看金属表面的纹样。它在画面中留下沉稳的分量；现场观看与拍照请尊重寺院指示。', title: '庭院香炉', anchor: { x: 51, y: 76 },
      summary: '已收录的庭院照片中，可以辨认出一座体量醒目的金属香炉。',
      detail: '不妨观察香炉的轮廓与它在庭院中的视觉分量。插画不表达实际摆放位置；是否可近距离观看、拍照或参与任何活动，都以现场指示为准。',
      evidence: '龙华寺建筑与庭院本地照片（Jakub Hałun，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
  ],
};

const guilinParkScene: PlaceScene = {
  id: 'guilin-park',
  placeName: '桂林公园',
  version: 2,
  artwork: '/images/places/scene/guilin-park-v2.jpg',
  soundTheme: 'garden',
  stageCaption: '从一扇圆门，走进园林',
  startQuestion: '想先看圆门、竹影，还是游廊？',
  subtitle: '留意园林如何把门、竹与廊连成不同视角',
  introduction: '这幅原创场景依据已收录的桂林公园竹林门景和木构游廊照片绘制。点开圆门、竹影或游廊，看看园林里的框景与停留空间。',
  evidenceNote: '插画把两张不同时刻、不同视角的公园照片组合在一起，不表示圆门与游廊的真实相邻关系、现在的植被状态或可通行路线。开放区域请以现场为准。',
  arrival: {
    lat: 31.167189, lng: 121.413286, radiusMeters: 90,
    source: '高德地点目录 GCJ02 坐标转 WGS84（公园中心候选范围，未核实园内分区边界）', checkedAt: '2026-09-30',
  },
  hotspots: [
    {
      id: 'moon-gate', story: '门洞把一片园景框进眼前。留意墙、门边与门内景物的层次，往前走一点，视框里的景色就会换一种关系。', title: '月洞门', anchor: { x: 48, y: 53 },
      summary: '已收录的竹林门景照片中，白墙上开着圆形门洞。',
      detail: '圆门把门外的竹影与门内的景物放进同一视框，走近时可以留意这一层层视线。插画只表现照片可见的形状，不标定它通向哪一处分区，也不保证当前可穿行。',
      evidence: '桂林公园竹林门景本地照片（Szalai.laci，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'bamboo-frame', story: '竹叶把阳光筛成细碎的影子。看看叶片、白墙与门景之间的明暗对照，这是园林里很适合慢慢观察的一笔。', title: '竹影', anchor: { x: 24, y: 43 },
      summary: '竹林门景照片里的竹枝从画面左上方垂下，与白墙形成明暗对比。',
      detail: '不妨看看竹叶如何遮出一部分门景，让视线集中到圆门。画中的竹量和位置是艺术处理，季节、修剪与实际视角会改变现场效果。',
      evidence: '桂林公园竹林门景本地照片（Szalai.laci，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
    {
      id: 'covered-walk', story: '看一眼木柱，再沿着栏杆望过去。游廊把行走与停留放在一起，木构的重复让视线有了柔和的节奏。', title: '木构游廊', anchor: { x: 78, y: 59 },
      summary: '另一张本地照片展示了深色木柱、屋顶、栏杆和廊内坐席。',
      detail: '沿木柱与栏杆望过去，游廊把相邻景物分成一格格视野。照片只能证明拍摄时有这些结构，不保证今天有空座、某段走廊开放，或画中的游廊与圆门实际相连。',
      evidence: '桂林公园亭台本地照片（Szalai.laci，CC BY-SA 4.0）', checkedAt: '2026-09-30',
      mapLabel: '查看场地总览',
    },
  ],
};

const westbundMuseumScene: PlaceScene = {
  id: 'westbund-museum',
  placeName: '西岸美术馆',
  version: 1,
  artwork: '/images/places/scene/westbund-museum-v1.jpg',
  soundTheme: 'gallery',
  stageCaption: '先看建筑，再慢慢靠近艺术',
  startQuestion: '想先看立面格线、方正转角，还是广场树影？',
  subtitle: '从格线、光影与转角，看一座美术馆的外观',
  introduction: '这幅原创场景依据已收录的西岸美术馆建筑外观照片绘制。直接点画中的立面、转角或广场树影，看看建筑与光线如何相互映衬。',
  evidenceNote: '插画以本地外观照片为参考，光照、植被与前景经过艺术处理，不代表实时实景、实测布局或参观路线。照片中的旧展览海报未用于介绍当前展览；画面不说明入口、室内展品或今天的开放范围。',
  arrival: {
    lat: 31.171541, lng: 121.454705, radiusMeters: 75,
    source: '高德地点目录 GCJ02 坐标转 WGS84（美术馆附近候选范围，未核实场地及入口边界）', checkedAt: '2026-10-01',
  },
  hotspots: [
    {
      id: 'facade-grid', title: '立面格线', anchor: { x: 62, y: 33 },
      story: '先沿着浅色立面的格线看一眼。横线与竖线把大墙面分成许多小块，树影又在整齐的格子上留下柔和的变化。试着找找，哪一块最明亮？',
      summary: '本地外观照片可见浅色板面与连续的横竖格线。',
      detail: '格线让大体量的墙面有了可辨认的尺度。可以观察接缝、板面和树影之间的节奏；这里描述的是照片可见的外观，不据此推断室内展厅、实际板材成分或当前展览。',
      evidence: '西岸美术馆建筑外观本地照片（Lcsun，CC BY-SA 4.0）；2026-10-01 核对本地素材，非现场核验', checkedAt: '2026-10-01',
      mapLabel: '查看场地总览',
    },
    {
      id: 'square-corner', title: '方正转角', anchor: { x: 74, y: 31 },
      story: '顺着两面墙的交界向上看。转角把正面与侧面接起来，同一套格线随着透视改变方向。站在不同位置看，建筑会显得更宽，或更有纵深。',
      summary: '外观照片里的直角边缘清楚地区分正面与向右延伸的侧面。',
      detail: '留意转角两侧格线的方向，比较近处与远处板面的视觉大小。这是一种看建筑的方式，不是绕行指引；插画不能证明侧面可通行，也不定位参观入口。',
      evidence: '西岸美术馆建筑外观本地照片（Lcsun，CC BY-SA 4.0）；2026-10-01 核对本地素材，非现场核验', checkedAt: '2026-10-01',
      mapLabel: '查看场地总览',
    },
    {
      id: 'plaza-shadows', title: '广场树影', anchor: { x: 25, y: 87 },
      story: '把视线从墙面移到脚边的树影。枝叶、方形树池与铺地线条，把建筑前的空间变得有层次。慢慢看一会儿，光线也是这幅风景的一部分。',
      summary: '外观照片前景有树木、方形树池、低矮座凳和浅色铺地。',
      detail: '比较树影的细碎轮廓和树池、座凳的直线，看看自然形状与建筑线条如何相互衬托。画中的光照和植被是艺术处理，不保证现场有同样的阴影、空座或可停留区域。',
      evidence: '西岸美术馆建筑外观本地照片（Lcsun，CC BY-SA 4.0）；2026-10-01 核对本地素材，非现场核验', checkedAt: '2026-10-01',
      mapLabel: '查看场地总览',
    },
  ],
};

const curatedScenes: PlaceScene[] = [
  naturalHistoryScene, wukangScene, xujiahuiLibraryScene, xujiahuiParkScene, longhuaTempleScene, guilinParkScene, westbundMuseumScene,
];
const scenesByName = new Map(curatedScenes.map(scene => [scene.placeName, scene]));
export const SCENE_PLACE_NAMES = Object.freeze(curatedScenes.map(scene => scene.placeName));

export function sceneForPlaceName(name: string): PlaceScene | null {
  const canonical = name.trim();
  if (/^上海自然博物馆(?:[（(]静安馆[）)])?$/.test(canonical)) return naturalHistoryScene;
  if (/^(?:徐家汇书院|上海市徐汇区图书馆[（(]徐家汇书院[）)])$/.test(canonical)) return xujiahuiLibraryScene;
  return scenesByName.get(canonical) || null;
}

export function sceneHotspot(scene: PlaceScene, id: string): PlaceSceneHotspot | null {
  return scene.hotspots.find(item => item.id === id) || null;
}

/** A narrow relevance gate for short model additions, never a factual verifier. */
export function sceneNarrationRelevant(scene: PlaceScene, hotspot: PlaceSceneHotspot | null, text: string): boolean {
  const message = text.trim();
  if (!message) return false;
  const otherScenes = curatedScenes.filter(item => item.id !== scene.id);
  if (otherScenes.some(item => [item.placeName, ...item.hotspots.map(point => point.title)]
    .some(term => term.length >= 4 && message.includes(term)))) return false;
  const subjects = hotspot ? [hotspot.title] : [scene.placeName, ...scene.hotspots.map(point => point.title)];
  return subjects.some(subject => {
    const characters = [...subject].filter(character => /[\u3400-\u9fff]/u.test(character));
    return characters.some((character, index) => index + 1 < characters.length && message.includes(character + characters[index + 1]));
  });
}
