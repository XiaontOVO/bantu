/** UI catalogue. A mode is offered here only once its execution/route contract exists. */
export const TRANSPORT_MODES = Object.freeze([
  Object.freeze({ value: 'walking', label: '步行', icon: 'walk', description: '适合短途慢逛' }),
  Object.freeze({ value: 'transit', label: '公共交通', icon: 'train', description: '公交与地铁' }),
  Object.freeze({ value: 'driving', label: '驾车', icon: 'car', description: '沿道路驾车出行' }),
]);
export const TRANSPORT_LABELS = Object.freeze(Object.fromEntries(TRANSPORT_MODES.map(mode => [mode.value, mode.label])));
export function transportModeInfo(value) { return TRANSPORT_MODES.find(mode => mode.value === value); }
