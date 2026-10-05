import { escapeHtml } from './format.js';

// Dates describe the reference, never a site visit or verification date.
const REFERENCES = Object.freeze({
  '上海博物馆东馆': { kind: 'official-guide', source: '上海博物馆东馆官方导览折页', year: 2025 },
  '上海自然博物馆': { kind: 'official-guide', source: '上海自然博物馆官网楼层导览' },
  '上海儿童博物馆': { kind: 'official-guide', source: '上海儿童博物馆官网彩色平面图' },
  '上海图书馆': { kind: 'official-guide', source: '上海图书馆淮海路馆官方楼层图' },
  '上海植物园': { kind: 'official-guide', source: '上海市绿化和市容管理局温室导览图', year: 2022 },
  '上海体育场': { kind: 'official-guide', source: '徐汇区政府观演指南', year: 2025 },
  '徐家汇书院': { kind: 'design-plan', source: 'Wutopia Lab 公开项目设计平面图' },
  '西岸美术馆': { kind: 'design-plan', source: 'David Chipperfield Architects 项目设计平面图' },
  '龙美术馆（西岸馆）': { kind: 'design-plan', source: '大舍建筑公开楼层平面图' },
  '星美术馆': { kind: 'design-plan', source: 'Ateliers Jean Nouvel 设计发展版平面图', year: 2022 },
  '西岸梦中心': { kind: 'design-plan', source: 'MVRDV 场地与建筑设计平面图' },
  '油罐艺术中心': { kind: 'design-outline', source: 'OPEN Architecture 公开设计资料' },
  '上海电影博物馆': { kind: 'project-guide', source: 'COORDINATION ASIA 项目楼层导览' },
  '上海公安博物馆': { kind: 'vr-outline', source: '公开 VR 导览中的房间坐标记录' },
  '上海摄影艺术中心': { kind: 'spatial-diagram', source: 'Johnston Marklee 与西岸官方空间关系介绍' },
  '上海工艺美术博物馆': { kind: 'historical-plan', source: '公开主楼平面图', year: 2019 },
});
const IMAGE_REFERENCES = Object.freeze({
  '/images/places/floorplan/xujiahui-library-b1.svg': { kind: 'area-diagram', source: '上海市文化和旅游局公开功能资料' },
});
const TYPES = Object.freeze({
  'official-guide': { label: '官方导览重绘', limit: '用于辨认楼层分区，非测绘比例；展陈与通行以现场为准。' },
  'design-plan': { label: '设计平面重绘', limit: '依据建筑设计图；布局、入口及开放范围尚未现场复核。' },
  'design-outline': { label: '设计轮廓示意', limit: '仅表达公开设计中的主要体量；未公开的隔断、入口和楼梯不作推断。' },
  'project-guide': { label: '项目导览重绘', limit: '依据项目发布时的楼层导览；当前展陈与开放范围尚未现场复核。' },
  'vr-outline': { label: 'VR 轮廓示意', limit: '依据导览房间坐标整理；不是现状测绘，入口与通行以现场为准。' },
  'spatial-diagram': { label: '空间关系示意', limit: '仅表达公开的展厅与庭院关系；未提供可核验的测绘平面。' },
  'historical-plan': { label: '历史平面重绘', limit: '依据历史图纸，不代表当前布局；展陈、入口及设施尚未现场复核。' },
  'area-diagram': { label: '功能组成示意', limit: '仅介绍功能，不表示房间边界、相对位置或通行路线。' },
  'unverified': { label: '资料待核实', limit: '图纸依据尚未完整记录，不能作为现场布局或导航依据。' },
});

export function floorPlanEvidence(placeName, image) {
  const reference = IMAGE_REFERENCES[image.src] || REFERENCES[placeName] || { kind: 'unverified', source: '资料依据待核实' };
  const type = TYPES[reference.kind];
  return { ...reference, ...type, dateLabel: reference.year ? `资料年份 ${reference.year}` : '资料时间未注明' };
}

export function restroomEvidenceText(image) {
  return image.restroomsMapped
    ? '蓝色标记来自参考资料，现场位置及开放状态尚未复核'
    : '本层位置尚未核实，图中不作推测';
}

/** Source labels stay local text: the product does not send users to reference sites. */
export function mapEvidenceHtml(evidence, { facilityText = '', notice = '' } = {}) {
  if (!evidence) return '';
  return `<aside class="map-evidence" aria-label="图纸依据与适用范围" data-map-kind="${escapeHtml(evidence.kind)}">
    <div class="map-evidence-meta"><strong>${escapeHtml(evidence.label)}</strong><span>${escapeHtml(evidence.dateLabel)}</span></div>
    <p class="map-evidence-source">依据：${escapeHtml(evidence.source)}</p>
    <p class="map-evidence-limit">${escapeHtml(evidence.limit)}</p>
    ${facilityText ? `<p class="map-evidence-facility">卫生间：${escapeHtml(facilityText)}</p>` : ''}
    ${notice ? `<details class="map-evidence-details"><summary>本层说明</summary><p>${escapeHtml(notice)}</p></details>` : ''}
  </aside>`;
}

export function overviewEvidenceHtml(map) {
  if (map?.geographic) return `<p class="site-map-evidence">伴途本地轮廓图 · 北向朝上 · 非测绘图。${escapeHtml(map.evidence.license)} · 资料读取日期 ${escapeHtml(map.evidence.referenceDate)}。建筑、道路和水域保留资料方位及比例，细节可能缺漏；入口与卫生间仅标注已有记录，开放状态以现场为准。</p>`;
  return '<p class="site-map-evidence">伴途场地方位示意 · 非测绘比例 · 资料日期未逐图记录。入口和通行范围以现场指引为准。</p>';
}
