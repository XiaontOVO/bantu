import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommunityService } from '../src/services/community-service.js';

test('travel posts preserve note text, survive restore and allow only author withdrawal', () => {
  const service = new CommunityService();
  const text = '西湖的一天\n今天走得很慢，但很开心。';
  const post = service.publishPost('author', {nickname:'旅人', text});
  assert.equal(service.listPosts('reader')[0].text, text);
  assert.equal(service.listPosts('reader')[0].mine, false);
  assert.equal('authorId' in service.listPosts('reader')[0], false);
  assert.throws(() => service.removePost('reader', post.id));
  const restored = new CommunityService(); restored.loadSerialized(service.serialize());
  assert.equal(restored.listPosts('author')[0].mine, true);
  assert.equal(restored.listPosts('author')[0].text, text);
  restored.removePost('author', post.id);
  assert.deepEqual(restored.listPosts('reader'), []);
  assert.throws(() => service.publishPost('author', {nickname:'', text}));
  assert.throws(() => service.publishPost('author', {nickname:'旅人', text:' '}));
  restored.loadSerialized('[]'); assert.deepEqual(restored.listPosts('reader'), []);
});
