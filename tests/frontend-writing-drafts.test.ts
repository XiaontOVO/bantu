import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const moduleUrl = (name: string) => pathToFileURL(join(process.cwd(), 'public/lib', name)).href;
const { state } = await import(moduleUrl('store.js'));
const { writingDraft } = await import(moduleUrl('writing-drafts.js'));

test('a failed update cannot restore an older persisted writing draft over the current in-memory input', () => {
  const previous = { storage:globalThis.sessionStorage, principal:state.principal };
  const values = new Map<string,string>();
  let fail = false;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{
    getItem:(key:string)=>values.get(key)||null,
    setItem:(key:string,value:string)=>{if(fail)throw new Error('quota unavailable');values.set(key,value)},
    removeItem:(key:string)=>values.delete(key),
  }});
  state.principal = {principalId:'writing-storage-failure'};
  try {
    const draft = writingDraft('time-test','retained');
    assert.equal(draft.save({startMinutes:870,durationMinutes:90}),true);
    fail = true;
    assert.equal(draft.save({startMinutes:1050,durationMinutes:60}),false);
    assert.deepEqual(writingDraft('time-test','retained').read(),{startMinutes:1050,durationMinutes:60});
    state.principal = {principalId:'another-writing-owner'};
    assert.equal(writingDraft('time-test','retained').read(),null);
  } finally {
    state.principal=previous.principal;
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:previous.storage});
  }
});

test('failed draft cleanup cannot resurrect the just-saved text in the current page', () => {
  const previous = { storage:globalThis.sessionStorage, principal:state.principal };
  const values = new Map<string,string>();
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{
    getItem:(key:string)=>values.get(key)||null,
    setItem:(key:string,value:string)=>values.set(key,value),
    removeItem:()=>{throw new Error('storage removal unavailable')},
  }});
  state.principal={principalId:'writing-cleanup-failure'};
  try {
    const draft=writingDraft('note-test','saved'),submitted={text:'已经保存的内容'};
    draft.save(submitted);draft.clearIf(submitted);
    assert.equal(writingDraft('note-test','saved').read(),null);
    draft.save({text:'新的未提交内容'});draft.clearIf(submitted);
    assert.deepEqual(draft.read(),{text:'新的未提交内容'});
  } finally {
    state.principal=previous.principal;
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:previous.storage});
  }
});
