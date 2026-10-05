import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load=(path:string)=>import(pathToFileURL(join(process.cwd(),path)).href) as Promise<Record<string,any>>;
const {state}=await load('public/lib/store.js');
const journal=await load('public/lib/travel-journal.js');
const {writingDraft}=await load('public/lib/writing-drafts.js');
const ui=await load('public/lib/ui.js');
let ownerSequence=0;
const reply=(data:any)=>new Response(JSON.stringify({data}));
function harness(){
  const previous={...state},browser={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  const nodes:Record<string,any>={sheetBackdrop:{hidden:true},toast:{textContent:'',className:''}};
  const makeNode=(value='')=>{
    const listeners:Record<string,Array<(event:any)=>void>>={};
    return {value,textContent:'',innerHTML:'',disabled:false,isConnected:true,
      addEventListener(event:string,callback:(event:any)=>void){(listeners[event]||=[]).push(callback)},
      dispatchEvent(event:Event){for(const callback of listeners[event.type]||[])callback({target:this,currentTarget:this})},
      input(value:string){this.value=value;this.dispatchEvent(new Event('input'))}};
  };
  let html='',fieldIds:string[]=[];
  nodes.sheet={querySelector:()=>null,querySelectorAll:()=>[],getAttribute:()=>null,setAttribute(){},removeAttribute(){},focus(){},childNodes:[]};
  Object.defineProperty(nodes.sheet,'innerHTML',{get:()=>html,set(value:string){
    for(const id of fieldIds){nodes[id].isConnected=false;delete nodes[id]}fieldIds=[];html=value;
    for(const match of value.matchAll(/id="([^"]+)"/g)){fieldIds.push(match[1]);nodes[match[1]]=makeNode()}
    for(const match of value.matchAll(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g))nodes[match[1]].value=match[2];
    if(nodes.postVisibility)nodes.postVisibility.value='public';
  }});
  globalThis.document={activeElement:null,body:{style:{}},getElementById:(id:string)=>nodes[id]||null,querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false} as unknown as Document;
  globalThis.window={} as Window & typeof globalThis;
  Object.assign(state,{principal:{principalId:`editor-save-owner-${++ownerSequence}`,kind:'account',username:'fixture'},accountContextChanged:false,currentView:'community',trip:null,memories:[],savedPlans:[],places:[],loadStatus:{},navigationRevision:0});
  return {nodes,restore(){ui.closeSheet();clearTimeout((globalThis.window as any).__toastTimer);Object.assign(state,previous);Object.assign(globalThis,browser)}};
}

test('a late post save preserves a reopened editor, its text, photos and own error status',async()=>{
  const h=harness();
  try{
    let release!:(response:Response)=>void,calls=0;
    globalThis.fetch=(()=>{calls++;return new Promise<Response>(resolve=>{release=resolve})}) as typeof fetch;
    await journal.writePost();h.nodes.postText.input('已提交的帖子');
    const pending=journal.publishPost({disabled:false});
    await journal.publishPost({disabled:false});assert.equal(calls,1,'repeat touches share the existing pending write');
    ui.closeSheet();
    const photo={dataUrl:'data:image/png;base64,aGVsbG8=',alt:'后来的照片'};
    const retained=writingDraft('post','new');retained.save({...retained.read(),images:[photo]});
    await journal.writePost();h.nodes.postText.input('重开后继续写');
    const input=h.nodes.postText;
    release(reply({id:'committed-post'}));await pending;
    assert.equal(h.nodes.sheetBackdrop.hidden,false);assert.equal(h.nodes.postText,input);
    assert.equal(input.value,'重开后继续写');assert.equal(h.nodes.postStatus.textContent,'');
    assert.equal(writingDraft('post','new').read().text,'重开后继续写');
    assert.equal(h.nodes.postImageCount.textContent,'1/4');
    let retryBody:any;
    globalThis.fetch=(async(_path,options={})=>{retryBody=JSON.parse(String(options.body));throw new TypeError('Failed to fetch')}) as typeof fetch;
    const retryButton={disabled:false};await journal.publishPost(retryButton);
    assert.deepEqual(retryBody.images,[photo]);assert.equal(retryButton.disabled,false);
    assert.equal(h.nodes.postText,input);assert.equal(retained.read().text,'重开后继续写');
  }finally{h.restore()}
});

test('a note save retains new input in the same editor and preserves its writing draft',async()=>{
  const h=harness();
  try{
    let release!:(response:Response)=>void;
    globalThis.fetch=(()=>new Promise<Response>(resolve=>{release=resolve})) as typeof fetch;
    const previousNote={memoryId:'existing-note',userText:'已有的个人笔记',createdAt:'2026-09-01T00:00:00Z'};
    state.memories=[previousNote];
    journal.writeDayNote();h.nodes.journalText.input('提交时的笔记');
    const input=h.nodes.journalText,pending=journal.saveDayNote({disabled:false});
    input.input('提交后的继续补写');
    release(reply({memoryId:'committed-note',userText:'提交时的笔记',createdAt:new Date().toISOString()}));await pending;
    assert.equal(h.nodes.sheetBackdrop.hidden,false);assert.equal(h.nodes.journalText,input);
    assert.equal(input.value,'提交后的继续补写');
    assert.equal(writingDraft('journal','personal:fixture').read().text,'提交后的继续补写');
    assert.match(h.nodes.journalStatus.textContent,/之后的修改仍在草稿/);
    assert.ok(state.memories.includes(previousNote),'saving without leaving the editor keeps previously loaded notes');
    assert.ok(state.memories.some((memory:any)=>memory.memoryId==='committed-note'));
  }finally{h.restore()}
});

test('a failed post save cannot put its old error into a later post editor',async()=>{
  const h=harness();
  try{
    let reject!:(error:Error)=>void;
    globalThis.fetch=(()=>new Promise<Response>((_resolve,no)=>{reject=no})) as typeof fetch;
    await journal.writePost();h.nodes.postText.input('失败前的提交');
    const pending=journal.publishPost({disabled:false});
    ui.closeSheet();await journal.writePost();h.nodes.postText.input('后来的草稿');
    reject(new TypeError('Failed to fetch'));await pending;
    assert.equal(h.nodes.postStatus.textContent,'');assert.equal(h.nodes.postText.value,'后来的草稿');
    assert.equal(writingDraft('post','new').read().text,'后来的草稿');
  }finally{h.restore()}
});

test('a failed note save releases its pending guard and retries the retained input once',async()=>{
  const h=harness();
  try{
    let calls=0;
    globalThis.fetch=(async()=>{calls++;throw new TypeError('Failed to fetch')}) as typeof fetch;
    journal.writeDayNote();h.nodes.journalText.input('失败仍保留的笔记');
    const button={disabled:false};await journal.saveDayNote(button);
    assert.equal(button.disabled,false);assert.equal(h.nodes.journalText.value,'失败仍保留的笔记');
    await journal.saveDayNote(button);assert.equal(calls,2);assert.equal(button.disabled,false);
    assert.equal(writingDraft('journal','personal:fixture').read().text,'失败仍保留的笔记');
  }finally{h.restore()}
});
