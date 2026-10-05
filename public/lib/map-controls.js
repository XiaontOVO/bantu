/** 首页与路线地图共用缩放控件，保留 Leaflet 的缩放、键盘及禁用行为。 */
import { uiIcon } from './icons.js';

export function addMapZoomControl(map, leaflet = window.L) {
  const control = leaflet.control.zoom({
    position: 'topright',
    zoomInText: uiIcon('zoom-in', { size: 18 }),
    zoomOutText: uiIcon('zoom-out', { size: 18 }),
    zoomInTitle: '放大地图',
    zoomOutTitle: '缩小地图',
  }).addTo(map);
  control.getContainer().classList.add('bantu-map-zoom');
  return control;
}

export function addMapLocateControl(map, leaflet = window.L) {
  const control = leaflet.control({ position:'topright' });
  control.onAdd = () => {
    const container = leaflet.DomUtil.create('div','bantu-map-locate leaflet-bar');
    container.innerHTML = `<button type="button" data-action="map-locate" aria-label="重新定位并从当前位置出发" title="当前位置">${uiIcon('locate',{size:20})}</button>`;
    leaflet.DomEvent.disableClickPropagation(container);
    leaflet.DomEvent.disableScrollPropagation(container);
    return container;
  };
  return control.addTo(map);
}
