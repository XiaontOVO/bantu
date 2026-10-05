import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

async function reviewFixture(load:(state:any)=>Promise<void>) {
  const source=(await readFile('public/lib/journey-review.js','utf8')).replace(/^import[^\n]+\n/gm,'').replace('export async function','async function');
  const state:any={principal:{principalId:'owner'},navigationRevision:1,memories:[],agentDockOpen:true};
  const navigations:any[]=[];let reads=0;
  const open=new Function('state','loadAllMemories','navigate','render',source+'\nreturn openJourneyReview;')(state,async()=>{reads++;await load(state)},async(view:string)=>{navigations.push(view);state.currentView=view;state.navigationRevision++},()=>{});
  return {state,open,navigations,reads:()=>reads};
}

test('journey review focuses the record for this plan, without selecting newer unrelated notes',async()=>{
  const fixture=await reviewFixture(async state=>{state.memories=[{memoryId:'other',sourcePlanId:'another',journey:{}},{memoryId:'this-record',sourcePlanId:'this-plan',journey:{}}]});
  await fixture.open('this-plan');
  assert.deepEqual(fixture.navigations,['memories']);assert.equal(fixture.state.agentResultTarget.id,'this-record');
  assert.equal(fixture.state.agentDockOpen,false);assert.equal(fixture.state.journeyReviewPending,null);
});

test('a delayed journey read cannot navigate after account or page changes; repeat taps do not duplicate work',async()=>{
  for(const change of ['account','navigation']) {
    let release!:()=>void;const deferred=new Promise<void>(resolve=>{release=resolve});
    const fixture=await reviewFixture(async state=>{await deferred;state.memories=[{memoryId:'record',sourcePlanId:'plan',journey:{}}]});
    const request=fixture.open('plan');await fixture.open('plan');assert.equal(fixture.reads(),1);
    if(change==='account')fixture.state.principal={principalId:'new-owner'};else fixture.state.navigationRevision++;
    release();await request;assert.deepEqual(fixture.navigations,[]);assert.equal(fixture.state.agentResultTarget,undefined);
  }
});

test('missing or failed journey reads preserve the page and clear the waiting state for retry',async()=>{
  for(const failure of ['missing','network']) {
    const fixture=await reviewFixture(async()=>{if(failure==='network')throw new Error('网络失败')});
    await assert.rejects(fixture.open('plan'),failure==='missing'?/暂时不可用/:/网络失败/);
    assert.equal(fixture.state.journeyReviewPending,null);assert.deepEqual(fixture.navigations,[]);
  }
});
