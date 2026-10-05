/** Entry availability only; scene facts always come from the server catalog. */
export function hasPlaceScene(place) {
  const name = String(place?.name || '').trim();
  return /^上海自然博物馆(?:[（(]静安馆[）)])?$/.test(name) || name === '武康大楼' ||
    /^(?:徐家汇书院|上海市徐汇区图书馆[（(]徐家汇书院[）)])$/.test(name) || name === '徐家汇公园' || name === '龙华寺' || name === '桂林公园' || name === '西岸美术馆';
}
