/** Percent coordinates follow the AI panoramic artwork; never GPS or room layout. */
const REGIONS = {
  'wukang-building': {
    'brick-facade': [[20,51],[43,18],[42,66],[22,83]],
    'curved-corner': [[44,18],[51,3],[59,3],[60,12],[59,89],[42,86],[42,48]],
    'street-view': [[0,87],[24,89],[53,91],[77,86],[100,86],[100,100],[0,100]],
  },
  'xujiahui-library': {
    'book-wall': [[0,0],[44,0],[42,62],[30,100],[0,100]],
    'children-reading': [[34,62],[45,57],[66,60],[73,85],[71,100],[30,100]],
    'upstairs-reading': [[66,34],[100,30],[100,75],[77,78],[66,58]],
  },
  'xujiahui-park': {
    'chimney': [[21,4],[28,4],[29,64],[21,64]],
    'tree-walk': [[51,68],[58,68],[78,100],[12,100]],
    'skywalk': [[73,64],[82,52],[100,43],[100,61],[85,66],[79,82],[72,81],[68,72]],
  },
  'longhua-temple': {
    'pagoda-eaves': [[19,0],[28,0],[32,54],[31,62],[17,62],[18,48]],
    'hall-roof': [[58,28],[76,11],[100,12],[100,71],[65,76],[60,56]],
    'incense-vessel': [[48,31],[55,31],[58,51],[61,60],[60,93],[43,93],[43,60],[46,50]],
  },
  'guilin-park': {
    'moon-gate': [[30,43],[36,34],[44,34],[49,47],[48,70],[44,79],[33,79],[29,67]],
    'bamboo-frame': [[0,0],[29,0],[32,32],[20,80],[0,85]],
    'covered-walk': [[64,12],[78,0],[100,0],[100,100],[88,94],[67,76]],
  },
  'westbund-museum': {
    'facade-grid': [[53,26],[67,14],[71,14],[71,58],[59,60],[53,42]],
    'square-corner': [[70,1],[76,11],[83,35],[82,64],[73,67],[71,41]],
    'plaza-shadows': [[0,73],[29,73],[41,84],[54,92],[54,100],[0,100]],
  },
  'shanghai-natural-history': {
    'architecture': [[0,0],[26,0],[27,30],[38,60],[31,82],[0,86]],
    'life-river': [[26,6],[31,3],[38,33],[50,43],[66,46],[77,61],[81,81],[54,90],[34,84],[32,64],[45,62],[41,45]],
    'evolution': [[82,37],[100,28],[100,87],[80,87],[80,63]],
  },
};
export function sceneHitRegion(sceneId, hotspot) {
  const points = REGIONS[sceneId]?.[hotspot.id];
  if (!points) return null;
  const left = Math.min(...points.map(p=>p[0])), top = Math.min(...points.map(p=>p[1]));
  const width = Math.max(...points.map(p=>p[0]))-left, height = Math.max(...points.map(p=>p[1]))-top;
  return { left, top, width, height,
    polygon:points.map(([x,y])=>`${(x-left)/width*100}% ${(y-top)/height*100}%`).join(',') };
}
