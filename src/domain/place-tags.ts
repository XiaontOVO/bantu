export const OFFICIAL_PLACE_TAGS = [
  { id: 'landmark', label: '城市地标' }, { id: 'culture', label: '文化展览' },
  { id: 'food', label: '美食探店' }, { id: 'rest', label: '休息歇脚' },
  { id: 'nature', label: '自然风光' }, { id: 'night', label: '夜游' },
  { id: 'photo', label: '拍照打卡' }, { id: 'family', label: '亲子出游' },
  { id: 'outdoor', label: '户外' }, { id: 'indoor', label: '室内' },
];

export function officialTagIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some(id => !OFFICIAL_PLACE_TAGS.some(tag => tag.id === id))) throw new Error('请选择平台提供的标签，最多 10 个。');
  return [...new Set(value as string[])];
}
export function customTagNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 20)) throw new Error('自定义标签最多 8 个，每个 1–20 个字。');
  return [...new Set((value as string[]).map(tag => tag.trim()))];
}
export function placeTags(place: { category?: string; facilityCodes?: string[]; officialTagIds?: string[]; customTags?: string[] }) {
  const ids = new Set(place.officialTagIds ?? [place.category, ...(place.facilityCodes || []).filter(id => ['indoor', 'outdoor'].includes(id))]);
  return [...OFFICIAL_PLACE_TAGS.filter(tag => ids.has(tag.id)).map(tag => ({ ...tag, source: 'official' })),
    ...(place.customTags || []).map(label => ({ id: label, label, source: 'user' }))];
}
