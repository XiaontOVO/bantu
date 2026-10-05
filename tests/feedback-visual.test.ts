import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemeCardHeading } from '../public/lib/scheme-card-heading.js';
import { renderPlaces } from '../public/views/places.js';
import { state } from '../public/lib/store.js';

test('default city is displayed as scope instead of an active filter; actual filters are counted', () => {
  const previous = { placeCategory:state.placeCategory,placeCity:state.placeCity,placeQuery:state.placeQuery,placeAdvanced:state.placeAdvanced,communitySort:state.communitySort,places:state.places };
  try {
    Object.assign(state,{placeCategory:'全部',placeCity:'310100',placeQuery:'',placeAdvanced:{},communitySort:'newest',places:[]});
    assert.doesNotMatch(renderPlaces(), /项生效/); assert.match(renderPlaces(), /filter-city-label">上海/);
    state.placeAdvanced = { facilities:[], cost:'free', duration:'', rating:'' }; assert.match(renderPlaces(), /1 项生效/);
    state.communitySort = 'rating'; assert.match(renderPlaces(), /2 项生效/);
    state.placeCity = ''; assert.match(renderPlaces(), /全部城市/); assert.match(renderPlaces(), /2 项生效/);
  } finally { Object.assign(state,previous); }
});

test('archive headings separate generated metadata but preserve arbitrary user names and stored content', () => {
  const plan={name:'我的旅行方案 · 第 1 天 · 日计划 · 2026-10-01',archiveKey:'archive-1',archiveDate:'2026-10-01'};
  const before=structuredClone(plan);
  assert.deepEqual(schemeCardHeading(plan),{title:'我的旅行方案',metadata:'第 1 天 · 日计划 · 2026-10-01'});
  assert.deepEqual(plan,before);
  assert.deepEqual(schemeCardHeading({name:plan.name}),{title:plan.name,metadata:''});
  assert.deepEqual(schemeCardHeading({...plan,archiveDate:'2026-10-02'}),{title:plan.name,metadata:''});
});
