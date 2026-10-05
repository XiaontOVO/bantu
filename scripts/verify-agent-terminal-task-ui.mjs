// Real mobile touch -> HTTP -> tool write -> provider error. Model errors are
// controlled; every account, note and checkpoint lives in MemoryStateStore.
import assert from 'node:assert/strict';
import {writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {modelTurn,toolCall} from '../dist/src/providers/model.js';
import {launchMobileBrowser,browserPause as pause} from './lib/mobile-browser.mjs';

const instruction='保存两篇笔记，第一篇内容就是“红砖\n晚风”，第二篇内容就是“白墙\n晨光”';
const note={sourceIndex:1,title:'红砖',text:'晚风'};
const modelCalls=[];
const provider={providerName:'terminal-ui-fixture',modelName:'fixture',async generateTurn(request){
  const lastUser=request.messages.findLastIndex(message=>message.role==='user');
  const user=request.messages[lastUser]?.content||'';
  const saved=request.messages.slice(lastUser+1).some(message=>message.role==='tool'&&message.toolName==='memories.create'&&JSON.parse(message.content||'{}').ok);
  modelCalls.push({user,saved});
  if(!saved)return modelTurn([toolCall('save-'+modelCalls.length,'memories.create',note)]);
  return {toolCalls:[toolCall('unsafe-'+modelCalls.length,'memories.create',{sourceIndex:2,title:'白墙',text:'晨光'})],finishReason:'error',error:{code:'MODEL_CONTEXT_LIMIT',message:'private-fixture-response'},usage:{inputTokens:0,outputTokens:0}};
}};
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:provider});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const before=process.argv.includes('--before');
const tag=before?'before':'after';
let browser,checks=0,phase='boot';
const defects=[],screenshots=[];
const check=(ok,label,detail)=>{checks++;if(!ok)defects.push({phase,label,...(detail===undefined?{}:{detail})})};
try{
  browser=await launchMobileBrowser('bantu-terminal-task-',{headless:false,gpu:true});
  const {command,evaluate,until,tap,fill,viewport}=browser;
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(navigator,'geolocation',{configurable:true,value:undefined})`});
  await command('Page.navigate',{url:base+'?terminal-ui=isolated#/agent'});
  await until(()=>evaluate('window.__bantuBooted===true'),'app boot');
  await evaluate(`(async()=>{const store=await import('/lib/store.js');window.terminalUI={state:store.state,api:(await import('/lib/api.js')).api,status:await import('/lib/agent-task-status.js'),render:await import('/lib/render.js')};(await import('/lib/agent-dock.js')).dismissAgentDock()})()`);
  phase='partial-save-and-overflow';
  await fill('#chatText',instruction);await tap('[data-chat-form] [type=submit]');
  await until(()=>evaluate(`!terminalUI.state.chatPending&&terminalUI.state.messages.some(m=>m.role==='assistant'&&m.text.includes('原生上下文容量不足'))`),'fatal receipt rendered');
  await evaluate('terminalUI.status.refreshAgentTaskStatus()');
  const result=await evaluate(`(async()=>({task:await terminalUI.api('/api/v1/agent/task'),notes:await terminalUI.api('/api/v1/memories'),reply:terminalUI.state.messages.filter(m=>m.role==='assistant').at(-1)?.text,resume:!!document.querySelector('[data-resume-agent]')}))()`);
  const items=Array.isArray(result.notes)?result.notes:result.notes.items;
  check(result.task.status==='completed','fatal checkpoint cannot resume',result.task);
  check(items?.length===1&&items[0].title==='红砖','only the actual successful first note exists',items);
  check(result.reply.includes('第2篇笔记原文还未保存')&&result.reply.includes('开启新对话'),'unfinished original and recovery guidance are visible',result.reply);
  check(!result.resume,'fatal reply does not offer a Continue button');
  check(!result.reply.includes('private-fixture-response'),'raw provider details are hidden');
  check(modelCalls.length===2,'error turn does not execute its attached second write');
  for(const width of [390,320]){
    await viewport(width,width===320?640:844);
    await evaluate(`(async()=>{document.documentElement.dataset.theme=${JSON.stringify(width===320?'dark':'light')};document.body.classList.toggle('large-text',${width===320});(await import('/lib/compact-mode.js')).setCompactMode(${width===320});terminalUI.render.render()})()`);
    await pause(120);
    const layout=await evaluate(`(()=>{const form=document.querySelector('[data-chat-form]'),send=form.querySelector('[type=submit]'),r=send.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth-innerWidth,enabled:!send.disabled,width:r.width,height:r.height,reply:document.querySelector('#chatList').innerText}})()`);
    check(layout.overflow<=1,'fatal feedback fits '+width,layout);
    check(layout.enabled&&layout.width>=43.9&&layout.height>=43.9,'new-request send target remains usable '+width,layout);
    check(layout.reply.includes('原生上下文容量不足'),'fatal explanation is readable '+width);
    screenshots.push(await browser.screenshot('fatal-'+width+'-'+tag));
  }
  phase='typed-terminal-continuation';
  const beforeCalls=modelCalls.length;
  await fill('#chatText','继续');await tap('[data-chat-form] [type=submit]');
  await until(()=>evaluate(`!terminalUI.state.chatPending&&terminalUI.state.messages.filter(m=>m.role==='user').at(-1)?.text==='继续'`),'typed continuation returns');
  await evaluate('terminalUI.status.refreshAgentTaskStatus()');
  const continued=await evaluate(`(async()=>({task:await terminalUI.api('/api/v1/agent/task'),notes:await terminalUI.api('/api/v1/memories'),resume:!!document.querySelector('[data-resume-agent]'),reply:terminalUI.state.messages.filter(m=>m.role==='assistant').at(-1)?.text}))()`);
  const notes=Array.isArray(continued.notes)?continued.notes:continued.notes.items;
  check(modelCalls.length===beforeCalls,'pure Continue makes no new model request',{beforeCalls,afterCalls:modelCalls.length});
  check(notes?.length===1,'pure Continue does not duplicate the saved note',notes);
  check(continued.task.id===result.task.id&&continued.task.status==='completed','terminal checkpoint remains closed',continued.task);
  check(!continued.resume&&continued.reply.includes('开启新对话'),'typed Continue gives actionable recovery without a false resume button',continued.reply);
  screenshots.push(await browser.screenshot('terminal-continue-320-'+tag));
  check(browser.exceptions.length===0,'no uncaught browser errors',browser.exceptions);
  const evidence=resolve('tmp/agent-terminal-task-ui-'+tag+'-evidence');mkdirSync(evidence,{recursive:true});
  const preserved=screenshots.map(path=>{const target=resolve(evidence,basename(path));copyFileSync(path,target);return target});
  const proof={recordedAt:new Date().toISOString(),checks,defects,modelCalls,screenshots:preserved,controlledModel:true,isolatedData:true,actualPhone:false,output:browser.output};
  writeFileSync('tmp/agent-terminal-task-ui-'+tag+'-proof.json',JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof,null,2));
  if(!before)assert.equal(defects.length,0,'Terminal task GUI defects');
}finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
