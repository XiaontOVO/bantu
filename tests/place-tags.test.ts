import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customTagNames, officialTagIds, placeTags } from '../src/domain/place-tags.js';
import { CommunityService, communityPlaceProvider } from '../src/services/community-service.js';
import { DemoPlaceProvider } from '../src/providers/travel.js';

test('official tag vocabulary is validated and user labels stay user labels', () => {
  assert.throws(() => officialTagIds(['invented_official_tag']));
  assert.throws(() => customTagNames(Array(9).fill('标签')));
  assert.throws(() => customTagNames([' ']));
  assert.deepEqual(customTagNames([' 安静 ', '安静']), ['安静']);
  assert.deepEqual(placeTags({ category: 'culture', facilityCodes: ['indoor'], customTags: ['平台认证'] }).map(tag => [tag.label, tag.source]), [['文化展览', 'official'], ['室内', 'official'], ['平台认证', 'user']]);
});

test('legacy community data loads; shared provider supports official and custom tag search', async () => {
  const service = new CommunityService(); service.loadSerialized('[]');
  const provider = communityPlaceProvider(new DemoPlaceProvider(), service);
  const indoor = await provider.search({ cityCode: '310100', tag: 'indoor' });
  assert.ok(indoor.places.length > 1);
  assert.ok(indoor.places.every(place => placeTags(place).some(tag => tag.id === 'indoor')));
  assert.equal((await provider.search({ cityCode: '310100', tag: 'indoor', limit: 1 })).places.length, 1);
  const culture = await provider.search({ cityCode: '310100', query: '文化展览' });
  assert.equal(culture.places[0].placeId, '12143803119501', '文化标签首条为徐家汇书院');
  service.saveTags('12143603120601', 'a', ['日落绝美']);
  service.saveTags('12143603120601', 'b', ['日落绝美']);
  service.saveTags('12143603120601', 'a', []);
  assert.deepEqual(service.myTags('12143603120601', 'b'), ['日落绝美']);
  const bSearch = await provider.search({ cityCode: '310100', query: '日落绝美', actorId: 'b' });
  assert.equal(bSearch.places[0]?.placeId, '12143603120601', 'custom tags are searchable by the account that added them');
  const aSearch = await provider.search({ cityCode: '310100', query: '日落绝美', actorId: 'a' });
  assert.equal(aSearch.places.length, 0, 'cleared tags must not remain visible to their former owner');
});
