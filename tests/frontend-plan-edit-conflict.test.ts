import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const planner = await load('public/lib/plan-library.js');
const commands = await load('public/lib/commands.js');
const actions = await load('public/lib/actions.js');
const reply = (data: any) => new Response(JSON.stringify({ data }));
const stop = { stopId: 'a', placeId: 'a', place: { placeId: 'a', name: '原地点', cityCode: '310100' }, status: 'planned', startMinutes: 600, endMinutes: 660 };
async function environment(run: (plan: any, nodes: Record<string, any>) => Promise<void>) {
  const backup = { ...state }, globals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes: Record<string, any> = { sheetBackdrop: { hidden: true }, sheet: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {} },
    draftName: { value: '草稿名称' }, draftStartDate: { value: '2099-09-29' }, planStopStart: { value: '11:00' }, planStopDuration: { value: '60' }, planStopEditStatus: { textContent: '' } };
  for (const id of ['view', 'pageTitle', 'pageSubtitle', 'sidebarTrip', 'toast']) nodes[id] = { innerHTML: '', textContent: '', className: '', dataset: {} };
  globalThis.document = { activeElement: null, body: { style: {} }, getElementById: (id: string) => nodes[id] || null, querySelectorAll: () => [], querySelector: () => null } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  const plan = { id: 'day', name: '日计划', kind: 'plan', localDate: '2099-09-29', timezone: 'Asia/Shanghai', cityCode: '310100', stops: [structuredClone(stop)], routeLegs: [], plannedCharges: [], revision: 1 };
  Object.assign(state, { trip: null, principal: { principalId: 'owner' }, currentView: 'plan', savedPlans: [plan], loadStatus: {}, planEdit: null, planDraft: null, placeCatalog: [] });
  try { await run(plan, nodes); }
  finally { clearTimeout((globalThis.window as any).__toastTimer); for (const key of Object.keys(state)) if (!(key in backup)) delete state[key]; Object.assign(state, backup); Object.assign(globalThis, globals); }
}
function preview(plan: any) {
  commands.previewPlanEdit([...plan.stops, { ...stop, stopId: 'b', startMinutes: 700, endMinutes: 760 }], '添加地点', [], {
    scope: 'saved-day-plan', planId: plan.id, date: plan.localDate, expectedRevision: plan.revision, name: plan.name,
  });
}

test('adding from an outdated preview does not overwrite a newer day plan', async () => {
  await environment(async plan => {
    preview(plan); const draft = state.planEdit; let writes = 0;
    globalThis.fetch = (async (_url, options = {}) => { if (options.method) writes++; return reply([{ ...plan, revision: 2, name: '另一页的新名称' }]); }) as typeof fetch;
    await assert.rejects(commands.confirmPlanEdit(), /已有更新/);
    assert.equal(writes, 0);
    assert.equal(state.planEdit, draft);
    assert.equal(draft.stops.length, 2);
    assert.equal(draft.saving, false);
    assert.equal(state.savedPlans[0].name, '另一页的新名称');
  });
});

test('a valid add sends the preview revision and does not turn its stops into execution facts', async () => {
  await environment(async plan => {
    preview(plan); let body: any;
    globalThis.fetch = (async (_url, options = {}) => {
      if (options.method === 'PUT') { body = JSON.parse(String(options.body)); return reply({ ...plan, revision: 2 }); }
      return reply([plan]);
    }) as typeof fetch;
    await commands.confirmPlanEdit();
    assert.equal(body.expectedRevision, 1);
    assert.equal(body.snapshot.stops.length, 2);
    assert.ok(body.snapshot.stops.every((item: any) => item.status === 'planned'));
    assert.equal(body.executionEvents, undefined);
    assert.equal(state.planEdit, null);
  });
});

test('a server conflict between preflight and write keeps the add draft for review', async () => {
  await environment(async plan => {
    preview(plan); const draft = state.planEdit; let writes = 0;
    globalThis.fetch = (async (_url, options = {}) => {
      if (options.method === 'PUT') { writes++; return new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: '计划刚刚有变化' } }), { status: 409 }); }
      return reply([plan]);
    }) as typeof fetch;
    await assert.rejects(commands.confirmPlanEdit(), /计划刚刚有变化/);
    assert.equal(writes, 1);
    assert.equal(state.planEdit, draft);
    assert.equal(draft.saving, false);
  });
});

test('account changes during the preflight cannot populate or write the new account with the old plans', async () => {
  await environment(async plan => {
    preview(plan); let finish!: (value: Response) => void; let writes = 0;
    globalThis.fetch = (( _url, options = {}) => { if (options.method) writes++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
    const pending = commands.confirmPlanEdit();
    state.principal = { principalId: 'other' }; state.savedPlans = [{ id: 'other-plan' }]; state.planEdit = null;
    finish(reply([plan]));
    await assert.rejects(pending, /账号已切换/);
    assert.equal(writes, 0);
    assert.equal(state.savedPlans[0].id, 'other-plan');
  });
});

test('scheme editor binds its original revision and retains the edited draft after conflict', async () => {
  await environment(async plan => {
    Object.assign(plan, { kind: 'scheme', days: [{ dayIndex: 0, stops: [stop], routeLegs: [], plannedCharges: [] }] });
    let body: any;
    globalThis.fetch = (async (url, options = {}) => {
      if (String(url).startsWith('/api/v1/places')) return reply([]);
      body = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: '方案已有更新' } }), { status: 409 });
    }) as typeof fetch;
    planner.openPlanPlanner({ editId: plan.id }); const draft = state.planDraft;
    state.savedPlans = [{ ...plan, revision: 2 }];
    await assert.rejects(planner.savePlanDraft(), /方案已有更新/);
    assert.equal(body.expectedRevision, 1);
    assert.equal(state.planDraft, draft);
    assert.equal(draft.name, '草稿名称');
  });
});

test('a repeated save after switching editor days shares one write and retains later changes',async()=>{
  await environment(async (_plan,nodes)=>{
    const draft={ownerId:'owner',name:'首次提交',localDate:'',activeDay:0,planKind:'scheme',
      days:[{dayIndex:0,stops:[structuredClone(stop)],routeLegs:[],plannedCharges:[]},{dayIndex:1,stops:[],routeLegs:[],plannedCharges:[]}]};
    state.planDraft=draft;nodes.draftName.value=draft.name;nodes.draftStartDate.value='';
    const releases:Array<()=>void>=[],bodies:any[]=[];
    globalThis.fetch=((_url,options={})=>{
      if(options.method==='POST'){
        const body=JSON.parse(String(options.body));bodies.push(body);
        return new Promise<Response>(resolve=>releases.push(()=>resolve(reply({id:'saved-'+bodies.length,kind:'scheme',revision:1,...body}))));
      }
      return Promise.resolve(reply([]));
    }) as typeof fetch;
    const first=actions.handleAction('save-plan-draft',{disabled:false});
    await actions.handleAction('plan-draft-day',{dataset:{day:'1'}});
    nodes.draftName.value='提交后继续改名';planner.syncPlanDraftInput({id:'draftName',value:nodes.draftName.value});
    const repeat=actions.handleAction('save-plan-draft',{disabled:false});
    for(const release of releases)release();await Promise.all([first,repeat]);
    assert.equal(bodies.length,1,'the newly rendered save control must not start another create');
    assert.equal(bodies[0].name,'首次提交');assert.equal(state.planDraft,draft);
    assert.equal(draft.name,'提交后继续改名');assert.ok((draft as any).editId);
    assert.match((draft as any).saveNotice,/之后的修改仍在草稿/);
    assert.equal((draft as any).saving,false);
  });
});

test('repeat saves of identical plan content commit once and clear the draft normally',async()=>{
  await environment(async(_plan,nodes)=>{
    state.planDraft={ownerId:'owner',name:'同一份提交',localDate:'',activeDay:0,planKind:'scheme',
      days:[{dayIndex:0,stops:[structuredClone(stop)],routeLegs:[],plannedCharges:[]}]};
    const draft=state.planDraft;nodes.draftName.value=draft.name;nodes.draftStartDate.value='';
    let writes=0,release!:()=>void;
    globalThis.fetch=((_url,options={})=>{
      if(options.method==='POST'){
        writes++;return new Promise<Response>(resolve=>{release=()=>resolve(reply({id:'one-saved-scheme',kind:'scheme',revision:1}))});
      }
      return Promise.resolve(reply([]));
    }) as typeof fetch;
    const first=planner.savePlanDraft(),repeat=planner.savePlanDraft();
    release();await Promise.all([first,repeat]);
    assert.equal(writes,1);assert.equal(state.planDraft,null);assert.equal(draft.saving,false);
  });
});

test('single-stop time editor rejects a changed plan without sending old content', async () => {
  await environment(async (plan, nodes) => {
    planner.editPlanStopTime(plan.id, stop.stopId);
    state.savedPlans = [{ ...plan, revision: 2 }];
    let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch;
    await planner.savePlanStopTime();
    assert.equal(calls, 0);
    assert.match(nodes.planStopEditStatus.textContent, /计划或账号已变化/);
  });
});

test('draft save failure retains exact content and explains network recovery without hiding version errors', async () => {
  for (const networkFailure of [true,false]) await environment(async (plan,nodes) => {
    state.planDraft = { editId:plan.id,expectedRevision:1,ownerId:'owner',name:'草稿名称',localDate:plan.localDate,activeDay:0,
      days:[{dayIndex:0,stops:[structuredClone(stop)],routeLegs:[],plannedCharges:[]}] };
    const draft = state.planDraft;
    globalThis.fetch = (async () => {
      if (networkFailure) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({error:{code:'REVISION_CONFLICT',message:'这一天已被另一页修改'}}),{status:409});
    }) as typeof fetch;
    const button = { disabled:false };
    await actions.handleAction('save-plan-draft',button);
    assert.equal(state.planDraft,draft);assert.equal(button.disabled,false);
    assert.equal(draft.name,nodes.draftName.value);assert.deepEqual(draft.days[0].stops,[stop]);
    assert.equal(state.savedPlans[0].revision,1);
    assert.match(draft.saveError,networkFailure?/请检查网络后重试/:/另一页修改/);
    assert.doesNotMatch(draft.saveError,/Failed to fetch/);
  });
});

test('late catalog and route reads cannot reopen an add preview after its page or draft changes', async () => {
  for (const phase of ['plans', 'route']) {
    for (const change of ['leave', 'return', 'detail', 'draft', 'preview', 'account']) {
      await environment(async (plan, nodes) => {
        const place = { placeId: 'new', name: '新地点', cityCode: '310100', coordinates: { lat: 31.2, lng: 121.4 } };
        plan.stops[0].place.coordinates = { lat: 31.21, lng: 121.41 };
        Object.assign(state, { places: [place], currentView: 'place', placeDetailId: place.placeId, planViewDate: plan.localDate, navigationRevision: 0 });
        let release!: (response: Response) => void, entered!: () => void;
        const held = new Promise<void>(resolve => { entered = resolve; });
        let writes = 0;
        globalThis.fetch = ((url, options = {}) => {
          const route = String(url).startsWith('/api/v1/routes');
          if (options.method && !route) writes++;
          if ((phase === 'route') === route) {
            entered();
            return new Promise<Response>(resolve => { release = resolve; });
          }
          return Promise.resolve(reply([plan]));
        }) as typeof fetch;
        const pending = commands.addPlaceToPlan(place.placeId);
        await held;
        if (change === 'leave') state.currentView = 'today';
        if (change === 'return') state.navigationRevision += 2;
        if (change === 'detail') state.placeDetailId = 'another';
        if (change === 'draft') state.planDraft = { name: '刚写的草稿', dailyPlanDate: plan.localDate, days: [{ stops: [] }] };
        if (change === 'preview') state.planEdit = { name: '新的待确认操作' };
        if (change === 'account') state.principal = { principalId: 'other' };
        const draft = state.planDraft, preview = state.planEdit;
        release(phase === 'plans' ? reply([plan]) : reply({ leg: { durationSeconds: 600, transportMode: 'walking' }, departureSupport: 'online' }));
        await pending;
        assert.equal(writes, 0, `${phase}/${change} must not save a plan`);
        assert.equal(state.planDraft, draft, `${phase}/${change} keeps the current draft`);
        assert.equal(state.planEdit, preview, `${phase}/${change} keeps the current confirmation`);
        assert.equal(nodes.sheetBackdrop.hidden, true, `${phase}/${change} must not open a late sheet`);
      });
    }
  }
});

test('staying on the source page keeps add confirmation with a Chinese route failure and the original plan intact', async () => {
  await environment(async (plan, nodes) => {
    const place = { placeId: 'new', name: '新地点', cityCode: '310100', coordinates: { lat: 31.2, lng: 121.4 } };
    plan.stops[0].place.coordinates = { lat: 31.21, lng: 121.41 };
    Object.assign(state, { places: [place], currentView: 'place', placeDetailId: place.placeId, planViewDate: plan.localDate });
    let writes = 0;
    globalThis.fetch = (async (url, options = {}) => {
      if (String(url).startsWith('/api/v1/routes')) throw new TypeError('Failed to fetch');
      if (options.method) writes++;
      return reply([plan]);
    }) as typeof fetch;
    await commands.addPlaceToPlan(place.placeId);
    assert.equal(nodes.sheetBackdrop.hidden, false);
    assert.equal(state.planEdit.stops.length, 2); assert.equal(writes, 0);
    assert.equal(state.planEdit.planId, plan.id); assert.equal(state.planEdit.expectedRevision, 1);
    assert.match(nodes.sheet.innerHTML, /路线服务连接失败/);
    assert.doesNotMatch(nodes.sheet.innerHTML, /Failed to fetch/);
    assert.equal(state.savedPlans[0].stops.length, 1);
  });
});

test('a changed carry destination blocks source writes and keeps a persistent explanation in the confirmation', async()=>{
  await environment(async(plan,nodes)=>{
    const next={...plan,id:'next',localDate:'2099-09-30',revision:2};
    nodes.planAddStatus={hidden:true,textContent:'',scrollIntoView(){},focus(){}};
    commands.previewPlanEdit([...plan.stops,{...stop,stopId:'added',startMinutes:2100,endMinutes:2160}], '接续次日',[],{
      scope:'saved-day-plan',planId:plan.id,date:plan.localDate,expectedRevision:plan.revision,name:plan.name,
      carryTarget:{date:next.localDate,dayOffset:1,plan:next,expected:{localDate:next.localDate,planId:next.id,expectedRevision:1}},
    });
    const draft=state.planEdit;let writes=0;
    globalThis.fetch=(async(_url,options={})=>{if(options.method)writes++;return reply([plan,next]);}) as typeof fetch;
    await assert.rejects(commands.confirmPlanEdit(),/接续日期的计划已有变化/);
    assert.equal(writes,0);assert.equal(state.planEdit,draft);assert.equal(nodes.planAddStatus.hidden,false);
    assert.match(nodes.planAddStatus.textContent,/本次地点尚未保存/);
    assert.equal(nodes.sheetBackdrop.hidden,false);
  });
});
