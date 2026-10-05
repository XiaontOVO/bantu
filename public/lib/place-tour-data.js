import { overviewFor, overviewBuildingRecords, siteMapNameFor } from './place-overview-data.js';
import { floorPlanEvidence } from './place-map-evidence.js';

/**
 * 地点室内楼层数据。完整场地总览在 place-overview-data.js 单独绘制。
 *
 * tourFor(place) 把现场总览中的建筑轮廓与已收录楼层图关联起来；
 * 没有核实室内布局的建筑只显示待绘状态，不生成通用房间布局。
 */

function templeHallFloor(name, focusLabel, note) {
  return { name: '首层', label: `${name} · 单层殿堂空间` };
}

const PLACE_TOURS = Object.freeze({
  '上海博物馆东馆': {
    floorPlanSource: {
      label: '上海博物馆东馆官方导览折页（2025）：B1 至 5F 楼层平面（伴途本地重绘）',
      url: 'https://www.shanghaimuseum.net/mu/upload/202508/e303e216-d767-4bec-bc72-39d26c05f899.pdf',
    },
    buildings: [{ id: 'main', name: '上海博物馆东馆', floors: [
      { name: 'B1', label: '报告厅 · 多功能教室 · 数字影院 · 东入口' },
      { name: '1F', label: '青铜馆 · 大厅 · 第一特展厅 · 雕塑馆' },
      { name: '2F', label: '玉器馆 · 玺印篆刻馆 · 书画馆 · 第二特展厅' },
      { name: '3F', label: '陶瓷馆 · 货币馆 · 陶瓷专题馆 · 古代文明探索宫' },
      { name: '4F', label: '江南造物馆 · 文物保护修复体验馆 · 考古馆' },
      { name: '5F', label: '屋顶花园 · 环形屋面步道' },
    ], floorPlanImages: [
      { floor: 'B1', src: '/images/places/floorplan/shanghai-museum-east-b1.svg', restroomsMapped: true, alt: '上海博物馆东馆地下一层 B1 平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘楼层边界、公共走廊与场馆分区；非测绘图，入口以馆方现场指引为准。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
      { floor: '1F', src: '/images/places/floorplan/shanghai-museum-east-1f.svg', restroomsMapped: true, alt: '上海博物馆东馆一层 1F 平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘楼层边界、展厅与公共走廊；展览会调整，非测绘图。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
      { floor: '2F', src: '/images/places/floorplan/shanghai-museum-east-2f.svg', restroomsMapped: true, alt: '上海博物馆东馆二层 2F 平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘楼层边界、展厅与公共走廊；展览会调整，非测绘图。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
      { floor: '3F', src: '/images/places/floorplan/shanghai-museum-east-3f.svg', restroomsMapped: true, alt: '上海博物馆东馆三层 3F 平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘楼层边界、展厅与中央环形空间；互动展区预约状态以馆方为准。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
      { floor: '4F', src: '/images/places/floorplan/shanghai-museum-east-4f.svg', restroomsMapped: true, alt: '上海博物馆东馆四层 4F 平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘楼层边界、展厅与公共走廊；互动展区开放安排以馆方为准。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
      { floor: '5F', src: '/images/places/floorplan/shanghai-museum-east-5f.svg', alt: '上海博物馆东馆五层 5F 屋顶花园平面图', notice: '伴途依据上海博物馆东馆官方导览折页（2025）重绘屋顶花园、平台与上行连接；户外空间，开放状态以馆方为准。', credit: '上海博物馆东馆官方导览折页（2025；伴途重绘）' },
    ] }],
  },
  '上海自然博物馆': {
    floorPlanSource: {
      label: '上海自然博物馆官网楼层导览：L2、L1、B1、B2M、B2（伴途本地重绘）',
      url: 'https://www.snhm.org.cn/cszl/index.htm',
    },
    buildings: [{ id: 'main', name: '上海自然博物馆（绿螺）', floors: [
      { name: 'L2', label: '起源之谜·四维影院' },
      { name: 'L1', label: '生命长河·体验自然' },
      { name: 'B1', label: '演化之道·未来之路' },
      { name: 'B2M', label: '上海故事·1868 咖啡厅' },
      { name: 'B2', label: '探索中心与五大自然主题展区' },
    ], floorPlanImages: [
      { floor: 'L2', src: '/images/places/floorplan/shanghai-natural-history-museum-l2.svg', alt: '上海自然博物馆 L2 楼层平面图', notice: '伴途依据上海自然博物馆官网楼层导览重绘；展区边界和尺寸为方位示意，非测绘图。', credit: '上海自然博物馆官网' },
      { floor: 'L1', src: '/images/places/floorplan/shanghai-natural-history-museum-l1.svg', alt: '上海自然博物馆 L1 楼层平面图', notice: '伴途依据上海自然博物馆官网楼层导览重绘；展区边界和尺寸为方位示意，展陈以现场为准。', credit: '上海自然博物馆官网' },
      { floor: 'B1', src: '/images/places/floorplan/shanghai-natural-history-museum-b1.svg', alt: '上海自然博物馆 B1 楼层平面图', notice: '伴途依据上海自然博物馆官网楼层导览重绘；展区边界和尺寸为方位示意，非测绘图。', credit: '上海自然博物馆官网' },
      { floor: 'B2M', src: '/images/places/floorplan/shanghai-natural-history-museum-b2m.svg', alt: '上海自然博物馆 B2M 楼层平面图', notice: '伴途依据上海自然博物馆官网楼层导览重绘；餐饮服务与展陈开放状态以现场为准。', credit: '上海自然博物馆官网' },
      { floor: 'B2', src: '/images/places/floorplan/shanghai-natural-history-museum-b2.svg', alt: '上海自然博物馆 B2 楼层平面图', notice: '伴途依据上海自然博物馆官网楼层导览重绘；展区边界和尺寸为方位示意，非测绘图。', credit: '上海自然博物馆官网' },
    ] }],
  },
  '上海儿童博物馆': {
    floorPlanSource: {
      label: '上海儿童博物馆官网 1F、2F、3F、B1 彩色平面图（伴途重绘）',
      url: 'https://www.shetbwg.cn/mobile/p-progress_zqgk.html',
    },
    buildings: [{ id: 'main', name: '上海儿童博物馆主展馆', floors: [
      { name: '1F', label: '序厅、进入船舱、潜入深海、天文厅' },
      { name: '2F', label: '太空旅行、返回地球、旅行@家、草婴书屋' },
      { name: '3F', label: '特展区、贵宾室、办公区' },
      { name: 'B1', label: '挖挖乐园、主题活动教室、“读书乐”陈列室' },
    ], floorPlanImages: [
      { floor: '1F', src: '/images/places/floorplan/shanghai-children-museum-1f.svg', restroomsMapped: true, alt: '上海儿童博物馆一层平面图', notice: '伴途依据上海儿童博物馆官网一层彩色平面图重绘；展项与开放区域可能调整，图面非测绘比例。' },
      { floor: '2F', src: '/images/places/floorplan/shanghai-children-museum-2f.svg', restroomsMapped: true, alt: '上海儿童博物馆二层平面图', notice: '伴途依据上海儿童博物馆官网二层彩色平面图重绘；展项与开放区域可能调整，图面非测绘比例。' },
      { floor: '3F', src: '/images/places/floorplan/shanghai-children-museum-3f.svg', restroomsMapped: true, alt: '上海儿童博物馆三层平面图', notice: '伴途依据上海儿童博物馆官网三层彩色平面图重绘；官网未标注用途的区域仅保留轮廓，不推断房间功能；图面非测绘比例。' },
      { floor: 'B1', src: '/images/places/floorplan/shanghai-children-museum-b1.svg', restroomsMapped: true, alt: '上海儿童博物馆地下一层平面图', notice: '伴途依据上海儿童博物馆官网地下一层平面图重绘；活动安排与开放区域以现场为准，图面非测绘比例。' },
    ] }],
  },
  '武康大楼': {
    visitContext: 'exterior',
    buildings: [
      { id: 'main', name: '武康大楼主楼', spaceKind: 'exterior', floors: [], floorPlanImages: [],
        visitNote: '当前提供建筑外观与周边布局资料。没有已核实的公众室内参观平面资料，不提供室内参观路线。' },
    ],
  },
  '徐家汇书院': {
    floorPlanSource: { label: 'Wutopia Lab 项目页 1–3 层设计平面图；上海市文旅局公开 B1 功能资料', url: 'https://lingganlb.com/index/index/detail.html?code=A7807715241451234693' },



    buildings: [
      { id: 'main', name: '徐家汇书院', floors: [
        { name: 'B1', label: '书库与活动区' },
        { name: '1F', label: '入口门厅·儿童阅览·咖啡茶饮' },
        { name: '2F', label: '阅览空间·自习室·电子阅览' },
        { name: '3F', label: '期刊阅览·珍贵文献阅读·报告厅' },
      ], floorPlanImages: [
        { floor: 'B1', kind: 'area-diagram', src: '/images/places/floorplan/xujiahui-library-b1.svg', alt: '徐家汇书院 B1 功能组成示意图', notice: '依据上海市文旅局公开资料绘制：B1 含「东西公园」文创展售空间与智能书库。公开资料未提供可核验的 B1 建筑平面，本图只说明功能组成，不表示房间边界、相对位置或通行路线；智能书库为非公众区域。', credit: '上海市文化和旅游局公开资料（功能信息；伴途本地绘制）' },
        { floor: '1F', src: '/images/places/floorplan/xujiahui-library-1f.svg', restroomsMapped: true, alt: '徐家汇书院一层平面图', notice: '伴途依据 Wutopia Lab 公布的项目设计平面图重绘，标出门厅、儿童阅览、中庭、展示与咖啡区域；运营展陈可能调整，非测绘比例。' },
        { floor: '2F', src: '/images/places/floorplan/xujiahui-library-2f.svg', restroomsMapped: true, alt: '徐家汇书院二层平面图', notice: '伴途依据 Wutopia Lab 公布的项目设计平面图重绘，标出阅览、自习、展示与电子阅览区域；运营展陈可能调整，非测绘比例。' },
        { floor: '3F', src: '/images/places/floorplan/xujiahui-library-3f.svg', restroomsMapped: true, alt: '徐家汇书院三层平面图', notice: '伴途依据 Wutopia Lab 公布的项目设计平面图重绘，标出期刊阅览、珍贵文献阅读、展示、休息与报告厅；运营展陈可能调整，非测绘比例。' },
      ] },
    ],
  },
  '上海图书馆': {
    floorPlanSource: { label: '上海图书馆淮海路馆官方楼层图（1F–3F）', url: 'https://www.library.sh.cn/guide/floor' },



    buildings: [
      { id: 'main', name: '上海图书馆淮海路馆', floors: [
        { name: '1F', label: '综合阅览·目录大厅·参考与典藏' },
        { name: '2F', label: '科技图书·报刊·社科阅览' },
        { name: '3F', label: '中外文期刊·名人手稿·特藏' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/shanghai-library-1f.svg', restroomsMapped: true, alt: '上海图书馆淮海路馆一层自绘平面图', notice: '伴途依据上海图书馆官方淮海路馆一层导览图重绘；保留主要轮廓、功能分区及出口位置，非测绘图。' },
        { floor: '2F', src: '/images/places/floorplan/shanghai-library-2f.svg', restroomsMapped: true, alt: '上海图书馆淮海路馆二层自绘平面图', notice: '伴途依据上海图书馆官方淮海路馆二层导览图重绘；保留主要轮廓、功能分区及出口位置，非测绘图。' },
        { floor: '3F', src: '/images/places/floorplan/shanghai-library-3f.svg', restroomsMapped: true, alt: '上海图书馆淮海路馆三层自绘平面图', notice: '伴途依据上海图书馆官方淮海路馆三层导览图重绘；保留主要轮廓、功能分区及出口位置，非测绘图。' },
      ] },
    ],
  },
  '徐家汇藏书楼': {
    floorPlanSource: { label: '徐家汇藏书楼最新开放公告（上海图书馆）', url: 'https://www.library.sh.cn/article/93158' },



    buildings: [{ id: 'main', name: '徐家汇藏书楼', floors: [
      { name: '1F', label: '全年开放的公众展厅' },
    ] }],
  },
  '龙华寺': {
    floorPlanSource: { label: '打开龙华寺 2026 春节敬香路线图（节庆流线参考）', url: 'https://imgbdb4.bendibao.com/shbdb/tour/20262/13/2026213141117_83074.png' },



    buildings: [
      { id: 'shanmen', name: '山门', floors: [{ name: '首层', label: '门楼与通行门洞' }] },
      { id: 'mile', name: '弥勒殿', floors: [templeHallFloor('弥勒殿', '弥勒佛龛', '依据龙华寺公开殿堂序列绘制中轴殿堂及弥勒佛龛。')] },
      { id: 'heaven', name: '天王殿', floors: [templeHallFloor('天王殿', '天王像', '依据龙华寺公开殿堂序列与殿名绘制礼佛空间及天王像位置。')] },
      { id: 'daxiong', name: '大雄宝殿', floors: [templeHallFloor('大雄宝殿', '主尊佛龛', '依据龙华寺公开殿堂序列绘制中轴主殿与佛龛关系。')] },
      { id: 'sansheng', name: '三圣殿', floors: [templeHallFloor('三圣殿', '三圣佛龛', '依据龙华寺公开殿堂序列绘制后殿礼佛空间。')] },
    ],
  },
  '西岸美术馆': {
    floorPlanSource: { label: 'David Chipperfield Architects 公开设计平面（伴途本地重绘）', url: 'https://davidchipperfield.com/projects/west-bund-museum' },
    floorPlanSources: [{ label: '项目设计图集：首层、二层与地下层平面', url: 'https://cdn.archilovers.com/projects/afba78e3-f80c-4db0-95eb-eebd47a1a99b.pdf' }],



    buildings: [
      { id: 'main', name: '西岸美术馆', floors: [
        { name: 'B1', label: '展厅 4 · 盒子展厅 · 多功能厅 · 餐厅' },
        { name: '1F', label: '中央大厅 · 咖啡 · 书店 · 项目空间（展厅 0）' },
        { name: '2F', label: '展厅 1 · 展厅 2 · 展厅 3 · 酒吧' },
      ], floorPlanImages: [
        { floor: 'B1', src: '/images/places/floorplan/west-bund-museum-b1.svg', alt: '西岸美术馆 B1 地下一层室内平面图', notice: '伴途依据 David Chipperfield Architects 项目设计平面重绘；房间尺寸非测绘值，地下功能和开放状态以馆方现场信息为准。', credit: '© David Chipperfield Architects（伴途重绘）' },
        { floor: '1F', src: '/images/places/floorplan/west-bund-museum-1f.svg', alt: '西岸美术馆 1F 首层室内平面图', notice: '伴途依据 David Chipperfield Architects 项目设计平面重绘；入口和公共设施按设计图表达，具体开放状态以馆方为准。', credit: '© David Chipperfield Architects（伴途重绘）' },
        { floor: '2F', src: '/images/places/floorplan/west-bund-museum-2f.svg', alt: '西岸美术馆 2F 二层室内平面图', notice: '伴途依据 David Chipperfield Architects 项目设计平面重绘；展墙、展陈与房间尺寸非测绘值，以现场为准。', credit: '© David Chipperfield Architects（伴途重绘）' },
      ] },
    ],
  },
  '徐家汇公园': {
    floorPlanSource: { label: '打开 2024 徐家汇公园导览图（含公厕标识）', url: 'https://imagecloud.thepaper.cn/thepaper/image/304/130/899.png' },



    buildings: [],
  },
  '桂林公园': {
    floorPlanSource: { label: '打开 2026 桂林公园导览图', url: 'https://www.xuhui.gov.cn/xwzx_bmlf/20260723/575348/65ca317459944c598212980f3aa6471c.jpg' },



    buildings: [
      { id: 'main', name: '九曲长廊', spaceKind:'outdoor', floors: [{ name: '游廊平面', label: '室外连廊与折转廊道' }] },
      { id: 'pavilion', name: '湖心亭', spaceKind:'outdoor', floors: [{ name: '开放平面', label: '湖中亭榭与开放亭内空间' }] },
      { id: 'teahouse', name: '茶室', floors: [{ name: '首层', label: '茶室公共空间' }] },
    ],
  },
  '宋庆龄故居纪念馆': {
    floorPlanSource: { label: '故居官方 VR 在线讲解', url: 'https://www.shsoong-chingling.com/list-exhibition.html' },



    buildings: [{ id: 'main', name: '故居主楼', floors: [
      { name: '1F', label: '过道厅 · 客厅 · 餐厅 · 书房' },
      { name: '2F', label: '卧室与书房' },
    ] }],
  },
  '上海气象博物馆（徐家汇观象台）': {
    floorPlanSource: { label: '打开上海气象博物馆全景导览二维码页（上海文旅）', url: 'https://www.meet-in-shanghai.net/cn/guide/before-you-go-crazy-lets-meet-online-and-feel-the-artistic-atmosphere-without-leaving-home-755550/' },
    floorPlanSources: [{ label: '查看徐汇区政府 2021 年展陈楼层介绍（非平面图）', url: 'https://www.xuhui.gov.cn/xwzx_bmlf/20210915/293115.html' }],



    buildings: [{ id: 'main', name: '上海气象博物馆', floors: [
      { name: '2F', label: '实物展陈为主；含历史轴线与南、东、西侧展厅（2021 年资料）' },
      { name: '3F', label: '数字媒体与互动体验较多（2021 年资料）' },
    ] }],
  },
  '上海电影博物馆': {
    floorPlanSource: { label: 'COORDINATION ASIA 项目楼层导览（1F–4F；伴途本地重绘）', url: 'https://coordination.asia/completion-shanghai-film-museum/' },
    buildings: [{ id: 'main', name: '上海电影博物馆', floors: [
      { name: '1F', label: '荣誉与经典片场·艺术影厅·五号摄影棚' },
      { name: '2F', label: '电影工场·录音、后期、动画与演播空间' },
      { name: '3F', label: '影史长河·主题展区围绕中部交通核心展开' },
      { name: '4F', label: '光影记忆·U 形展廊围绕中央挑空分布' },
    ], floorPlanImages: [
      { floor: '1F', src: '/images/places/floorplan/shanghai-film-museum-1f.svg', restroomsMapped: true, alt: '上海电影博物馆一层楼层平面图', notice: '伴途依据 COORDINATION ASIA 发布的项目楼层导览重绘；展陈会调整，非测绘比例。', credit: 'COORDINATION ASIA' },
      { floor: '2F', src: '/images/places/floorplan/shanghai-film-museum-2f.svg', restroomsMapped: true, alt: '上海电影博物馆二层楼层平面图', notice: '伴途依据 COORDINATION ASIA 发布的项目楼层导览重绘；保留中部挑空与主要展区相邻关系，非测绘比例。', credit: 'COORDINATION ASIA' },
      { floor: '3F', src: '/images/places/floorplan/shanghai-film-museum-3f.svg', restroomsMapped: true, alt: '上海电影博物馆三层楼层平面图', notice: '伴途依据 COORDINATION ASIA 发布的项目楼层导览重绘；展陈会调整，非测绘比例。', credit: 'COORDINATION ASIA' },
      { floor: '4F', src: '/images/places/floorplan/shanghai-film-museum-4f.svg', restroomsMapped: true, alt: '上海电影博物馆四层楼层平面图', notice: '伴途依据 COORDINATION ASIA 发布的项目楼层导览重绘；保留 U 形展廊与中央挑空关系，非测绘比例。', credit: 'COORDINATION ASIA' },
    ] }],
  },
  '龙美术馆（西岸馆）': {
    floorPlanSource: { label: '大舍建筑公开楼层平面（ArchDaily 项目页；伴途本地重绘）', url: 'https://www.archdaily.cn/cn/778009/long-mei-zhu-guan-xi-an-guan-da-she-jian-zhu/54336ce9c07a80cbe80000e7-long-museum-west-bund-atelier-deshaus-floor-plan' },
    buildings: [{ id: 'main', name: '龙美术馆（西岸馆）', floors: [
      { name: 'B1', label: '1–5 号展厅 · 中央走廊 · 旧码头停车区' },
      { name: '1F', label: '入口大厅 · 展厅 · 商店 · 煤斗连桥' },
      { name: '2F', label: '展厅与挑空 · 中庭 · 多功能厅 · 煤斗连桥' },
    ], floorPlanImages: [
      { floor: 'B1', src: '/images/places/floorplan/long-museum-west-bund-b1.svg', alt: '龙美术馆西岸馆 B1 地下一层室内平面图', notice: '伴途依据大舍建筑公开楼层平面重绘主要边界、展厅和交通空间；非现状测绘图，开放区域以馆内指引为准。', credit: '大舍建筑（建筑平面；伴途重绘）' },
      { floor: '1F', src: '/images/places/floorplan/long-museum-west-bund-1f.svg', alt: '龙美术馆西岸馆 1F 首层室内平面图', notice: '伴途依据大舍建筑公开楼层平面重绘主要边界、展厅、中庭和煤斗连桥；非现状测绘图，展陈及开放区域以馆内指引为准。', credit: '大舍建筑（建筑平面；伴途重绘）' },
      { floor: '2F', src: '/images/places/floorplan/long-museum-west-bund-2f.svg', alt: '龙美术馆西岸馆 2F 二层室内平面图', notice: '伴途依据大舍建筑公开楼层平面重绘主要边界、挑空、庭院和连桥；非现状测绘图，展陈及开放区域以馆内指引为准。', credit: '大舍建筑（建筑平面；伴途重绘）' },
    ] }],
  },
  '上海公安博物馆': {
    floorPlanSource: { label: '上海公安博物馆线上 VR 导览楼层坐标（伴途据此重绘）', url: 'https://presentation.realsee.cn/museum/REQQN65y?autoplay=0' },



    buildings: [{ id: 'main', name: '上海公安博物馆', floors: [
      { name: '1F', label: '大厅与主入口' },
      { name: '2F', label: '序馆·公安史馆·英雄烈士馆' },
      { name: '3F', label: '刑事侦查·治安·交通·监所管理' },
      { name: '4F', label: '消防管理·警务交流·警用装备' },
    ], floorPlanImages: [
      { floor: '1F', src: '/images/places/floorplan/shanghai-police-museum-1f.svg', alt: '上海公安博物馆一层轮廓示意图', notice: '伴途根据公开 VR 导览房间坐标自绘，展示导览记录中的楼层轮廓与主入口位置；请以馆内标识为准。' },
      { floor: '2F', src: '/images/places/floorplan/shanghai-police-museum-2f.svg', restroomsMapped: true, alt: '上海公安博物馆二层展厅平面图', notice: '伴途根据公开 VR 导览房间坐标自绘，展厅形状和相邻关系对应导览数据；请以馆内标识为准。' },
      { floor: '3F', src: '/images/places/floorplan/shanghai-police-museum-3f.svg', alt: '上海公安博物馆三层展厅平面图', notice: '伴途根据公开 VR 导览房间坐标自绘，展厅形状和相邻关系对应导览数据；请以馆内标识为准。' },
      { floor: '4F', src: '/images/places/floorplan/shanghai-police-museum-4f.svg', restroomsMapped: true, alt: '上海公安博物馆四层展厅平面图', notice: '伴途根据公开 VR 导览房间坐标自绘，展厅形状和相邻关系对应导览数据；请以馆内标识为准。' },
    ] }],
  },
  '上海摄影艺术中心': {
    floorPlanSource: { label: '西岸官方场馆介绍（6 个半椭圆展厅、三角庭院与约 90 米展线；未公开测绘平面）', url: 'https://www.westbund.com/cn/index/KEY-PROJECTS/detail_bd1E5.html' },
    floorPlanSources: [{ label: 'Johnston Marklee 建筑师项目介绍（六个体量、庭院与入口关系；伴途据此重绘空间关系图）', url: 'https://www.johnstonmarklee.com/work/pavilion-of-six-views' }],



    buildings: [{ id: 'main', name: '上海摄影艺术中心', floors: [
      { name: '馆内', label: '单层；三间内向展厅围绕三角庭院，另三间朝外；入口位于弧形体量交接处' },
    ], floorPlanImages: [
      { floor: '馆内', src: '/images/places/floorplan/shanghai-center-of-photography-1f.svg', alt: '上海摄影艺术中心六个曲面展厅与三角形庭院平面图', notice: '伴途依据 Johnston Marklee 建筑师与西岸官方公开的空间关系本地重绘；展示六个椭圆体量、玻璃庭院与设计连接点，非测绘图，临展墙和当前开放入口未标示。', credit: 'Johnston Marklee（建筑空间关系；伴途本地重绘）' },
    ] }],
  },
  '星美术馆': {
    floorPlanSource: { label: 'Ateliers Jean Nouvel 设计发展图：首层与平台层平面（谷德转载；设计阶段资料）', url: 'https://www.gooood.cn/start-museum-shanghai-by-ateliers-jean-nouvel.htm' },
    floorPlanSources: [{ label: '星美术馆官方建筑介绍：夹层常设展与屋顶平台功能核对', url: 'https://www.startmuseum.com/zh/about-us/building-and-history/' }],
    buildings: [{ id: 'main', name: '星美术馆', floors: [
      { name: '1F', label: '首层展览空间与公共配套' },
      { name: '夹层', label: '约 300㎡ 常设展空间；尚无可核验的夹层平面图' },
      { name: '屋顶', label: '户外艺术展示平台' },
    ], floorPlanImages: [
      { floor: '1F', src: '/images/places/floorplan/start-museum-1f.svg', alt: '星美术馆首层平面图', notice: '伴途依据 Ateliers Jean Nouvel 2022 年设计发展版首层平面重绘；不是当前游客导览或测绘图，展陈与开放区域以场馆现场为准。', credit: 'Ateliers Jean Nouvel · Ground Floor Plan（2022 设计发展图）· 伴途本地重绘' },
      { floor: '屋顶', src: '/images/places/floorplan/start-museum-roof.svg', alt: '星美术馆屋顶平台平面图', notice: '伴途依据 Ateliers Jean Nouvel 2022 年设计发展版平台层平面重绘；屋顶艺术作品和开放范围会调整，以场馆现场为准。', credit: 'Ateliers Jean Nouvel · Platform Floor Plan（2022 设计发展图）· 伴途本地重绘' },
    ] }],
  },
  '巴金故居': {
    floorPlanSource: { label: '最新开放状态：修缮期间暂停开放（虹口区政府）', url: 'https://www.shhk.gov.cn/xwzx/002014/20260924/3f7b905c-2934-443f-985b-e3a30cf61af8.html' },



    buildings: [{ id: 'main', name: '巴金故居主楼', floors: [
      { name: '1F', label: '门厅 · 客厅 · 餐厅 · 太阳间' },
      { name: '2F', label: '书房 · 卧室 · 起居空间' },
    ] }],
  },
  '土山湾博物馆': {
    floorPlanSource: { label: '上海文旅：土山湾博物馆全景导览二维码与基本陈列资料', url: 'https://www.meet-in-shanghai.net/jpn/museums/shanghai-tushanwan-museum-659458/' },
    buildings: [
      { id: 'main', name: '土山湾博物馆旧址展厅', floors: [{ name: '1F', label: '土山湾旧址红楼底层展厅' }] },
      { id: 'glass-hall', name: '幕墙玻璃展厅', floors: [{ name: '展厅层', label: '玻璃展厅与牌楼展示空间' }] },
    ],
  },
  '徐汇艺术馆': {
    buildings: [{ id: 'main', name: '徐汇艺术馆', floors: [{ name: '开放展厅层', label: '展厅 · 多功能报告厅 · 艺术沙龙' }] }],
  },
  '西岸梦中心': {
    floorPlanSource: { label: 'MVRDV 西岸梦中心场地及 M Factory、筒仓设计平面（伴途本地重绘）', url: 'https://www.mvrdv.com/projects/847/gate-m-west-bund-dream-center' },
    buildings: [
      { id: 'factory', name: '梦工场（M Factory）', floors: [
        { name: '1F', label: 'BLOOMARKET 市集 · 大跨公共空间' },
        { name: '2F', label: '大跨文化空间 · 两处挑空' },
        { name: '3F', label: '连续大跨空间 · 南侧交通带' },
        { name: '4F', label: '大跨空间上部挑空 · 连廊' },
        { name: '屋顶', label: '采光天窗阵列 · 附属屋面' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/west-bund-dream-m-factory-1f.svg', alt: '西岸梦中心 M Factory 一层平面图', notice: '伴途依据 MVRDV 公开设计平面重绘主要墙体、服务带和附属空间；非现状测绘图，营业和开放范围以现场为准。', credit: 'MVRDV（设计平面；伴途重绘）' },
        { floor: '2F', src: '/images/places/floorplan/west-bund-dream-m-factory-2f.svg', alt: '西岸梦中心 M Factory 二层平面图', notice: '伴途依据 MVRDV 公开设计平面重绘大跨空间、挑空和交通核心；非现状测绘图，展演与开放范围以现场为准。', credit: 'MVRDV（设计平面；伴途重绘）' },
        { floor: '3F', src: '/images/places/floorplan/west-bund-dream-m-factory-3f.svg', alt: '西岸梦中心 M Factory 三层平面图', notice: '伴途依据 MVRDV 公开设计平面重绘主要楼层轮廓、服务用房和南侧交通带；非测绘图，用途未明确处仅保留轮廓。', credit: 'MVRDV（设计平面；伴途重绘）' },
        { floor: '4F', src: '/images/places/floorplan/west-bund-dream-m-factory-4f.svg', alt: '西岸梦中心 M Factory 四层平面图', notice: '伴途依据 MVRDV 公开设计平面重绘挑空、交通核心和连廊；挑空不是可通行楼面，开放区域以现场为准。', credit: 'MVRDV（设计平面；伴途重绘）' },
        { floor: '屋顶', src: '/images/places/floorplan/west-bund-dream-m-factory-roof.svg', alt: '西岸梦中心 M Factory 屋顶平面图', notice: '伴途依据 MVRDV 公开屋顶平面重绘天窗阵列和附属屋面；设计屋面图不代表游客可进入，开放状态以现场为准。', credit: 'MVRDV（屋顶设计平面；伴途重绘）' },
      ] },
      { id: 'silo', name: '西岸梦中心筒仓', floors: [
        { name: '1F–2F', label: '六座筒仓 · 中央核心 · 东侧交通塔' },
        { name: '3F', label: '六座筒仓上部空间 · 玻璃屋顶' },
        { name: '4F', label: '上部连廊 · 屋顶步行桥' },
      ], floorPlanImages: [
        { floor: '1F–2F', src: '/images/places/floorplan/west-bund-dream-silo-1-2f.svg', alt: '西岸梦中心筒仓一层和二层平面图', notice: '伴途依据 MVRDV 公开设计平面重绘六座筒仓、中央核心和东侧交通塔；非测绘图，可进入区域以园区现场安排为准。', credit: 'MVRDV（筒仓设计平面；伴途重绘）' },
        { floor: '3F', src: '/images/places/floorplan/west-bund-dream-silo-3f-glass-roof.svg', alt: '西岸梦中心筒仓三层与玻璃屋顶平面图', notice: '伴途依据 MVRDV 公开设计平面重绘三层和玻璃屋顶关系；屋顶构造图不表示玻璃面可通行，开放状态以现场为准。', credit: 'MVRDV（筒仓设计平面；伴途重绘）' },
        { floor: '4F', src: '/images/places/floorplan/west-bund-dream-silo-4f-roof.svg', alt: '西岸梦中心筒仓四层与屋顶平面图', notice: '伴途依据 MVRDV 公开设计平面重绘上部连廊、筒仓组团和屋顶交通关系；非测绘图，通行状态以现场为准。', credit: 'MVRDV（筒仓设计平面；伴途重绘）' },
      ] },
    ],
  },
  '上海工艺美术博物馆': {
    floorPlanSource: { label: '上海工艺美术博物馆主楼 1F–3F 平面图（2019；伴途本地重绘，非当前导览）', url: 'https://www.sohu.com/a/318394809_538891' },
    buildings: [{ id: 'main', name: '上海工艺美术博物馆', floors: [
      { name: '1F', label: '民间工艺展厅 · 灯彩 · 剪纸 · 休息区' },
      { name: '2F', label: '东西展厅 · 综合展厅 · 雕刻与玉雕' },
      { name: '3F', label: '建筑展示 · 顾绣 · 缂丝 · 戏服 · 砚刻' },
    ], floorPlanImages: [
      { floor: '1F', src: '/images/places/floorplan/shanghai-arts-and-crafts-museum-1f.svg', restroomsMapped: true, alt: '上海工艺美术博物馆一层平面图', notice: '伴途依据 2019 年公开主楼平面图重绘房间边界、楼梯与休息区。该图不是现状测绘，展陈和经营空间可能调整，请以场馆现场为准。', credit: '上海工艺美术博物馆主楼平面图（2019）· 伴途本地重绘' },
      { floor: '2F', src: '/images/places/floorplan/shanghai-arts-and-crafts-museum-2f.svg', alt: '上海工艺美术博物馆二层平面图', notice: '伴途依据 2019 年公开主楼平面图重绘中央综合厅、东西展厅、雕刻与玉雕展厅。该图不是现状测绘，展陈和开放安排以现场为准。', credit: '上海工艺美术博物馆主楼平面图（2019）· 伴途本地重绘' },
      { floor: '3F', src: '/images/places/floorplan/shanghai-arts-and-crafts-museum-3f.svg', alt: '上海工艺美术博物馆三层平面图', notice: '伴途依据 2019 年公开主楼平面图重绘织绣、戏服和砚刻等展区边界。该图不是现状测绘，展陈和工作室使用可能调整，请以场馆现场为准。', credit: '上海工艺美术博物馆主楼平面图（2019）· 伴途本地重绘' },
    ] }],
  },
  '上海体育场': {
    floorPlanSource: { label: '徐汇区政府 2025 年观演指南（看台编号、扶梯与观众入场分区；伴途本地重绘）', url: 'https://www.shanghai.gov.cn/nw17239/20251107/cf20bae9dda642b28dc801cfa8b7a220.html' },
    buildings: [{ id: 'stadium', name: '上海体育场', floors: [
      { name: '观众与比赛层', label: '32 个看台分区 · 7 组观众扶梯 · 场芯活动区' },
    ], floorPlanImages: [
      { floor: '观众与比赛层', src: '/images/places/floorplan/shanghai-stadium-stands.svg', alt: '上海体育场 32 个看台分区、七组扶梯与场芯导引平面图', notice: '伴途依据徐汇区政府 2025 年观演指南重绘看台编号和扶梯位置。入场口、通道开放与活动布置会随场次变化，请以当日现场指引为准。', credit: '徐汇区政府观演指南（2025；伴途本地重绘）' },
    ] }],
  },
  '上海体育馆': {
    floorPlanSource: { label: '徐家汇体育公园官方园区位置与出入口图', url: 'https://www.xuhui.gov.cn/gzfw-shdt/20241212/548672.html' },



    buildings: [{ id: 'gymnasium', name: '上海体育馆', floors: [{ name: '观众与活动层', label: '环形活动看台 · 可变场地' }] }],
  },
  '上海植物园': {
    floorPlanSource: { label: '上海植物园官方游园地图说明', url: 'https://www.shbg.org/sites/zhiwuyuan/InfoContent.aspx?ctgId=3c25f682-3f21-4cb3-994b-ab79489bacae&infoId=bc3ac58b-5775-4cb6-a921-53f179926c2b' },
    floorPlanSources: [{ label: '查看官方展览温室（一、二）导览图（2022）', url: 'https://lhsr.sh.gov.cn/ywdt/20220913/d31fa7be-2cf1-49aa-bf52-2a4974ddd3b0.html' }],



    buildings: [
      { id: 'greenhouse-1', name: '展览温室（一）', floors: [{ name: '一层', label: '热带雨林、室内花园与四类专类植物' }], floorPlanImages: [
        { floor: '一层', src: '/images/places/floorplan/shanghai-botanical-greenhouse-1f.svg', alt: '上海植物园展览温室（一）室内分区平面图', notice: '伴途依据上海市绿化和市容管理局 2022 年专业测绘导览图重绘为本地平面图；非比例图，植物展陈以现场为准。' },
      ] },
      { id: 'greenhouse-2', name: '展览温室（二）', floors: [{ name: '一层', label: '四座温室与连廊组成的主题展区' }], floorPlanImages: [
        { floor: '一层', src: '/images/places/floorplan/shanghai-botanical-greenhouse-2f.svg', alt: '上海植物园展览温室（二）室内分区平面图', notice: '伴途依据上海市绿化和市容管理局 2022 年专业测绘导览图重绘为本地平面图；非比例图，植物展陈以现场为准。' },
      ] },
    ],
  },
  '龙华烈士陵园': {
    floorPlanSource: { label: '龙华烈士陵园官方全景导览', url: 'https://www.slmmm.cn/360/vtourshiwai/index.html' },



    buildings: [{ id: 'main', name: '龙华烈士纪念馆', floors: [
      { name: '1F', label: '序厅与基本陈列前段' },
      { name: '2F', label: '基本陈列后段与尾厅' },
    ] }],
  },
  '油罐艺术中心': {
    floorPlanSource: { label: 'OPEN Architecture 上海油罐艺术中心设计资料（伴途本地重绘）', url: 'https://openarch.com/task/123' },
    buildings: [
      { id: 'tank-1', name: '油罐一号', floors: [
        { name: '1F', label: '双层 Livehouse · 鼓形声学内置体量' },
        { name: '2F', label: 'Livehouse 上层空间' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/tank-shanghai-1-1f.svg', alt: '上海油罐艺术中心一号罐首层平面图', notice: '按 OPEN Architecture 公开设计资料重绘一号罐圆形壳体与鼓形声学内置体量；未公开的隔断、楼梯与当前开放区域不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
        { floor: '2F', src: '/images/places/floorplan/tank-shanghai-1-2f.svg', alt: '上海油罐艺术中心一号罐二层平面图', notice: '按 OPEN Architecture 公开设计资料表达一号罐双层 Livehouse 与内置体量关系；未公开的楼梯、座位和疏散细节不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
      ] },
      { id: 'tank-2', name: '油罐二号', floors: [
        { name: '1F', label: '环绕圆形庭院的餐饮空间' },
        { name: '屋顶', label: '围绕中庭布置的屋顶露台' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/tank-shanghai-2-1f.svg', alt: '上海油罐艺术中心二号罐首层平面图', notice: '按 OPEN Architecture 公开设计资料重绘圆形罐体、中心庭院和环绕庭院的餐饮空间；后勤分区未公开处不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
        { floor: '屋顶', src: '/images/places/floorplan/tank-shanghai-2-roof.svg', alt: '上海油罐艺术中心二号罐屋顶平面图', notice: '按 OPEN Architecture 公开设计资料重绘屋顶露台与中心庭院关系；露台当前开放范围以场馆安排为准。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
      ] },
      { id: 'tank-3', name: '油罐三号', floors: [
        { name: '1F', label: '保留原罐体的穹顶展厅 · 中央可开启天窗' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/tank-shanghai-3-1f.svg', alt: '上海油罐艺术中心三号罐展厅平面图', notice: '按 OPEN Architecture 公开设计资料重绘保留的圆形罐体、中央采光眼和穹顶展览空间；展品位置与入口不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
      ] },
      { id: 'tank-4', name: '油罐四号', floors: [
        { name: '1F', label: '圆罐内置三层立方体画廊 · 一层' },
        { name: '2F', label: '圆罐内置三层立方体画廊 · 二层' },
        { name: '3F', label: '圆罐内置三层立方体画廊 · 三层' },
      ], floorPlanImages: [
        { floor: '1F', src: '/images/places/floorplan/tank-shanghai-4-1f.svg', alt: '上海油罐艺术中心四号罐一层平面图', notice: '按 OPEN Architecture 公开设计资料重绘原圆罐内三层立方体画廊的主要轮廓；展厅隔断与交通核位置未公开处不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
        { floor: '2F', src: '/images/places/floorplan/tank-shanghai-4-2f.svg', alt: '上海油罐艺术中心四号罐二层平面图', notice: '按 OPEN Architecture 公开设计资料重绘原圆罐内三层立方体画廊的主要轮廓；展厅隔断与交通核位置未公开处不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
        { floor: '3F', src: '/images/places/floorplan/tank-shanghai-4-3f.svg', alt: '上海油罐艺术中心四号罐三层平面图', notice: '按 OPEN Architecture 公开设计资料重绘原圆罐内三层立方体画廊的主要轮廓；展厅隔断与交通核位置未公开处不作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
      ] },
      { id: 'tank-5', name: '油罐五号', floors: [
        { name: '首层', label: '贯穿圆罐的展演体量 · 两端室外舞台' },
      ], floorPlanImages: [
        { floor: '首层', src: '/images/places/floorplan/tank-shanghai-5-1f.svg', alt: '上海油罐艺术中心五号罐首层平面图', notice: '按 OPEN Architecture 公开设计资料重绘贯穿罐体的长方形展演体量与两端舞台；具体舞台开合和活动分区未作推断。', credit: 'OPEN Architecture 设计资料 · 伴途本地重绘' },
      ] },
    ],
  },
  '上海交通大学徐汇校区': {
    floorPlanSource: { label: '上海交通大学对老图书馆的建筑与开放资料', url: 'https://news.sjtu.edu.cn/mtjj/20190914/110299.html' },



    buildings: [{ id: 'campus', name: '老图书馆', floors: [
      { name: '1F', label: '校史成果展室与旧阅书空间' },
      { name: '3F', label: '校史博物馆展陈空间' },
    ] }],
  },
  '光启公园': {
    floorPlanSource: { label: '光启公园焕新后的官方游园动线图', url: 'https://finance.sina.com.cn/jjxw/2026-09-04/doc-iniqrpra1486259.shtml' },



    buildings: [
      { id: 'museum', name: '徐光启纪念馆', floors: [{ name: '展厅', label: '南春华堂 · 照壁、厢房与厅堂' }] },
      { id: 'pavilion', name: '六角亭', spaceKind:'outdoor', floors: [{ name: '平面', label: '开放式六角亭，无室内房间' }] },
    ],
  },
});

// Verified online references for places where we do not have a licensed local map.
// Labels describe what the linked page actually contains, not what we wish it contained.
const PLACE_REFERENCE_SOURCES = Object.freeze({
  '土山湾博物馆': {
    label: '上海文旅：土山湾博物馆全景导览二维码（2022）',
    url: 'https://www.meet-in-shanghai.net/cn/news/world-book-day-starts-a-journey-of-light-to-trace-the-source-of-shanghaistyle-culture-639185/',
  },
});

/**
 * 取地点地图与楼层数据。未知地点只会得到待核实状态，不按地点类别猜测地图。
 */
export function tourFor(place) {
  const canonicalName = siteMapNameFor(place);
  const authored = PLACE_TOURS[place?.name] || PLACE_TOURS[canonicalName];
  const overview = overviewFor(place);
  const buildings = [...(authored?.buildings || [])];
  const knownBuildingIds = new Set(buildings.map(building => building.id));
  for (const building of overviewBuildingRecords(overview)) {
    if (!knownBuildingIds.has(building.id)) buildings.push(building);
  }
  return {
    ...(authored || {}),
    overview,
    generated: !authored,
    floorPlanSource: authored?.floorPlanSource || PLACE_REFERENCE_SOURCES[place?.name] || PLACE_REFERENCE_SOURCES[canonicalName] || null,
    buildings: buildings.map(building => ({ ...building,
      floorPlanImages: (building.floorPlanImages || []).map(image => ({ ...image, evidence: floorPlanEvidence(canonicalName, image) })),
    })),
  };
}

/** Resolve zoom provenance from the same authored image record as the floor panel. */
export function floorImageBySrc(src) {
  for (const [name, tour] of Object.entries(PLACE_TOURS)) {
    for (const building of tour.buildings || []) {
      const image = (building.floorPlanImages || []).find(item => item.src === src);
      if (image) return { ...image, evidence: floorPlanEvidence(name, image) };
    }
  }
  return null;
}

/** 建筑平面图：只使用该地点明确收录的楼层和图片，不从类别生成假布局。 */
export function floorPlanFor(place, buildingId, floorIndex) {
  const tour = tourFor(place);
  const building = (tour.buildings || []).find(item => item.id === buildingId);
  if (!building) return null;
  const floors = building.floors || [];
  const floor = floors[Math.max(0, Math.min(floorIndex, floors.length - 1))] || floors[0];
  return { building, floor, floorIndex: floors.indexOf(floor), floorCount: floors.length };
}
