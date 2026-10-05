import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_SHANGHAI_PLACES } from '../src/demo/demo-data.js';
import { hasUsablePlaceImpression, illustratedPlaceProvider } from '../src/providers/illustrated-places.js';
test('real mapped artwork admits demo places without an explicit image field, and rejects placeholders or missing files',()=>{
  assert.ok(DEMO_SHANGHAI_PLACES.every(place=>hasUsablePlaceImpression(place)));
  const base={...DEMO_SHANGHAI_PLACES[0],name:'Unillustrated unknown place',impressionImage:undefined};
  assert.equal(hasUsablePlaceImpression(base),false);
  assert.equal(hasUsablePlaceImpression({...base,impressionImage:'/images/places/missing.png'}),false);
  assert.equal(hasUsablePlaceImpression({...base,impressionImage:'/images/places/../../package.json'}),false);
});
test('illustrated catalogue pages skip missing artwork without losing eligible items or accepting detail access',async()=>{
  const valid=DEMO_SHANGHAI_PLACES.slice(0,3),missing={...valid[0],placeId:'missing',name:'No artwork',impressionImage:undefined};const records=[missing,valid[0],missing,valid[1],valid[2]];
  const provider=illustratedPlaceProvider({providerName:'fixture',async search(input){const offset=input.offset||0,end=offset+(input.limit||12);return {places:records.slice(offset,end),empty:false,nextCursor:end<records.length?end:null};},async detail(id){return records.find(place=>place.placeId===id)||null;}});
  const first=await provider.search({cityCode:'',limit:2});assert.deepEqual(first.places.map(p=>p.placeId),valid.slice(0,2).map(p=>p.placeId));assert.equal(first.nextCursor,4);
  const second=await provider.search({cityCode:'',limit:2,offset:first.nextCursor!});assert.deepEqual(second.places.map(p=>p.placeId),[valid[2].placeId]);assert.equal(await provider.detail('missing'),null);
});
