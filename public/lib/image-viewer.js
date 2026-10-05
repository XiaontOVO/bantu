/** 本地照片校验与共用大图面板；所有退出操作由 sheet 管理。 */
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';

export function safeLocalPhotoPath(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return '';
  const pathname = url.split(/[?#]/, 1)[0];
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); } catch { return ''; }
  if (decodedPath.includes('\\') || decodedPath.startsWith('//') || decodedPath.split('/').some(segment => segment === '..') || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(pathname)) return '';
  return url;
}

export function imageViewerHtml({ src, title = '查看大图', alt = '', floorPlan = false, evidence = '' }) {
  return `<div class="place-image-viewer${floorPlan ? ' place-floorplan-viewer' : ''}"><div class="sheet-head place-image-viewer-head"><h3 title="${escapeHtml(title)}">${escapeHtml(title)}</h3><button type="button" class="icon-btn" data-action="close-sheet" aria-label="关闭大图" title="关闭大图">${uiIcon('close', { size: 20 })}</button></div>${evidence}<figure class="place-image-viewer-frame${floorPlan ? ' place-floorplan-viewer-frame' : ''}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">${floorPlan ? '<figcaption>拖动查看整张图</figcaption>' : ''}</figure></div>`;
}
