// Isolated HTTP checks for natural-language dates, clocks and visit durations.
import assert from 'node:assert/strict';
import { createHttpServer } from '../dist/src/server/http-server.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),now:()=> '2026-09-22T01:00:00.000Z'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const cases=[
  {text:'安排下周一去武康大楼',date:'2026-09-28'},
  {text:'安排下周末去武康大楼',date:'2026-10-03'},
  {text:'安排明天下午三点半去武康大楼',date:'2026-09-23',start:930},
  {text:'安排明天14:00去武康大楼，游览1小时30分钟',date:'2026-09-23',start:840,duration:90},
  {text:'安排明天去武康大楼，游览一个半小时',date:'2026-09-23',duration:90},
  {text:'安排2026-09-31去武康大楼',invalid:true},
  {text:'安排明天25:00去武康大楼',invalid:true},
  {text:'生成31天方案：武康大楼',invalid:true},
];
let failures=0;
try {
  for(const [index,item] of cases.entries()){
    const session=await fetch(base+'/api/v1/session/guest',{method:'POST'});
    const cookie=session.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/v1/agent/chat',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({text:item.text,clientMessageId:`audit-${index}`})});
    const result=await response.json();
    const plans=(await (await fetch(base+'/api/v1/plans',{headers:{cookie}})).json()).data;
    try {
      assert.equal(response.status,200);
      if(item.invalid){assert.equal(plans.length,0,'invalid input must not silently become a different saved plan');}
      else{
        const plan=plans.find(plan=>plan.kind==='plan');assert.ok(plan,'a valid intent should create a plan');
        assert.equal(plan.localDate,item.date);
        if(item.start!==undefined)assert.equal(plan.stops[0].startMinutes,item.start);
        if(item.duration!==undefined)assert.equal(plan.stops[0].plannedDurationMinutes,item.duration);
      }
      console.log(JSON.stringify({ok:true,text:item.text}));
    }catch(error){failures++;console.log(JSON.stringify({ok:false,text:item.text,error:error.message,reply:result.data?.assistantMessage.text,plans:plans.map(plan=>({date:plan.localDate,days:plan.days?.length,stops:plan.stops?.map(stop=>({name:stop.place?.name,start:stop.startMinutes,duration:stop.plannedDurationMinutes}))}))}));}
  }
  console.log(JSON.stringify({cases:cases.length,failures}));
  if(failures&&!process.argv.includes('--observe'))process.exitCode=1;
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
