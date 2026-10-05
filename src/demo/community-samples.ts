/**
 * 社区样例内容（仅帖子）。
 *
 * 目的：新部署打开社区就有可逛的内容，演示帖子的点赞与评论互动。
 * 样例地点不再注入：地点目录必须保持独一无二，（样例）地点曾以「已收录」身份
 * 进入官方目录造成重复，现已全部移除；分享 → 评价 → 收录链路由真实用户内容演示。
 *
 * 诚实边界：所有样例作者昵称统一带「伴途样例」前缀，内容携带 sample 标记，
 * 样例内容的全局清理由平台审核员执行；清除后不会再次自动生成。
 * 样例经 CommunityService 的常规校验路径写入，与用户发布走同一套规则。
 */
import type { CommunityService, SamplePostSeed } from '../services/community-service.js';
import { DEMO_PLACE_IDS } from './demo-data.js';

// 样例身份：与真实账号体系无关，仅用于区分作者与评价人。
const A = 'sample_author_alan';   // 伴途样例·阿澜
const B = 'sample_author_xiao';   // 伴途样例·小满
const C = 'sample_author_lu';     // 伴途样例·路遥
const V1 = 'sample_visitor_yf';   // 伴途样例·一帆
const V2 = 'sample_visitor_ny';   // 伴途样例·南音
const V3 = 'sample_visitor_sh';   // 伴途样例·山禾
const V4 = 'sample_visitor_tt';   // 伴途样例·陶陶
const V5 = 'sample_visitor_mc';   // 伴途样例·牧辰

const POSTS: SamplePostSeed[] = [
  {
    authorId: A, nickname: '伴途样例·阿澜', minutesAgo: 28 * 60,
    text: '运河一日慢走\n从拱宸桥出发沿河往南，走走停停大半天。中途在桥西直街吃了碗面，又在河边休息亭看了一小时船。不赶时间的话，这条线比西湖边松弛多了。',
    likedBy: [V1, V2, V3],
    comments: [
      { actorId: V2, nickname: '伴途样例·南音', minutesAgo: 20 * 60, text: '问一下，沿线有租充电宝的地方吗？' },
      { actorId: A, nickname: '伴途样例·阿澜', minutesAgo: 18 * 60, text: '桥西直街口就有，放心去。' },
    ],
    placeRef: null,
  },
  {
    authorId: B, nickname: '伴途样例·小满', minutesAgo: 2 * 24 * 60,
    text: '带爸妈的轻松一日\n上午博物馆（有电梯），中午家常菜馆，下午白堤慢走。全程没赶路，爸妈体力刚好。经验：老人们对"坐下来"的需求比景点数量高得多。',
    likedBy: [V4],
    comments: [
      { actorId: V3, nickname: '伴途样例·山禾', minutesAgo: 30 * 60, text: '博物馆需要预约吗？' },
    ],
    placeRef: { placeId: DEMO_PLACE_IDS.xujiahuiLibrary, name: '徐家汇书院' },
  },
  {
    authorId: C, nickname: '伴途样例·路遥', minutesAgo: 22 * 60,
    text: '下雨天的室内路线\n排查了一圈室内去处：城市博物馆 → 茶馆坐下听雨 → 晚饭家常菜馆。原计划的白堤改成隔天早上，反而看到了雾里的湖。',
    likedBy: [V2, V5],
    comments: [],
  },
  {
    authorId: B, nickname: '伴途样例·小满', minutesAgo: 6 * 24 * 60,
    text: '带孩子怎么玩不累\n九溪玩水一小时就够，孩子兴趣最大的其实是溪水和鹅卵石。备一双换洗鞋比多排一个景点强。',
    likedBy: [V1, V3],
    comments: [
      { actorId: V1, nickname: '伴途样例·一帆', minutesAgo: 5 * 24 * 60, text: '同款娃，玩水可以玩一下午。' },
      { actorId: V4, nickname: '伴途样例·陶陶', minutesAgo: 4 * 24 * 60, text: '防蚊液+2。' },
    ],
  },
  {
    authorId: A, nickname: '伴途样例·阿澜', minutesAgo: 10 * 24 * 60,
    text: '日落时分的白堤\n断桥上人多，往孤山方向走两百米就安静下来。日落前十分钟湖面是金色的，值得站着等它。',
    likedBy: [V3, V4, V5],
    comments: [
      { actorId: V5, nickname: '伴途样例·牧辰', minutesAgo: 9 * 24 * 60, text: '收藏了，下周末去。' },
    ],
    placeRef: { placeId: DEMO_PLACE_IDS.wukang, name: '武康大楼' },
  },
  {
    authorId: C, nickname: '伴途样例·路遥', minutesAgo: 3 * 60,
    text: '避开人流的博物馆路线\n不开热门馆，从地方志小馆看起，人少、冷气足、椅子多。看到闭馆音乐响起才走。',
    likedBy: [],
    comments: [],
  },
];

export function seedCommunitySamples(service: CommunityService): void {
  service.seedSamples({ places: [], posts: POSTS });
}
