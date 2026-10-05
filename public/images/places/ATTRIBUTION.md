# 地点图片来源与授权

图片保存在项目内的 `public/images/places/`，应用只读取本地文件，不会请求外部图片服务。

## 地点现场原创场景

`scene/shanghai-natural-history.svg` 是伴途绘制的艺术场景，元素文字依据已收录的馆方楼层导览；`scene/wukang-building.svg` 依据本地收录的武康大楼室外照片 `photos/wukang-2.jpg`、`photos/wukang-3.jpg` 与地点资料绘制；`scene/xujiahui-library.svg` 依据本地收录的书院室内照片 `photos/xujiahui-library-2.jpg`、`photos/xujiahui-library-3.jpg` 与楼层资料绘制；`scene/xujiahui-park.svg` 依据本地收录的徐家汇公园烟囱 `photos/xujiahui-park-2.jpg`（Livelikerw，CC BY-SA 3.0）及步道 `photos/xujiahui-park-3.jpg`（Szalai.laci，CC BY-SA 4.0）绘制；`scene/longhua-temple.svg` 依据本地收录的龙华寺庭院 `photos/longhua-2.jpg`（Jakub Hałun，CC BY-SA 4.0）与龙华塔 `photos/longhua-3.jpg`（Drew Lietzow，公有领域）绘制；`scene/guilin-park.svg` 依据本地收录的桂林公园亭台 `photos/guilin-park-2.jpg` 与竹林门景 `photos/guilin-park-3.jpg`（均为 Szalai.laci，CC BY-SA 4.0）绘制。六图均为原创艺术表达，非实景照片、测绘图或室内导航图，不提供入口和通行路线判断；照片来源与授权见下方实拍表。

## 官方自绘地点印象

以下插画用于地点卡片和详情页的地点印象展示，不属于实拍照片，也不显示摄影者署名。

2026-09-29：10 张 `*-ai-2x1.png` 使用内置 image_gen 逐张重绘，原始输出为 1774×887（严格 2:1），包含中文标题、英文地点名称和中文描述。风格参考项目原有武康大楼印象插画；完整提示词与最终路径保存在 `scripts/references/impression-redraw-prompts.json`。摄影艺术中心与星美术馆采用建筑师公开外观照片辅助核对建筑造型（Johnston Marklee / 吕恒中；Ateliers Jean Nouvel / Moment Studio），原照片不作为产品素材。插画中的装饰性背景、色块和透视不表示实地位置或测绘精度。旧 16:9 文件保留为历史稿，产品统一引用重绘版。

| 本地文件 | 地点 |
| --- | --- |
| `guilin-park-1.jpg` | 桂林公园 |
| `longhua-1.jpg` | 龙华寺 |
| `shanghai-library-1.jpg` | 上海图书馆淮海中路馆 |
| `wukang-1.jpg` | 武康大楼 |
| `xujiahui-library-1.jpg` | 徐家汇书院 |
| `xujiahui-park-1.jpg` | 徐家汇公园 |
| `guangqi-park-1.png` | 光启公园 |
| `bibliotheca-zi-ka-wei-1.png` | 徐家汇藏书楼 |
| `meteorological-museum-1.png` | 上海气象博物馆（徐家汇观象台） |
| `soong-ching-ling-1.png` | 宋庆龄故居纪念馆 |
| `shanghaijiaotonguniversity-1.jpg` | 上海交通大学徐汇校区 |
| `film-museum-1.png` | 上海电影博物馆 |
| `public-security-museum-1.png` | 上海公安博物馆 |
| `arts-and-crafts-museum-1.png` | 上海工艺美术博物馆 |
| `xuhui-art-museum-1.png` | 徐汇艺术馆 |
| `ba-jin-residence-1.png` | 巴金故居 |
| `longhua-martyrs-park-ai-2x1.png` | 龙华烈士陵园 |
| `west-bund-museum-impression-1.png` | 西岸美术馆 |
| `long-museum-west-bund-ai-2x1.png` | 龙美术馆（西岸馆） |
| `shanghai-center-of-photography-ai-2x1.png` | 上海摄影艺术中心 |
| `tank-art-center-ai-2x1.png` | 油罐艺术中心 |
| `west-bund-dream-center-ai-2x1.png` | 西岸梦中心 |
| `shanghai-botanical-garden-ai-2x1.png` | 上海植物园 |
| `shanghai-stadium-ai-2x1.png` | 上海体育场 |
| `shanghai-indoor-stadium-ai-2x1.png` | 上海体育馆 |
| `tushanwan-museum-ai-2x1.png` | 土山湾博物馆 |
| `start-museum-ai-2x1.png` | 星美术馆 |

备用稿（未引用）：`shanghaijiaotonguniversity-2.png` 为上海交通大学徐汇校区的另一版印象插画

## 伴途绘制的场地总览与室内平面图

场地总览由 `public/lib/place-overview-data.js` 中的本地矢量数据绘制，详情页不加载外部地图，也不展示外部跳转。收录的室内平面图由伴途本地绘制或使用已授权文件。

| 本地文件 | 用途 |
| --- | --- |
| `wukang-building-1f.svg` | 武康大楼 1F；伴途依据已收录的公众开放区平面资料重新绘制为本地矢量图，产品不加载原图 |
| `ec04e577-6d9b-4923-9c5a-c3badf776257.png` | 武康大楼 1F 平面资料参考文件（产品不加载） |
| `shanghai-children-museum-1f.svg`、`shanghai-children-museum-2f.svg`、`shanghai-children-museum-3f.svg`、`shanghai-children-museum-b1.svg` | 上海儿童博物馆 1F、2F、3F、B1；依据官网公开彩色楼层图重绘为本地矢量图，不加载或跳转到原图 |
| `shanghai-botanical-greenhouse-1f.svg`、`shanghai-botanical-greenhouse-2f.svg` | 上海植物园展览温室（一）、（二）；依据上海市绿化和市容管理局 2022 年专业测绘导览图重绘为本地矢量平面，不加载或跳转到原图 |
| `xujiahui-library-b1.svg` | 徐家汇书院 B1 功能组成示意；依据上海市文化和旅游局公开资料，仅呈现东西公园与智能书库两项已确认功能，不表示房间边界、相对位置或通行路线 |
| `xujiahui-library-1f.svg`、`xujiahui-library-2f.svg`、`xujiahui-library-3f.svg` | 徐家汇书院 1F–3F；依据 Wutopia Lab 公布的项目设计平面重绘为本地矢量图，不加载或跳转到原图 |
| `shanghai-film-museum-1f.svg`、`shanghai-film-museum-2f.svg`、`shanghai-film-museum-3f.svg`、`shanghai-film-museum-4f.svg` | 上海电影博物馆 1F–4F；依据 COORDINATION ASIA 项目楼层图重新绘制主要展区和交通空间为本地矢量图，不加载或跳转到原图 |
| `shanghai-natural-history-museum-l2.svg`、`shanghai-natural-history-museum-l1.svg`、`shanghai-natural-history-museum-b1.svg`、`shanghai-natural-history-museum-b2m.svg`、`shanghai-natural-history-museum-b2.svg` | 上海自然博物馆 L2、L1、B1、B2M、B2；依据馆方楼层导览重新绘制展区与中央穹顶关系为本地矢量图，不加载或跳转到原图 |
| `west-bund-museum-b1.svg`、`west-bund-museum-1f.svg`、`west-bund-museum-2f.svg` | 西岸美术馆 B1、1F、2F；依据 David Chipperfield Architects 项目设计图重绘楼层轮廓、展厅与公共空间关系，不嵌入原图；图旁标注建筑师版权与重绘说明 |
| `long-museum-west-bund-b1.svg`、`long-museum-west-bund-1f.svg`、`long-museum-west-bund-2f.svg` | 龙美术馆（西岸馆）B1、1F、2F；依据大舍建筑公开楼层平面本地重绘主要边界、房间分区及交通空间，不嵌入原图；产品内可放大查看 |
| `shanghai-museum-east-b1.svg`、`shanghai-museum-east-1f.svg`、`shanghai-museum-east-2f.svg`、`shanghai-museum-east-3f.svg`、`shanghai-museum-east-4f.svg`、`shanghai-museum-east-5f.svg` | 上海博物馆东馆 B1–5F；依据场馆 2025 年官方导览折页重绘楼层边界、主要展厅、公共走廊与出入口，均为项目内本地矢量图 |
| `shanghai-botanical-greenhouse-1f.svg`、`shanghai-botanical-greenhouse-2f.svg` | 上海植物园展览温室（一）、（二）；依据上海市绿化和市容管理局 2022 年专业测绘导览图重绘为本地矢量平面，不加载或跳转到原图 |
| `west-bund-dream-m-factory-1f.svg`、`west-bund-dream-m-factory-2f.svg`、`west-bund-dream-m-factory-3f.svg`、`west-bund-dream-m-factory-4f.svg`、`west-bund-dream-m-factory-roof.svg` | 西岸梦中心 M Factory 1F–4F 与屋顶；依据 MVRDV 公开设计平面重绘主要轮廓、挑空、附属空间及采光构件，不嵌入原图；图旁标注建筑师与本地重绘说明 |
| `west-bund-dream-silo-1-2f.svg`、`west-bund-dream-silo-3f-glass-roof.svg`、`west-bund-dream-silo-4f-roof.svg` | 西岸梦中心筒仓 1F–4F 与屋顶；依据 MVRDV 公开设计平面重绘六座筒仓、中央核心、外部交通塔和屋面连桥，不嵌入原图；产品内可放大查看 |
| `shanghai-stadium-stands.svg` | 上海体育场看台层；依据徐汇区政府 2025 年观演指南重绘看台编号、扶梯位置和场芯导引，不嵌入原图；场次入口与开放安排以当日指引为准 |
| `shanghai-center-of-photography-1f.svg` | 上海摄影艺术中心单层；依据 Johnston Marklee 与西岸官方对六个曲面体量、三角玻璃庭院和连接入口的公开描述本地重绘，不嵌入原图；尺寸、展墙与当前入口开放状态未标示 |
| `tank-shanghai-1-1f.svg`、`tank-shanghai-1-2f.svg`、`tank-shanghai-2-1f.svg`、`tank-shanghai-2-roof.svg`、`tank-shanghai-3-1f.svg`、`tank-shanghai-4-1f.svg`、`tank-shanghai-4-2f.svg`、`tank-shanghai-4-3f.svg`、`tank-shanghai-5-1f.svg` | 油罐艺术中心五座油罐的九个楼层；依据 OPEN Architecture 项目设计资料和现场导览牌核对主要圆形壳体、内置体量及庭院关系，由伴途本地矢量重绘；未公开的隔断、入口和楼梯不作推断 |

### 第三方授权地图

| 本地文件 | 地点 | 作者与来源 | 授权与处理 |
| --- | --- | --- | --- |
| `tank-shanghai-plan.jpg` | 油罐艺术中心园区导览牌照片（绘图参考，不作为室内平面图展示） | Lcsun，[Wikimedia Commons 文件页](https://commons.wikimedia.org/wiki/File:Floor_Plan_of_Tank_Shanghai.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)，原图下载，未修改；照片拍摄于 2020-07-14 |

### 外部楼层与线上导览入口

伴途只在授权条件允许时本地展示第三方地图，并在图旁标出作者、来源和许可；未收录地图的场馆不会在产品中跳转到外部页面。没有本地核实图的楼层不绘制虚构布局。

| 地点 | 来源 | 页面 |
| --- | --- | --- |
| 徐家汇藏书楼 | 上海图书馆恢复开放公告（一楼展厅开放；页面非平面图） | https://www.library.sh.cn/article/93158 |
| 龙华寺 | 上海本地宝 2026 年春节敬香路线图（节庆流线示意，非全年常态导览） | https://m.sh.bendibao.com/tour/304090.html |
| 上海体育场 | 徐汇区政府 2025 年观演指南中的看台编号与扶梯位置（活动导引；伴途本地重绘，入口安排按当日活动变化） | https://www.shanghai.gov.cn/nw17239/20251107/cf20bae9dda642b28dc801cfa8b7a220.html |
| 上海摄影艺术中心 | Johnston Marklee 建筑师对六个体量、三角庭院和入口连接点的项目介绍；西岸官方场馆页面说明展厅关系（伴途据公开资料本地重绘） | https://www.johnstonmarklee.com/work/pavilion-of-six-views；https://www.westbund.com/cn/index/KEY-PROJECTS/detail_bd1E5.html |
| 上海体育馆 | 徐汇区官方徐家汇体育公园位置与出入口图（园区图，非室内楼层平面） | https://www.xuhui.gov.cn/gzfw-shdt/20241212/548672.html |
| 上海图书馆（淮海路馆） | 上海图书馆官网 | https://www.library.sh.cn/guide/floor |
| 油罐艺术中心 | OPEN Architecture 项目页与设计资料（伴途只展示本地重绘图） | https://openarch.com/task/123 |
| 西岸美术馆 | David Chipperfield Architects 项目设计平面图集（伴途本地重绘；仅作单次项目参考并按图集要求署名） | https://cdn.archilovers.com/projects/afba78e3-f80c-4db0-95eb-eebd47a1a99b.pdf |
| 徐家汇书院 | 灵感LAB 发布的 Wutopia Lab 项目页（空间叙事与 1–3 层平面用于核对；伴途重新绘制空间关系示意，未复制原图） | https://lingganlb.com/index/index/detail.html?code=A7807715241451234693 |
| 宋庆龄故居纪念馆 | 故居官方 VR 在线讲解 | https://www.shsoong-chingling.com/list-exhibition.html |
| 上海气象博物馆 | 上海市文旅推广网全景导览二维码页（非平面图；未找到直达全景链接）；徐汇区政府 2021 年展陈介绍（仅辅助核对二、三楼内容，不是平面图） | https://www.meet-in-shanghai.net/cn/guide/before-you-go-crazy-lets-meet-online-and-feel-the-artistic-atmosphere-without-leaving-home-755550/；https://www.xuhui.gov.cn/xwzx_bmlf/20210915/293115.html |
| 上海电影博物馆 | 上海市文旅推广网参观介绍（四层主题与展项内容；伴途据此绘制内容示意，不表示展厅方位） | https://www.meet-in-shanghai.net/cn/museums/shanghai-film-museum-315329/ |
| 龙美术馆（西岸馆） | 大舍建筑楼层平面（伴途已重绘并本地展示；不在产品中跳转） | https://www.archdaily.cn/cn/778009/long-mei-zhu-guan-xi-an-guan-da-she-jian-zhu/54336ce9c07a80cbe80000e7-long-museum-west-bund-atelier-deshaus-floor-plan |
| 上海公安博物馆 | 如视制作的线上 VR 数字馆（含四层楼层结构图与实景导览） | https://presentation.realsee.cn/museum/REQQN65y?autoplay=0 |
| 上海博物馆东馆 | 场馆 2025 年官方导览折页（B1-5F 楼层布局；伴途本地重绘，产品内不跳转） | https://www.shanghaimuseum.net/mu/upload/202508/e303e216-d767-4bec-bc72-39d26c05f899.pdf |
| 上海电影博物馆 | COORDINATION ASIA 项目页与设计团队发布的 1F–4F 展陈楼层图；伴途据此重绘展厅相邻关系 | https://coordination.asia/completion-shanghai-film-museum/；https://architizer.com/projects/shanghai-film-museum/ |
| 上海摄影艺术中心 | 西岸官方场馆介绍（约 90 米展线；非平面图） | https://www.westbund.com/cn/index/KEY-PROJECTS/detail_bd1E5.html |
| 上海摄影艺术中心 | 建筑师 Johnston Marklee 项目页（入口与庭院布局；设计参考，非游客平面图） | https://www.johnstonmarklee.com/work/pavilion-of-six-views |
| 上海工艺美术博物馆 | 2019 年文章内的主楼平面图资料；1F–3F 由伴途按空间结构本地重绘为 SVG，未复制原图；非当前导览 | https://www.sohu.com/a/318394809_538891 |
| 上海植物园 | 上海植物园官方游园地图与语音导览说明 | https://www.shbg.org/sites/zhiwuyuan/InfoContent.aspx?ctgId=3c25f682-3f21-4cb3-994b-ab79489bacae&infoId=bc3ac58b-5775-4cb6-a921-53f179926c2b |
| 上海植物园 | 上海市绿化和市容管理局发布的温室（一、二）内部导览图（2022；外部页面，未下载） | https://lhsr.sh.gov.cn/ywdt/20220913/d31fa7be-2cf1-49aa-bf52-2a4974ddd3b0.html |
| 龙华烈士陵园 | 龙华烈士陵园官方全景导览 | https://www.slmmm.cn/360/vtourshiwai/index.html |
| 上海交通大学徐汇校区 | 上海交通大学校园电子地图 | https://map.sjtu.edu.cn/ |
| 光启公园 | 徐汇绿化市容发布的游园动线图 | https://finance.sina.com.cn/jjxw/2026-09-04/doc-iniqrpra1486259.shtml |
| 徐家汇公园 | 徐汇区绿化市容局 2024 年园内导览图（含公厕标识；外部页面图片，未下载） | https://www.thepaper.cn/newsDetail_forward_27309165 |
| 桂林公园 | 徐汇区政府 2026 年重开报道内的公园导览图（外部页面图片；未下载） | https://www.xuhui.gov.cn/xwzx_bmlf/20260723/575348.html |
| 土山湾博物馆 | 上海市文旅推广网文章内的全景导览二维码（2022；非平面图，未找到可直接打开的全景地址） | https://www.meet-in-shanghai.net/cn/news/world-book-day-starts-a-journey-of-light-to-trace-the-source-of-shanghaistyle-culture-639185/ |
| 星美术馆 | Ateliers Jean Nouvel 的首层与平台层设计发展平面（2022；经 Gooood 设计网分享）；伴途本地重绘，未复制原图；夹层暂无可核验平面 | https://www.gooood.cn/start-museum-shanghai-by-ateliers-jean-nouvel.htm |
| 西岸梦中心 | MVRDV 官方场地总图、M Factory 1F–4F 与屋顶平面、筒仓 1F–4F 与屋顶平面；伴途本地重绘，产品内不跳转 | https://www.mvrdv.com/projects/847/gate-m-west-bund-dream-center |
| 巴金故居 | 上海市虹口区政府修缮期间暂停开放公告（2026-09-24） | https://www.shhk.gov.cn/xwzx/002014/20260924/3f7b905c-2934-443f-985b-e3a30cf61af8.html |

## 实拍照片

下表记录实拍照片的摄影者、原始来源与授权信息。

| 本地文件 | 地点与说明 | 摄影者 | 来源 | 授权 |
| --- | --- | --- | --- | --- |
| `wukang-2.jpg` | 武康大楼红砖立面 | 钉钉 | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wukang_Mansion_2.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `wukang-3.jpg` | 武康大楼路口 | 钉钉 | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wukang_Mansion_Intersection.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `xujiahui-library-2.jpg` | 徐家汇书院空间一景 | Nanhuajiaren | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:%E5%BE%90%E5%AE%B6%E6%B1%87%E4%B9%A6%E9%99%A2_13.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `xujiahui-library-3.jpg` | 徐家汇书院内部 | Nanhuajiaren | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:%E5%BE%90%E5%AE%B6%E6%B1%87%E4%B9%A6%E9%99%A2_05.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `longhua-2.jpg` | 龙华寺建筑与庭院 | Jakub Hałun | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:20090816_Shanghai_Longhua_Temple_3070.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `longhua-3.jpg` | 龙华寺塔 | Drew Lietzow | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Shanghai%27s_Longhua_Temple_Pagoda.JPG) | 公有领域 |
| `westbund-2.jpg` | 西岸美术馆建筑外观 | Lcsun | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Appearance_of_west_bund_museum_shanghai,_June_2020.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `xujiahui-park-2.jpg` | 徐家汇公园烟囱 | Livelikerw | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:The_Chimney_in_Xujiahui_Park_Shanghai.jpg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `xujiahui-park-3.jpg` | 徐家汇公园步道 | Szalai.laci | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Xujiahui_Park,_Shanghai,_China_Feb_21,_2018.jpeg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `guilin-park-2.jpg` | 桂林公园亭台 | Szalai.laci | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Guilin_Park_Shanghai,_pavilion.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `guilin-park-3.jpg` | 桂林公园竹林门景 | Szalai.laci | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Guilin_Park_Shanghai,_bamboo.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
