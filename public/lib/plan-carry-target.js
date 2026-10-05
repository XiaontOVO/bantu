/** Append a carried visit after the destination day's existing visits. */
export function carryPlaceTarget({ baseDate, start, duration, intervals = [], plans = [] }) {
  const base = Date.parse(`${baseDate}T00:00:00Z`);
  const slots = [...intervals].sort((a,b)=>a.startMinutes-b.startMinutes);
  const fit = earliest => slots.length
    ? slots.map(slot=>Math.max(earliest,slot.startMinutes)).find((carryMinute,index)=>carryMinute<1440&&carryMinute+duration<=slots[index].endMinutes)
    : earliest < 1440 ? earliest : undefined;
  if (fit(0) === undefined) throw new Error('开放时段排不下这次游览，请缩短停留或调整安排后再添加。');
  let offset = Math.max(1,Math.floor(start/1440));
  // Each occupied date can advance the search once; an empty date must fit.
  for (let attempt=0;attempt<=plans.length;attempt++,offset++) {
    const date = new Date(base+offset*86400000).toISOString().slice(0,10);
    const targets = plans.filter(plan=>plan.kind==='plan'&&plan.localDate===date);
    if (targets.length>1) throw new Error(`${date} 有多份日计划，请先处理重复安排。`);
    const plan = targets[0];
    const stops = (plan?.stops || []).filter(stop=>stop.status!=='skipped');
    const departure = stops.reduce((latest,stop)=>Math.max(latest,
      [stop.departureMinutes,stop.plannedDepartureMinutes,stop.endMinutes,stop.startMinutes].find(Number.isFinite)??0),0);
    const carryMinute = fit(Math.max(attempt===0?start%1440:0,departure));
    if (carryMinute!==undefined) return { date,dayOffset:offset,start:offset*1440+carryMinute,plan,
      expected:{localDate:date,planId:plan?.id||null,expectedRevision:plan?(plan.revision||0):null} };
  }
  throw new Error('暂时无法接续后续日期，请调整安排后重新添加。');
}
