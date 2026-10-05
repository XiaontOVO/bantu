// Shared drawing vocabulary, embedded in each SVG so the assets remain standalone.
export const palette = Object.freeze({ canvas: '#f5f6f5', ink: '#223a50', muted: '#637c92', wall: '#748aa8', shell: '#d9edf0', primary: '#809bc5', secondary: '#b7c9dc', public: '#a0bfd2', service: '#eaf1f3', closed: '#dfe4e8', restroom: '#176c91', exit: '#287c57' });

export function restroom(x, y, scale = 1) {
  return `<g class="restroom-marker" role="img" aria-label="卫生间" transform="translate(${x} ${y}) scale(${scale})"><rect class="restroom-backplate" x="-43" y="-15" width="86" height="30" rx="7"/><g class="restroom-pictogram" transform="translate(-30 -10)"><circle cx="-3" cy="3" r="2"/><circle cx="7" cy="3" r="2"/><path d="M-6 7h6v6h-1v6h-2v-6h-1v6h-2V7ZM7 7l4 8H9v4H7v-4H5v4H3v-4H1l4-8Z"/></g><text class="restroom-caption" x="12" y="1">卫生间</text></g>`;
}

export function standardStyle(width = 1200) {
  const scale = width / 1200;
  return `<style id="bantu-floorplan-standard-v3">
svg{background:#f5f6f5}
text{font-family:'Microsoft YaHei','Noto Sans CJK SC',sans-serif!important}
.bg,.canvas,.paper{fill:#f5f6f5!important}
.cutout{fill:#f5f6f5!important;stroke:#fff!important;stroke-width:2px!important}
linearGradient[id*="paper"] stop,linearGradient#page stop,linearGradient#background stop{stop-color:#f5f6f5!important}
linearGradient#public stop{stop-color:#a0bfd2!important}linearGradient#closed stop{stop-color:#dfe4e8!important}
#grid path{stroke:#d8e0e4!important}
.shell,.outer,.plan-shell{fill:#d9edf0!important;stroke:#748aa8!important;stroke-width:${2.5 * scale}px!important;stroke-linejoin:round}
.room,.room-dark,.zone,.gallery,.exhibit,.primary,.deep,.blue,.stage,.shop,.retail{fill:#809bc5!important;stroke:#fff!important;stroke-width:${2.5 * scale}px!important;stroke-linejoin:round}
.service,.core,.wc,.zone.wc,.amenity rect{fill:#eaf1f3!important;stroke:#748aa8!important;stroke-width:${1.3 * scale}px!important}
.public,.lobby,.passage,.room-light,.stair,.hall,.open-hall{fill:#a0bfd2!important;stroke:#fff!important}
.yellow,.warm,.craft,.pink,.orange,.food,.dining,.gallery2{fill:#b7c9dc!important;stroke:#fff!important}
.green,.garden,.yard,.terrace,.courtyard{fill:#d7e6dd!important;stroke:#fff!important}
.private,.void{fill:#dfe4e8!important;stroke:#a7b4bf!important}
.zone.exit,.exit,.entry,.entry-marker rect{fill:#287c57!important}
.wall,.partition,.shell-edge{stroke:#748aa8!important}
text.label,text.label2,text.label-small,text.label-light,text.minor,text.public-label,text.room-title{fill:#223a50!important;font-weight:600!important;stroke:none!important}
text.title,text.panel-title,text.panel-label,text.legend-title,text.zone-title,text.pt,text.info-heading{fill:#223a50!important;font-weight:650!important;stroke:none!important}
text.note,text.subtitle,text.sub,text.small,text.copy,text.panel-text,text.zone-sub,text.eyebrow,text.index,text.legend-text,text.info-copy{fill:#637c92!important;stroke:none!important}
.panel,.info-panel{fill:#fff!important;stroke:#d8e0e4!important;stroke-width:1.4px!important}.panel-head{fill:#eaf0f2!important}
.tag:not(text){fill:#eaf0f2!important;stroke:#748aa8!important}
.floor,.floor-badge{fill:#637fa5!important}.floor-text,.badge-text{fill:#fff!important}
.label.exit,.exit text,.entry-marker text,.entrance-text{fill:#fff!important;stroke:none!important}
.route{stroke:#d39a4e!important}.numdot,.num circle,.number circle,circle.badge{fill:#637fa5!important;stroke:#fff!important}
.door{stroke:#287c57!important}
.number text,.num text,text.number{fill:#fff!important;stroke:none!important}
.hall-tiles{opacity:.15!important}
.restroom-backplate{fill:#176c91!important;stroke:#fff!important;stroke-width:2px!important}
.restroom-pictogram circle,.restroom-pictogram path{fill:#fff!important;stroke:none!important}
.restroom-caption{font-size:13px!important;font-weight:600!important;fill:#fff!important;stroke:none!important;text-anchor:middle;dominant-baseline:central}
</style>`;
}
